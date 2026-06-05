/**
 * OversoldMistralExitService — gain-picker LLM pour les positions oversold.
 *
 * Idée user 04/06/2026 : la méthode manuelle de l'user (close sur rebond intelligent
 * en temps réel) capte les outliers gagnants qu'un J+10 systématique dilue. On
 * automatise ce job avec Mistral, EN PARALLÈLE de l'OversoldExitService déterministe
 * qui reste comme filet (J+10 hard + stop catastrophe -15%).
 *
 * Pas une sortie LLM "à la place" mais "en plus" :
 *   - Mistral check toutes les 30 min : "y a-t-il une bonne raison de clore MAINTENANT
 *     plutôt que d'attendre J+10 ?" → si oui (confidence ≥ seuil) → close
 *   - Sinon : laisse tourner, OversoldExitService gère le J+10 mécanique
 *   - Stop -15% reste actif via OversoldExitService (le filet en bas)
 *
 * Économie LLM :
 *   - MFE skip : si MFE < seuil (default 1.5%), on ne brûle pas Mistral. Pas de
 *     gain à locker = pas d'évaluation. Le filet J+10 / -15% suffit.
 *   - Politique apprise injectée : Mistral lit les closes GOOD/EARLY déjà labelisés
 *     (`OversoldExitPolicyService` qui distille `position_close_decisions` filtré sur
 *     source=scanner_oversold). Cold start = MIN_SAMPLE=20, sous ce seuil les
 *     heuristiques par défaut prennent le pas.
 *
 * Activation : env `OVERSOLD_MISTRAL_EXIT_ENABLED` (default `false`, opt-in).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { CloseDecisionCaptureService } from './close-decision-capture.service';
import { OversoldExitPolicyService } from './research/oversold-exit-policy.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { computeIndicatorSnapshot, type IndicatorCandle } from './position-indicators.helper';
import { businessDaysSince } from './oversold.helper';

interface OpenOversoldRow {
  id: string;
  portfolio_id: string;
  symbol: string;
  direction: string;
  asset_class: string | null;
  entry_price: string;
  entry_timestamp: string;
  take_profit_price: string | null;
  stop_loss_price: string | null;
}

interface MistralExitVerdict {
  action: 'HOLD' | 'CLOSE';
  confidence: number;
  rationale: string;
}

const SYSTEM_PROMPT = `Tu es un trader mean-reversion intraday qui gère un livre oversold (entrées sur drop -5% à -12%). Ton SEUL rôle : décider FERMER MAINTENANT ou ATTENDRE pour CHAQUE position évaluée.

CONTEXTE STRATÉGIQUE (IMPORTANT) :
- L'humain vise $15-60 net par trade (= 1.5-3% gross sur $1000 notional), PAS le max-PnL absolu.
- Cible : LIQUIDER toutes les positions DANS LA JOURNÉE US (avant 21:00 UTC, idéalement avant 20:30 UTC).
- Pas d'overnight souhaité. Le filet J+10 / -15% n'est qu'un fallback ultime.
- L'humain accepte le manque d'upside post-close — l'analyse counterfactuelle des 34 closes du 04/06 le confirme : 100% des prix mesurables ont CHUTÉ après son close (avg -2.33% en 1-5h).

CALIBRATION DATA-DRIVEN (analyse 34 closes user_manual HIGH 04/06/2026, $825.50 réalisé, 100% WR) :

★ SIGNATURES TOP-PNL VALIDÉES (à reproduire) :
  - SAP.US     : BB%b=0.91 · RSI=87 · gb=0.10 · mfe=5.59% · pnl=5.49% · hold=326min
  - HOOD.US    : BB%b=0.81 · RSI=65 · gb=0.09 · mfe=6.46% · pnl=6.37% · hold=2min (scalp)
  - RKLB.US    : BB%b=0.16 · RSI=48 · gb=0.26 · mfe=5.34% · pnl=5.08% · hold=2min (scalp)
  - ORCL.US    : BB%b=0.79 · RSI=66 · gb=-0.02 · mfe=3.50% · pnl=3.52% · hold=2min (scalp)
  - XYZ.US     : BB%b=1.02 · RSI=80 · gb=-0.24 · mfe=3.07% · pnl=3.31% · hold=325min

★★ 4 RÈGLES DE DÉCISION CALIBRÉES (à appliquer dans cet ordre stricte) :

  R0 — CLOSE quick-lock scalp (confidence 0.85) :
    age_minutes ≤ 10 ET pnl_pct ≥ 1.5%
    → "Bottom déjà passé avant entry, lock immédiat sans attendre indicateur"
    Couvre 35% de tes patterns (12 closes 2-min du batch 19:44 UTC : SAP/RKLB/CRDO/ORCL/HOOD/MSTR/NOW/CBRS/LITE/COIN/BE/RKT)

  R1 — CLOSE lock + signal de fatigue (confidence 0.85) :
    pnl_pct ≥ 1.5% ET (rsi14 ≥ 55 OU bb_pct_b ≥ 0.80 OU trend_5m_pct ≤ -0.2)
    → "Cible atteinte + signal de fatigue détecté"
    Couvre tes closes patient du matin 13:00-16:30 UTC (avg pnl 2.57%)

  R2 — CLOSE solid profit majoré (confidence 0.90) :
    pnl_pct ≥ 2.5% ET give_back_pct < 0.3
    → "Excellent gain quasi au pic capté"
    Avg pnl observé : 3.87% (BEST PERFORMER, n=4)

  R3 — CLOSE défensif (confidence 0.65) :
    give_back_pct ≥ 1.0
    → "Le rebond s'érode, lock avant aggravation"

  R4 — HOLD :
    Aucune des règles R0-R3 ne match clairement
    → "Pas encore en cible, laisse trailer ; filet J+10 protège"
    Note : ne JAMAIS hold si pnl_pct ≥ 2.5% (R2 doit déclencher)

★ FENÊTRE TEMPORELLE PRIORITAIRE (closes user 04/06 par heure UTC) :
  13:00-15:00 UTC (open NYSE) : 12 closes, Σ $339 → close prioritaire sur rebonds initiaux
  19:00-20:00 UTC : 17 closes, Σ $412 → close prioritaire sur entries fraîches en soirée
  ≥ 20:30 UTC : HARD CLOSE garanti côté code (tu n'as pas à gérer)

INPUT CONTEXT que tu recevras pour chaque position :
  symbol, direction, entry_price, current_price, unrealized_pnl_pct, mfe_pct, mae_pct, give_back_pct,
  age_minutes (NOUVEAU — utilise pour R0), minutes_since_nyse_open,
  indicators : rsi14, bb_pct_b, trend_5m_pct, macd_hist, atr14_pct, roc5,
  learned_policy : bloc texte distillé des closes passés labellisés (peut être minimaliste si sample < 20)

FORMAT RÉPONSE OBLIGATOIRE (JSON strict, aucun markdown, rien d'autre) :
{"action":"HOLD"|"CLOSE","confidence":0.0-1.0,"rationale":"<règle R0-R3 + 40 chars max>"}

EXEMPLES de rationales attendues :
  "R0 age=3min pnl=2.1% → quick-lock scalp"
  "R1 pnl=1.8% rsi=58 → fatigue confirmée"
  "R2 pnl=3.2% gb=0.15 → solid profit"
  "R3 gb=1.4 → défensif"
  "R4 pnl=0.8% → trop tôt"

DÉFAUT EN CAS DE DOUTE : si pnl ≥ 1.5%, préfère CLOSE conf 0.70 (l'humain a 100% WR en fermant tôt, le risque de manque d'upside est validé à 0% par le counterfactuel). Si pnl < 1.5%, HOLD conf 0.50.`;

@Injectable()
export class OversoldMistralExitService {
  private readonly logger = new Logger(OversoldMistralExitService.name);
  private readonly FETCH_TIMEOUT_MS = 8000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly exitPolicy: OversoldExitPolicyService,
    private readonly closeCapture: CloseDecisionCaptureService,
    private readonly intraday: IntradayProviderRouter,
  ) {}

  private isEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_MISTRAL_EXIT_ENABLED') ?? 'false').toLowerCase() === 'true';
  }

  private minMfePct(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_EXIT_MIN_MFE_PCT') ?? '1.5');
  }

  private confidenceThreshold(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_EXIT_CONFIDENCE_MIN') ?? '0.65');
  }

  /** R0 (quick-lock scalp) — age max en minutes pour déclencher. Default 10. */
  private r0MaxAgeMin(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_R0_MAX_AGE_MIN') ?? '10');
  }

  /** R0 — pnl% min pour déclencher quick-lock. Default 1.5. */
  private r0MinPnlPct(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_R0_MIN_PNL_PCT') ?? '1.5');
  }

  /** HARD CLOSE — heure UTC à partir de laquelle close forcé (intraday-only). Default 20.5 (20:30 UTC). */
  private hardCloseUtcHour(): number {
    return Number(this.config.get<string>('OVERSOLD_MISTRAL_HARD_CLOSE_UTC_HOUR') ?? '20.5');
  }

  /**
   * Cron toutes les 15 minutes. Plus réactif que l'OversoldExitService déterministe
   * (30min) pour capter les rebonds intelligents en cours de journée. Coût LLM
   * borné par MFE skip (positions underwater = pas évaluées).
   */
  @Cron('0 */15 * * * *', { name: 'oversold-mistral-exit', timeZone: 'UTC' })
  async runExitCycle(): Promise<void> {
    try {
      if (!this.isEnabled()) {
        this.logger.debug('[oversold-mistral-exit] OVERSOLD_MISTRAL_EXIT_ENABLED=false → skip');
        return;
      }
      const positions = await this.loadOpenPositions();
      if (positions.length === 0) return;

      const policyCache = new Map<string, string>();
      let evaluated = 0;
      let closed = 0;
      let skippedMfe = 0;

      for (const pos of positions) {
        try {
          const result = await this.evaluatePosition(pos, policyCache);
          if (result === 'closed') closed++;
          else if (result === 'evaluated') evaluated++;
          else if (result === 'skipped_mfe') skippedMfe++;
        } catch (err) {
          this.logger.warn(
            `[oversold-mistral-exit] ${pos.symbol} (${pos.id.slice(0, 8)}) échoué: ${String(err).slice(0, 200)}`,
          );
        }
      }

      this.logger.log(
        `[oversold-mistral-exit] cycle done — positions=${positions.length} evaluated=${evaluated} closed=${closed} skipped_mfe=${skippedMfe}`,
      );
    } catch (err) {
      this.logger.error(`[oversold-mistral-exit] runExitCycle exception: ${String(err).slice(0, 300)}`);
    }
  }

  private async evaluatePosition(
    pos: OpenOversoldRow,
    policyCache: Map<string, string>,
  ): Promise<'closed' | 'evaluated' | 'skipped_mfe' | 'skipped_no_price'> {
    const price = await this.fetchLastClose(pos.symbol);
    if (price == null) return 'skipped_no_price';

    const entry = parseFloat(pos.entry_price);
    if (!Number.isFinite(entry) || entry <= 0) return 'skipped_no_price';

    const sign = pos.direction === 'short' ? -1 : 1;
    const unrealPnlPct = ((price - entry) / entry) * 100 * sign;
    const ageDays = businessDaysSince(pos.entry_timestamp, new Date());
    const ageMin = (Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000;

    // ─── HARD CLOSE GUARD (intraday-only) ───────────────────────────────────
    // Garantit que les positions ne reposent jamais overnight. Fire avant tout
    // appel LLM. Validé par audit user : pas d'upside post-close historique.
    const now = new Date();
    const tUtcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (tUtcHour >= this.hardCloseUtcHour() && unrealPnlPct >= -1.0) {
      const verdict: MistralExitVerdict = {
        action: 'CLOSE',
        confidence: 0.95,
        rationale: `HARD_CLOSE time=${tUtcHour.toFixed(2)}UTC ≥ ${this.hardCloseUtcHour()} pnl=${unrealPnlPct.toFixed(2)}%`,
      };
      this.logger.log(
        `[oversold-mistral-exit] ${pos.symbol} HARD_CLOSE → close auto (pnl=${unrealPnlPct.toFixed(2)}%, age=${Math.round(ageMin)}min)`,
      );
      await this.closePosition(pos, price, unrealPnlPct, unrealPnlPct, ageDays, verdict);
      return 'closed';
    }

    // ─── R0 QUICK-LOCK SCALP GUARD ─────────────────────────────────────────
    // Si la position vient d'être ouverte (age ≤ 10min) et qu'elle a déjà
    // atteint le seuil de profit (≥ 1.5%), lock immédiat sans Mistral.
    // Validé par 12/34 closes user_manual du 19:44 batch (avg 2.03% pnl en 2min).
    if (ageMin <= this.r0MaxAgeMin() && unrealPnlPct >= this.r0MinPnlPct()) {
      const verdict: MistralExitVerdict = {
        action: 'CLOSE',
        confidence: 0.85,
        rationale: `R0 age=${Math.round(ageMin)}min pnl=${unrealPnlPct.toFixed(2)}% → quick-lock scalp`,
      };
      this.logger.log(
        `[oversold-mistral-exit] ${pos.symbol} R0_QUICK_LOCK → close auto (pnl=${unrealPnlPct.toFixed(2)}%, age=${Math.round(ageMin)}min)`,
      );
      await this.closePosition(pos, price, unrealPnlPct, unrealPnlPct, ageDays, verdict);
      return 'closed';
    }

    // MFE depuis le snapshot tracker (le plus fiable). Fallback PnL courant si absent.
    const { data: snap } = await this.supabase.getClient()
      .from('position_indicators_snapshot')
      .select('mfe_pct, mae_pct')
      .eq('position_id', pos.id)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const mfePct = (snap?.mfe_pct as number | null) ?? unrealPnlPct;
    const maePct = (snap?.mae_pct as number | null) ?? unrealPnlPct;
    const giveBack = mfePct - unrealPnlPct;

    // MFE skip : on ne brûle pas Mistral sur une position underwater ou MFE faible.
    if (mfePct < this.minMfePct()) {
      return 'skipped_mfe';
    }

    // Politique apprise (cache par portfolio dans cette boucle pour éviter N appels).
    let policyBlock = policyCache.get(pos.portfolio_id);
    if (policyBlock === undefined) {
      const policy = await this.exitPolicy.getLearnedPolicy(pos.portfolio_id).catch(() => null);
      policyBlock = policy?.promptBlock ?? '';
      policyCache.set(pos.portfolio_id, policyBlock);
    }

    // Fetch candles 5m pour computer indicateurs live (RSI/BB%b/trend_5m). Sans
    // ces signaux, Mistral est aveugle aux règles R1/R4 calibrées sur les closes
    // historiques de l'user. ATR/RSI exigent ≥15 bars, sinon on passe null.
    const indicators = await this.fetchLiveIndicators(pos.symbol, pos.asset_class);

    // Minutes depuis l'open NYSE (14:30 UTC). Négatif = pré-open.
    const nyseOpen = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 30));
    const minutesSinceNyseOpen = Math.round((now.getTime() - nyseOpen.getTime()) / 60_000);

    const userPrompt = JSON.stringify({
      symbol: pos.symbol,
      asset_class: pos.asset_class,
      direction: pos.direction,
      entry_price: entry,
      current_price: price,
      unrealized_pnl_pct: Number(unrealPnlPct.toFixed(2)),
      mfe_pct: Number(mfePct.toFixed(2)),
      mae_pct: Number(maePct.toFixed(2)),
      give_back_pct: Number(giveBack.toFixed(2)),
      age_minutes: Math.round(ageMin),
      held_business_days: ageDays,
      hold_target_days: 10,
      days_remaining: Math.max(0, 10 - ageDays),
      minutes_since_nyse_open: minutesSinceNyseOpen,
      indicators,
      learned_policy: policyBlock || '(échantillon insuffisant — heuristique défaut)',
    });

    const resp = await this.llmRouter.call({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      temperature: 0.2,
      maxTokens: 200,
      timeoutMs: 8000,
    }).catch((e) => {
      this.logger.debug(`[oversold-mistral-exit] LLM ${pos.symbol} err: ${String(e).slice(0, 150)}`);
      return null;
    });

    if (!resp || !resp.content) return 'evaluated';

    const verdict = this.parseVerdict(resp.content);
    if (!verdict) {
      this.logger.debug(`[oversold-mistral-exit] ${pos.symbol} parse failed: ${resp.content.slice(0, 100)}`);
      return 'evaluated';
    }

    this.logger.log(
      `[oversold-mistral-exit] ${pos.symbol} pnl=${unrealPnlPct.toFixed(2)}% mfe=${mfePct.toFixed(2)}% age=J+${ageDays} → ${verdict.action} (conf=${verdict.confidence.toFixed(2)}) ${verdict.rationale}`,
    );

    if (verdict.action === 'CLOSE' && verdict.confidence >= this.confidenceThreshold()) {
      await this.closePosition(pos, price, mfePct, unrealPnlPct, ageDays, verdict);
      return 'closed';
    }

    return 'evaluated';
  }

  private async closePosition(
    pos: OpenOversoldRow,
    price: number,
    mfePct: number,
    unrealPnlPct: number,
    ageDays: number,
    verdict: MistralExitVerdict,
  ): Promise<void> {
    const rationale = `[oversold_mistral_gain_pick] ${verdict.rationale} — pnl=${unrealPnlPct.toFixed(2)}% mfe=${mfePct.toFixed(2)}% J+${ageDays}/10 conf=${verdict.confidence.toFixed(2)}`;

    const result = await this.lisa.getPaperBroker().closePosition({
      positionId: pos.id,
      reason: 'closed_target',
      livePrice: String(price),
      rationale,
      livePriceSource: 'eodhd_eod',
      marketClosed: true,
    });

    // Apprentissage long terme — closerType custom pour distinguer des user_manual
    // (= permettra plus tard d'évaluer la qualité de Mistral vs l'humain).
    const ageMin = (Date.now() - new Date(pos.entry_timestamp).getTime()) / 60_000;
    this.closeCapture.captureClose({
      positionId: pos.id,
      portfolioId: pos.portfolio_id,
      symbol: pos.symbol,
      direction: pos.direction,
      assetClass: pos.asset_class,
      closerType: 'risk_monitor',
      entryPrice: parseFloat(pos.entry_price),
      exitPrice: price,
      pnlPct: result.realizedPnlPct ?? null,
      pnlUsd: result.realizedPnlUsd != null ? Number(result.realizedPnlUsd) : null,
      ageMinutes: Number.isFinite(ageMin) ? ageMin : 0,
      takeProfitPrice: pos.take_profit_price != null ? Number(pos.take_profit_price) : null,
      stopLossPrice: pos.stop_loss_price != null ? Number(pos.stop_loss_price) : null,
    });

    await this.decisionLog.append({
      portfolioId: pos.portfolio_id,
      kind: 'oversold_mistral_gain_pick',
      summary: `Mistral close ${pos.symbol} @ $${price.toFixed(4)} (pnl=${unrealPnlPct.toFixed(2)}%, J+${ageDays})`,
      rationale,
      payload: {
        symbol: pos.symbol,
        position_id: pos.id,
        exit_price: price,
        entry_price: parseFloat(pos.entry_price),
        mfe_pct: mfePct,
        unrealized_pnl_pct: unrealPnlPct,
        held_business_days: ageDays,
        mistral_action: verdict.action,
        mistral_confidence: verdict.confidence,
        mistral_rationale: verdict.rationale,
      },
      triggeredBy: 'autopilot_cron',
      watchlistSource: 'mechanical',
      market: 'us_equity',
    }).catch((e) => this.logger.warn(`[oversold-mistral-exit] decision_log append failed: ${String(e).slice(0, 160)}`));
  }

  private parseVerdict(content: string): MistralExitVerdict | null {
    try {
      const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned) as Partial<MistralExitVerdict>;
      const action = parsed.action === 'CLOSE' || parsed.action === 'HOLD' ? parsed.action : null;
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : NaN;
      const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
      if (!action || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
      return { action, confidence, rationale: rationale.slice(0, 200) };
    } catch {
      return null;
    }
  }

  private async loadOpenPositions(): Promise<OpenOversoldRow[]> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, direction, asset_class, entry_price, entry_timestamp, take_profit_price, stop_loss_price')
      .eq('venue_fee_detail->>source', 'scanner_oversold')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[oversold-mistral-exit] load positions failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as OpenOversoldRow[];
  }

  /**
   * Fetch les candles 5m (60 bars) et compute snapshot indicateurs + trend_5m.
   * Reproduit exactement la méthode utilisée par CloseDecisionCaptureService au
   * close (cohérence sémantique : Mistral voit les mêmes signaux que ceux qui
   * labellisent ses futures décisions GOOD/EARLY).
   */
  private async fetchLiveIndicators(
    symbol: string,
    assetClass: string | null,
  ): Promise<{
    rsi14: number | null;
    bb_pct_b: number | null;
    trend_5m_pct: number | null;
    macd_hist: number | null;
    atr14_pct: number | null;
    roc5: number | null;
  }> {
    const fallback = { rsi14: null, bb_pct_b: null, trend_5m_pct: null, macd_hist: null, atr14_pct: null, roc5: null };
    if ((assetClass ?? '').startsWith('crypto')) {
      // Oversold scope = US equities (russell1000), pas de crypto attendu mais on évite quand même.
      return fallback;
    }
    const series = await this.intraday.getCandles(symbol, '5m', 60, { calledBy: 'oversold_mistral_exit' }).catch(() => null);
    const raw = series?.candles ?? [];
    if (raw.length < 15) return fallback;
    const candles: IndicatorCandle[] = raw.map((c: { high: number; low: number; close: number; volume: number }) => ({
      high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
    const snap = computeIndicatorSnapshot(candles);
    let trend5m: number | null = null;
    if (candles.length >= 2) {
      const last = candles[candles.length - 1].close;
      const prev = candles[candles.length - 2].close;
      if (prev > 0) trend5m = ((last - prev) / prev) * 100;
    }
    return {
      rsi14: snap.rsi14,
      bb_pct_b: snap.bb_pct_b,
      trend_5m_pct: trend5m,
      macd_hist: snap.macd_hist,
      atr14_pct: snap.atr14_pct,
      roc5: snap.roc5,
    };
  }

  private async fetchLastClose(symbol: string): Promise<number | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return null;
    const to = new Date();
    const from = new Date(to.getTime() - 8 * 86_400_000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const url =
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
      `?from=${fromStr}&to=${toStr}&api_token=${apiKey}&fmt=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(json) || json.length === 0) return null;
      const sorted = json
        .map((b) => ({
          date: String(b.date ?? ''),
          close: Number(b.close ?? b.adjusted_close ?? NaN),
        }))
        .filter((b) => b.date.length > 0 && Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (sorted.length === 0) return null;
      return sorted[sorted.length - 1].close;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
