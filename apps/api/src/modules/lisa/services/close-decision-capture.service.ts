/**
 * CloseDecisionCaptureService — apprentissage des décisions de fermeture.
 *
 * 2 responsabilités :
 *   1. captureClose() — appelé à chaque close (user manuel + mécanique). Snapshot
 *      le contexte complet (pnl, mfe/mae, give-back, indicateurs, momentum,
 *      distance TP/SL, marché) dans position_close_decisions. Fire-and-forget
 *      (ne bloque jamais le close).
 *   2. labelCounterfactuals() — cron 15min. Pour les closes > 60min sans verdict,
 *      regarde CE QUE LE PRIX A FAIT après le close et labellise :
 *        GOOD  = bien sorti (prix n'a pas dépassé le TP qu'on visait, ou a chuté)
 *        EARLY = sorti trop tôt (prix a continué vers le TP après le close)
 *        OK    = neutre
 *
 * Transforme "l'user a fermé ici" → "l'user a fermé ici ET c'était GOOD/EARLY".
 * TRADER apprend QUAND sortir, pas juste à copier l'humain (idée user 03/06).
 *
 * Gating : CLOSE_DECISION_CAPTURE_ENABLED (default true — append-only, sans
 * effet sur le trading, juste de la collecte).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { BinanceMarketService } from './binance-market.service';
import { computeIndicatorSnapshot, type IndicatorCandle } from './position-indicators.helper';

export interface CloseDecisionInput {
  positionId: string;
  portfolioId: string;
  symbol: string;
  direction: string;
  assetClass?: string | null;
  closerType: 'user_manual' | 'closed_choppy' | 'closed_stop' | 'closed_target' | 'orphan_close' | 'risk_monitor' | 'other';
  entryPrice: number;
  exitPrice: number;
  pnlPct: number | null;
  pnlUsd: number | null;
  ageMinutes: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  // 07/06 — Imitation learning étendu : contexte + échéance (J+10 oversold) pour
  // le contrefactuel à horizon long + cause→effet news.
  context?: 'danger_zone' | 'oversold_early' | 'manual_other';
  wasManualControl?: boolean | null;
  deadlineAt?: string | null; // ISO échéance initiale (J+10 oversold), null sinon
}

@Injectable()
export class CloseDecisionCaptureService {
  private readonly logger = new Logger(CloseDecisionCaptureService.name);
  private enabled = true;
  private labelerEnabled = true;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly intraday: IntradayProviderRouter,
    private readonly binance: BinanceMarketService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('CLOSE_DECISION_CAPTURE_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.labelerEnabled = (this.config.get<string>('CLOSE_DECISION_LABELER_ENABLED') ?? 'true').toLowerCase() === 'true';
  }

  /**
   * Capture le contexte d'un close. Fire-and-forget : ne JAMAIS await dans le
   * chemin critique du close (l'user veut un close instantané). Best-effort.
   */
  captureClose(input: CloseDecisionInput): void {
    if (!this.enabled) return;
    void this.doCapture(input).catch((e) =>
      this.logger.debug(`[close-capture] ${input.symbol} skip: ${String(e).slice(0, 150)}`),
    );
  }

  private async fetchCandles(symbol: string, assetClass?: string | null): Promise<IndicatorCandle[]> {
    if ((assetClass ?? '').startsWith('crypto')) {
      const bin = this.binance.toBinanceSymbol(symbol);
      if (!bin) return [];
      const k = await this.binance.getKlines(bin, '5m', 60).catch(() => null);
      return k ? k.map((c) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume })) : [];
    }
    const s = await this.intraday.getCandles(symbol, '5m', 60, { calledBy: 'close_capture' }).catch(() => null);
    return s?.candles?.length
      ? s.candles.map((c: { high: number; low: number; close: number; volume: number }) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume }))
      : [];
  }

  private async doCapture(input: CloseDecisionInput): Promise<void> {
    const { entryPrice: entry, exitPrice: exit, pnlPct } = input;
    const sign = input.direction === 'short' ? -1 : 1;

    // MFE/MAE depuis le tracker (précis) sinon fallback pnl courant
    const { data: snap } = await this.supabase.getClient()
      .from('position_indicators_snapshot')
      .select('mfe_pct, mae_pct')
      .eq('position_id', input.positionId)
      .order('captured_at', { ascending: false })
      .limit(1).maybeSingle();
    const mfePct = (snap?.mfe_pct as number | null) ?? pnlPct;
    const maePct = (snap?.mae_pct as number | null) ?? pnlPct;
    const giveBack = mfePct !== null && pnlPct !== null ? mfePct - pnlPct : null;

    // Indicateurs + trend 5m au close (candles best-effort)
    const candles = await this.fetchCandles(input.symbol, input.assetClass);
    const ind = candles.length >= 15 ? computeIndicatorSnapshot(candles) : null;
    let trend5m: number | null = null;
    if (candles.length >= 2) {
      const last = candles[candles.length - 1].close;
      const prev = candles[candles.length - 2].close; // 5m avant (candle 5m)
      if (prev > 0) trend5m = ((last - prev) / prev) * 100;
    }

    const tp = input.takeProfitPrice ?? null;
    const sl = input.stopLossPrice ?? null;
    const distTp = tp !== null && exit > 0 ? ((tp - exit) / exit) * 100 * sign : null;
    const distSl = sl !== null && exit > 0 ? ((exit - sl) / exit) * 100 * sign : null;

    // 07/06 — Échéance (oversold J+10) + news cause→effet pour le contrefactuel long.
    const deadlineAt = input.deadlineAt ?? null;
    const hoursToDeadline = deadlineAt ? (new Date(deadlineAt).getTime() - Date.now()) / 3600_000 : null;
    const news = await this.fetchNewsSnapshot(input.symbol).catch(
      () => ({ count: 0, minSentiment: null as number | null, snapshot: [] as unknown[] }),
    );

    const { error } = await this.supabase.getClient()
      .from('position_close_decisions')
      .insert({
        position_id: input.positionId,
        portfolio_id: input.portfolioId,
        symbol: input.symbol,
        direction: input.direction,
        asset_class: input.assetClass ?? null,
        closer_type: input.closerType,
        entry_price: entry,
        exit_price: exit,
        pnl_pct: pnlPct,
        pnl_usd: input.pnlUsd,
        age_minutes: round2(input.ageMinutes),
        mfe_pct: mfePct !== null ? round2(mfePct) : null,
        mae_pct: maePct !== null ? round2(maePct) : null,
        give_back_from_mfe: giveBack !== null ? round2(giveBack) : null,
        trend_5m_pct: trend5m !== null ? round2(trend5m) : null,
        momentum_gradient: ind?.roc5 ?? null,
        roc5: ind?.roc5 ?? null,
        rsi14: ind?.rsi14 ?? null,
        stoch_rsi_k: ind?.stoch_rsi_k ?? null,
        macd_hist: ind?.macd_hist ?? null,
        bb_pct_b: ind?.bb_pct_b ?? null,
        adx14: ind?.adx14 ?? null,
        atr14_pct: ind?.atr14_pct ?? null,
        dist_to_tp_pct: distTp !== null ? round2(distTp) : null,
        dist_to_sl_pct: distSl !== null ? round2(distSl) : null,
        take_profit_price: tp,
        stop_loss_price: sl,
        context: input.context ?? (input.closerType === 'user_manual' ? 'manual_other' : null),
        was_manual_control: input.wasManualControl ?? null,
        deadline_at: deadlineAt,
        hours_to_deadline: hoursToDeadline !== null ? round2(hoursToDeadline) : null,
        news_count: news.count,
        news_min_sentiment: news.minSentiment,
        news_snapshot: news.snapshot,
        raw_payload: { candle_count: candles.length },
      });
    if (error) this.logger.debug(`[close-capture] insert ${input.symbol}: ${error.message}`);
  }

  /**
   * Cron 15min — labellise le counterfactuel des closes > 60min sans verdict.
   * Regarde le prix dans les 60min APRÈS le close → GOOD / EARLY / OK.
   */
  @Cron('0 */15 * * * *', { name: 'close-decision-labeler', timeZone: 'UTC' })
  async labelCounterfactuals(): Promise<void> {
    if (!this.labelerEnabled || !this.supabase.isReady()) return;
    try {
      // Closes entre 60min et 24h, pas encore labellisés
      const from = new Date(Date.now() - 24 * 3600_000).toISOString();
      const to = new Date(Date.now() - 60 * 60_000).toISOString();
      const { data: rows } = await this.supabase.getClient()
        .from('position_close_decisions')
        .select('id, symbol, asset_class, direction, exit_price, closed_at, take_profit_price, entry_price, raw_payload')
        .is('verdict', null)
        .gte('closed_at', from).lte('closed_at', to)
        .limit(50);
      if (!rows || rows.length === 0) return;

      let labeled = 0;
      for (const r of rows) {
        const v = await this.labelOne(r).catch(() => null);
        if (v) labeled++;
      }
      if (labeled > 0) this.logger.log(`[close-labeler] labellisé ${labeled}/${rows.length} closes`);
    } catch (e) {
      this.logger.warn(`[close-labeler] cycle: ${String(e).slice(0, 150)}`);
    }
  }

  private async labelOne(r: Record<string, unknown>): Promise<boolean> {
    const symbol = String(r.symbol);
    const exit = Number(r.exit_price);
    const entry = Number(r.entry_price);
    const closedAt = new Date(String(r.closed_at)).getTime();
    const sign = String(r.direction) === 'short' ? -1 : 1;
    if (!(exit > 0)) return false;

    // Fix 04/06/2026 — Retire le guard `candles.filter(...).length` qui short-circuitait
    // postCloseCandles dès que fetchCandles (60 candles) renvoyait vide. Cas EZJ.LSE
    // 03/06 : fetchCandles vide (raison inconnue) → post=[] → verdict 'OK' permanent
    // avec label_reason='no_post_data' alors que LSE avait 39min de post-data dispo.
    // On essaie TOUJOURS postCloseCandles directement.
    const post = await this.postCloseCandles(symbol, r.asset_class as string | null, closedAt);
    if (post.length === 0) {
      // Fix 04/06/2026 — Retry up to 3 fois (~45min entre tentatives) avant marquer
      // verdict='OK' permanent. Évite de fermer définitivement un label quand le
      // provider intraday a juste un trou ponctuel.
      const existingPayload = (r.raw_payload ?? {}) as Record<string, unknown>;
      const attempts = Number(existingPayload.label_attempts ?? 0) + 1;
      if (attempts < 3) {
        // Retry plus tard : pas de verdict définitif, juste increment counter
        await this.supabase.getClient().from('position_close_decisions')
          .update({ raw_payload: { ...existingPayload, label_attempts: attempts, last_attempt_at: new Date().toISOString() } })
          .eq('id', String(r.id));
        return false;
      }
      // 3 attempts → on abandonne et on marque OK définitivement
      await this.supabase.getClient().from('position_close_decisions')
        .update({ verdict: 'OK', labeled_at: new Date().toISOString(), raw_payload: { ...existingPayload, label_reason: 'no_post_data', label_attempts: attempts } })
        .eq('id', String(r.id));
      return true;
    }

    const window60 = post.filter((c) => c.ts <= closedAt + 60 * 60_000);
    const maxFav = Math.max(...window60.map((c) => c.high));
    const maxAdv = Math.min(...window60.map((c) => c.low));
    const maxFavPct = ((maxFav - exit) / exit) * 100 * sign;
    const maxAdvPct = ((exit - maxAdv) / exit) * 100 * sign * -1; // négatif si adverse
    const price30 = window60.find((c) => c.ts >= closedAt + 30 * 60_000)?.close ?? null;
    const price60 = window60[window60.length - 1]?.close ?? null;

    // Verdict : EARLY si le prix a continué favorablement ≥ +1% après le close
    // (on a laissé de l'argent). GOOD si le prix a chuté ≥ -0.5% (bien sorti).
    // OK sinon.
    let verdict: 'GOOD' | 'EARLY' | 'OK';
    if (maxFavPct >= 1.0) verdict = 'EARLY';
    else if (maxAdvPct <= -0.5) verdict = 'GOOD';
    else verdict = 'OK';

    await this.supabase.getClient().from('position_close_decisions')
      .update({
        price_after_30m: price30,
        price_after_60m: price60,
        max_favorable_after_60m_pct: round2(maxFavPct),
        max_adverse_after_60m_pct: round2(maxAdvPct),
        verdict,
        labeled_at: new Date().toISOString(),
      })
      .eq('id', String(r.id));
    return true;
  }

  /** Candles APRÈS un timestamp donné (pour le counterfactuel). */
  private async postCloseCandles(symbol: string, assetClass: string | null, afterTs: number): Promise<Array<{ ts: number; high: number; low: number; close: number }>> {
    if ((assetClass ?? '').startsWith('crypto')) {
      const bin = this.binance.toBinanceSymbol(symbol);
      if (!bin) return [];
      const k = await this.binance.getKlines(bin, '5m', 30).catch(() => null);
      return k ? k.map((c) => ({ ts: c.openTime, high: c.high, low: c.low, close: c.close })).filter((c) => c.ts > afterTs) : [];
    }
    const s = await this.intraday.getCandles(symbol, '5m', 30, { calledBy: 'close_label' }).catch(() => null);
    return s?.candles?.length
      ? s.candles.map((c: { timestamp: number; high: number; low: number; close: number }) => ({ ts: c.timestamp * 1000, high: c.high, low: c.low, close: c.close })).filter((c) => c.ts > afterTs)
      : [];
  }

  // ─────────────────────────────────────────────────────────────────
  // 07/06 — Imitation learning étendu : news cause→effet + contrefactuel J+10
  // ─────────────────────────────────────────────────────────────────

  /** Snapshot des news persistées [close-72h, close] pour la causalité du close. */
  private async fetchNewsSnapshot(
    symbol: string,
  ): Promise<{ count: number; minSentiment: number | null; snapshot: Array<{ title: string; sentiment: number | null; ageHours: number; source: string | null }> }> {
    const now = Date.now();
    const from = new Date(now - 72 * 3600_000).toISOString();
    const { data } = await this.supabase.getClient()
      .from('eodhd_news_articles')
      .select('title, sentiment_polarity, source_url, published_at')
      .eq('ticker', symbol)
      .gte('published_at', from)
      .lte('published_at', new Date(now).toISOString())
      .order('published_at', { ascending: false })
      .limit(50);
    const rows = (data ?? []) as Array<{ title?: string; sentiment_polarity?: number | null; source_url?: string | null; published_at?: string }>;
    let minSent: number | null = null;
    for (const r of rows) {
      const s = typeof r.sentiment_polarity === 'number' ? r.sentiment_polarity : null;
      if (s != null && (minSent === null || s < minSent)) minSent = s;
    }
    const snapshot = rows.slice(0, 5).map((r) => ({
      title: (r.title ?? '').slice(0, 200),
      sentiment: typeof r.sentiment_polarity === 'number' ? r.sentiment_polarity : null,
      ageHours: r.published_at ? round2((now - new Date(r.published_at).getTime()) / 3600_000) : 0,
      source: r.source_url ?? null,
    }));
    return { count: rows.length, minSentiment: minSent, snapshot };
  }

  /**
   * Cron quotidien — contrefactuel à l'échéance (J+10 oversold). Pour les closes
   * avec deadline_at atteinte et pas encore labellisés : compare "tenir jusqu'à
   * l'échéance" vs "le close réel". Verdict CLOSE_BETTER / HELD_BETTER / NEUTRAL.
   */
  @Cron('0 30 22 * * *', { name: 'close-decision-deadline-labeler', timeZone: 'UTC' })
  async labelDeadlineCounterfactuals(): Promise<void> {
    if (!this.labelerEnabled || !this.supabase.isReady()) return;
    try {
      const { data: rows } = await this.supabase.getClient()
        .from('position_close_decisions')
        .select('id, symbol, direction, entry_price, exit_price, pnl_pct, closed_at, deadline_at')
        .not('deadline_at', 'is', null)
        .is('deadline_verdict', null)
        .lte('deadline_at', new Date().toISOString())
        .limit(50);
      if (!rows || rows.length === 0) return;
      let labeled = 0;
      for (const r of rows) {
        if (await this.labelDeadlineOne(r as Record<string, unknown>).catch(() => false)) labeled++;
      }
      if (labeled > 0) this.logger.log(`[close-deadline-labeler] ${labeled}/${rows.length} closes labellisés à l'échéance`);
    } catch (e) {
      this.logger.warn(`[close-deadline-labeler] ${String(e).slice(0, 150)}`);
    }
  }

  private async labelDeadlineOne(r: Record<string, unknown>): Promise<boolean> {
    const symbol = String(r.symbol);
    const entry = Number(r.entry_price);
    const pnlAtClose = r.pnl_pct != null ? Number(r.pnl_pct) : null;
    const sign = String(r.direction) === 'short' ? -1 : 1;
    const closedAt = new Date(String(r.closed_at));
    if (!(entry > 0)) {
      await this.markDeadlineNoData(String(r.id));
      return true;
    }
    const closes = await this.fetchDailyCloses(symbol, closedAt).catch(() => [] as Array<{ date: string; close: number }>);
    if (closes.length === 0) {
      await this.markDeadlineNoData(String(r.id));
      return true;
    }
    // closes ascendant à partir de J+1 ouvré ; J+N = N-ème close.
    const pick = (n: number): number | null => (closes[n - 1] ? closes[n - 1].close : null);
    const pJ10 = pick(10) ?? closes[closes.length - 1].close;
    const pnlIfHeld = pJ10 != null && entry > 0 ? ((pJ10 - entry) / entry) * 100 * sign : null;
    let verdict: 'CLOSE_BETTER' | 'HELD_BETTER' | 'NEUTRAL' = 'NEUTRAL';
    if (pnlIfHeld != null && pnlAtClose != null) {
      if (pnlIfHeld > pnlAtClose + 0.5) verdict = 'HELD_BETTER'; // tenir aurait mieux valu → close prématuré
      else if (pnlIfHeld < pnlAtClose - 0.5) verdict = 'CLOSE_BETTER'; // bien fermé
    }
    await this.supabase.getClient().from('position_close_decisions').update({
      price_j1: pick(1),
      price_j3: pick(3),
      price_j5: pick(5),
      price_j10: pJ10,
      pnl_if_held_to_deadline_pct: pnlIfHeld != null ? round2(pnlIfHeld) : null,
      deadline_verdict: verdict,
      deadline_labeled_at: new Date().toISOString(),
    }).eq('id', String(r.id));
    return true;
  }

  private async markDeadlineNoData(id: string): Promise<void> {
    await this.supabase.getClient().from('position_close_decisions')
      .update({ deadline_verdict: 'NEUTRAL', deadline_labeled_at: new Date().toISOString() })
      .eq('id', id)
      .then(() => undefined, () => undefined);
  }

  /** Closes EOD quotidiens depuis J+1 (EODHD eod, ascendant). Equities uniquement. */
  private async fetchDailyCloses(symbol: string, afterDate: Date): Promise<Array<{ date: string; close: number }>> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return [];
    const from = new Date(afterDate.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
    const url = `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?api_token=${apiKey}&fmt=json&from=${from}&order=a&period=d`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];
      const j = (await res.json()) as Array<{ date?: string; close?: number }>;
      return (Array.isArray(j) ? j : [])
        .filter((b) => b && typeof b.close === 'number' && b.date)
        .map((b) => ({ date: b.date as string, close: b.close as number }));
    } finally {
      clearTimeout(timer);
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
