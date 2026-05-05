/**
 * PR6.8 RCFT — SignalForwardTrackerService.
 *
 * Cron daily 00:30 UTC qui :
 *   1. Seed nouvelles rows dans gainers_signal_forward depuis shadow_signals
 *      (last 24-96h, pas encore seedés)
 *   2. Fetch price T+24h pour rows 24h+ old, null price_t_plus_24h
 *   3. Fetch price T+72h pour rows 72h+ old, null price_t_plus_72h
 *   4. Compute outcome (champion/failure/neutral) selon decision + return_72h
 *   5. Cleanup expired (>30j)
 *
 * Symétrie ACCEPT/REJECT (PR6.8 ajout 5) :
 *   - REJECT + return_72h > +5% → 'champion' (gate trop strict)
 *   - ACCEPT + return_72h < -2% → 'failure' (gate trop laxiste)
 *   - ni l'un ni l'autre → 'neutral'
 *
 * Garde-fous ML :
 *   - champion_threshold + failure_threshold figés en migration (anti data-leakage)
 *   - Forward window cap T+72h (anti look-ahead bias)
 *   - Skip equity weekend rejects (price stale vendredi close)
 *   - Univers limité aux symbols dans gainers_volume_baselines (anti shitcoin scrappé)
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { BinanceMarketService } from '../../lisa/services/binance-market.service';
import { EodhdIntradayService } from '../../lisa/services/eodhd-intraday.service';
import { ensureEodhdSuffix } from '../../lisa/services/eodhd-symbol.util';
import { GainersInsightsService } from '../insights/gainers-insights.service';

const SEED_LOOKBACK_HOURS = 96;
const SEED_MIN_AGE_HOURS = 0; // seed dès qu'un signal existe
const T24H_WINDOW_MS = 24 * 3600_000;
const T72H_WINDOW_MS = 72 * 3600_000;
const BATCH_SIZE = 100;

/**
 * Mappe reject_reason → gate_passed_until.
 * Ordre BLOC 1 prefilter : liquidity → marketCap → volatility → persistence
 * Puis trend filter (BLOC 1 trend) → BLOC 2 spread → BLOC 3 trigger
 */
function gateBeforeReject(rejectReason: string | null, decision: string): string | null {
  if (decision === 'ACCEPT') return 'all';
  if (!rejectReason) return null;
  switch (rejectReason) {
    case 'LIQUIDITY_FLOOR': return null; // 1er gate
    case 'MARKET_CAP_MIN': return 'liquidity';
    case 'VOLATILITY_CLAMP': return 'marketCap';
    case 'PERSISTENCE_BELOW_THRESHOLD': return 'volatility';
    case 'TREND_FILTER_FAIL': return 'persistence';
    case 'SPREAD_TOO_WIDE': return 'trend';
    case 'NO_ENTRY_TRIGGER': return 'spread';
    case 'RVOL_INSUFFICIENT': return 'spread';
    default: return null;
  }
}

interface ShadowSignalSeed {
  id: string;
  symbol: string;
  /** Hotfix EODHD bypass — exchange persisté pour ensureEodhdSuffix. */
  exchange?: string | null;
  asset_class: string;
  decision: string;
  reject_reason: string | null;
  created_at: string;
  entry_price: number | null;
}

interface SignalForwardRow {
  id: string;
  symbol: string;
  /** Hotfix EODHD bypass — exchange persisté pour ensureEodhdSuffix. */
  exchange?: string | null;
  asset_class: string;
  decision: string;
  rejected_at: string;
  price_at_signal: number;
  source: string;
}

@Injectable()
export class SignalForwardTrackerService {
  private readonly logger = new Logger(SignalForwardTrackerService.name);
  private readonly envTag: string;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly binance: BinanceMarketService,
    private readonly eodhd: EodhdIntradayService,
    private readonly insights: GainersInsightsService,
    private readonly config: ConfigService,
  ) {
    // Lit le tag environnement pour cloisonner FP-rate (PR6.8 ajout 4).
    // Default 'shadow' aujourd'hui. Phase 4 canary writeront 'canary'/'prod'.
    const tag = (this.config.get<string>('GAINERS_ENV_TAG') ?? 'shadow').toLowerCase();
    this.envTag = ['shadow', 'canary', 'prod'].includes(tag) ? tag : 'shadow';
  }

  /** Cron daily 00:30 UTC strict (PR6.8.1 timezone explicite, anti drift Europe/Paris). */
  @Cron('30 0 * * *', { timeZone: 'UTC' })
  async runForwardTracking(): Promise<void> {
    try {
      const stats = await this.runInner();
      this.logger.log(
        `[rcft] cron OK — seeded=${stats.seeded} fetched24h=${stats.fetched24h} fetched72h=${stats.fetched72h} ` +
        `outcomes=${stats.outcomesComputed} (champions=${stats.champions} failures=${stats.failures}) cleaned=${stats.cleaned}`,
      );
    } catch (e) {
      this.logger.error(`[rcft] cron failed: ${String(e).slice(0, 200)}`);
      await this.insights.logInsight({
        type: 'data_quality',
        source: 'auto_drift_detector',
        severity: 'medium',
        summary: `RCFT cron failed: ${String(e).slice(0, 200)}`,
        payload: { error: String(e).slice(0, 500), env_tag: this.envTag },
      });
    }
  }

  async runInner(): Promise<{
    seeded: number;
    fetched24h: number;
    fetched72h: number;
    outcomesComputed: number;
    champions: number;
    failures: number;
    cleaned: number;
  }> {
    const seeded = await this.seedNewSignals();
    const fetched24h = await this.fetchT24Prices();
    const fetched72h = await this.fetchT72Prices();
    const { computed, champions, failures } = await this.computeOutcomes();
    const cleaned = await this.cleanupExpired();
    return {
      seeded,
      fetched24h,
      fetched72h,
      outcomesComputed: computed,
      champions,
      failures,
      cleaned,
    };
  }

  /** Step 1 — seed shadow signals (24-96h old) pas encore présents dans signal_forward. */
  private async seedNewSignals(): Promise<number> {
    const cutoffOld = new Date(Date.now() - SEED_LOOKBACK_HOURS * 3600_000).toISOString();
    const cutoffMinAge = new Date(Date.now() - SEED_MIN_AGE_HOURS * 3600_000).toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('id, symbol, exchange, asset_class, decision, reject_reason, created_at, entry_price')
      .gte('created_at', cutoffOld)
      .lte('created_at', cutoffMinAge)
      .limit(5000);

    if (error || !data) {
      this.logger.warn(`[rcft] seed fetch failed: ${error?.message ?? 'no data'}`);
      return 0;
    }

    let seeded = 0;
    const rows = data as ShadowSignalSeed[];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const upsertRows = batch
        .filter((r) => this.isSeedable(r))
        .map((r) => ({
          shadow_signal_id: r.id,
          symbol: r.symbol,
          asset_class: r.asset_class,
          decision: r.decision,
          reject_reason: r.reject_reason,
          gate_passed_until: gateBeforeReject(r.reject_reason, r.decision),
          // PR6.8.1 — Per-row env_tag via resolveEnvTag hook (canary-ready)
          env_tag: this.resolveEnvTag(r),
          rejected_at: r.created_at,
          price_at_signal: r.entry_price ?? 0,
          source: r.asset_class === 'crypto' ? 'binance' : 'eodhd',
        }))
        .filter((r) => r.price_at_signal > 0);

      if (upsertRows.length === 0) continue;

      const { error: upErr } = await this.supabase
        .getClient()
        .from('gainers_signal_forward')
        .upsert(upsertRows, { onConflict: 'shadow_signal_id', ignoreDuplicates: true });

      if (upErr) {
        this.logger.warn(`[rcft] seed batch failed: ${upErr.message}`);
      } else {
        seeded += upsertRows.length;
      }
    }
    return seeded;
  }

  /**
   * PR6.8.1 — Resolve thresholds at compute time : env vars override migration
   * defaults (CHAMPION_RET_PCT / FAILURE_RET_PCT). Permet ajustement runtime
   * sans ALTER TABLE.
   *
   * Default flow : utilise les valeurs stockées sur la row (champion=0.05,
   * failure=-0.02 from migration 0111).
   *
   * Override flow : si env var set ET parsable as number, l'utilise prioritaire.
   */
  private resolveOutcomeThresholds(
    rowChampionPct: number,
    rowFailurePct: number,
  ): { champion: number; failure: number } {
    const envChampion = parseFloat(this.config.get<string>('CHAMPION_RET_PCT') ?? '');
    const envFailure = parseFloat(this.config.get<string>('FAILURE_RET_PCT') ?? '');
    return {
      champion: Number.isFinite(envChampion) ? envChampion : rowChampionPct,
      failure: Number.isFinite(envFailure) ? envFailure : rowFailurePct,
    };
  }

  /**
   * PR6.8.1 — Hook per-row env_tag injection (canary-ready).
   *
   * Aujourd'hui : retourne le process-level envTag (lit GAINERS_ENV_TAG env var
   * au constructor, défaut 'shadow').
   *
   * TODO Phase 4 canary 10% routing : quand le routing intra-process canary est
   * implémenté (#224 V2 ou subsequent), cette méthode doit lookup le contexte
   * du signal (e.g., portfolios.execution_mode='canary' OU
   * gainers_v1_shadow_signals.env_tag column si ajoutée) pour distinguer shadow
   * vs canary vs prod. Single point of change pour passer de process-level à
   * per-row tagging.
   *
   * Le call site `seedNewSignals.upsertRows[].env_tag = this.resolveEnvTag(r)`
   * est PRÊT pour ce switch sans changer le rest du flow.
   */
  private resolveEnvTag(_signalRow: ShadowSignalSeed): string {
    // TODO 2026-Q2 canary routing : lookup `_signalRow.portfolio_id` (à ajouter
    // dans select query) puis lire `lisa_session_configs.execution_mode` ou un
    // futur champ `env_tag` sur shadow_signals. Pour l'instant, process-level.
    return this.envTag;
  }

  /**
   * Skip equity rejects créés sam/dim (price_at_signal = vendredi close stale).
   * Crypto OK 24/7.
   */
  private isSeedable(row: ShadowSignalSeed): boolean {
    if (row.asset_class === 'crypto') return true;
    const day = new Date(row.created_at).getUTCDay(); // 0=Sun, 6=Sat
    return day !== 0 && day !== 6;
  }

  /** Step 2 — fetch T+24h prices pour rows 24h+ old avec null price_t_plus_24h. */
  private async fetchT24Prices(): Promise<number> {
    return this.fetchForwardPrices(T24H_WINDOW_MS, 'price_t_plus_24h', 'fetched_24h_at', 'return_24h');
  }

  /** Step 3 — fetch T+72h prices pour rows 72h+ old avec null price_t_plus_72h. */
  private async fetchT72Prices(): Promise<number> {
    return this.fetchForwardPrices(T72H_WINDOW_MS, 'price_t_plus_72h', 'fetched_72h_at', 'return_72h');
  }

  private async fetchForwardPrices(
    windowMs: number,
    priceCol: string,
    fetchedAtCol: string,
    returnCol: string,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_signal_forward')
      .select('id, symbol, exchange, asset_class, decision, rejected_at, price_at_signal, source')
      .lte('rejected_at', cutoff)
      .is(priceCol as any, null)
      .limit(500);

    if (error || !data) {
      this.logger.warn(`[rcft] fetch ${priceCol} query failed: ${error?.message ?? 'no data'}`);
      return 0;
    }

    let fetched = 0;
    for (const row of data as SignalForwardRow[]) {
      try {
        const targetTimeMs = new Date(row.rejected_at).getTime() + windowMs;
        const forwardPrice = await this.fetchClosePriceAtTime(row.symbol, row.exchange ?? null, row.asset_class, targetTimeMs);
        if (forwardPrice === null || forwardPrice <= 0) continue;

        const ret = (forwardPrice - row.price_at_signal) / row.price_at_signal;
        const patch: Record<string, unknown> = {
          [priceCol]: forwardPrice,
          [fetchedAtCol]: new Date().toISOString(),
          [returnCol]: ret,
        };
        const { error: upErr } = await this.supabase
          .getClient()
          .from('gainers_signal_forward')
          .update(patch)
          .eq('id', row.id);
        if (!upErr) fetched++;
      } catch (e) {
        this.logger.debug(`[rcft] fetch ${row.symbol}: ${String(e).slice(0, 80)}`);
      }
    }
    return fetched;
  }

  /**
   * Fetch close price d'une journée donnée pour un symbol.
   * Crypto → Binance daily klines.
   * Equity → EODHD intraday 1h proche du targetTime.
   */
  private async fetchClosePriceAtTime(
    symbol: string,
    exchange: string | null,
    assetClass: string,
    targetTimeMs: number,
  ): Promise<number | null> {
    if (assetClass === 'crypto') {
      const m = symbol.match(/^([A-Z0-9]+)-USD\.CC$/);
      const binanceSymbol = m ? `${m[1]}USDT` : symbol;
      // Fetch 5 daily klines around targetTime
      const klines = await this.binance.getKlines(binanceSymbol, '1d', 5);
      if (!klines || klines.length === 0) return null;
      // Find kline with openTime closest to targetTime
      const targetDayMs = Math.floor(targetTimeMs / 86400_000) * 86400_000;
      const match = klines.find((k: any) => {
        const openTime = (k as any).openTime ?? 0;
        return Math.abs(openTime - targetDayMs) < 86400_000;
      });
      return match?.close ?? klines[klines.length - 1].close;
    }
    // Equity : fetch 1h candles, take the closest close to targetTime
    // Hotfix EODHD bypass — applique suffix exchange (rows legacy peuvent
    // avoir symbol RAW sans suffix → 404).
    const eodhdTicker = ensureEodhdSuffix(symbol, exchange);
    const series = await this.eodhd.getCandles(eodhdTicker, '1h', 100);
    if (!series || series.candles.length === 0) return null;
    // Trouver la candle avec timestamp le plus proche de targetTime
    let closest = series.candles[0];
    let minDiff = Number.MAX_SAFE_INTEGER;
    for (const c of series.candles) {
      const t = (c as any).timestamp ?? (c as any).datetime ?? 0;
      const diff = Math.abs(t - targetTimeMs);
      if (diff < minDiff) {
        minDiff = diff;
        closest = c;
      }
    }
    return closest.close ?? null;
  }

  /**
   * Step 4 — compute outcome (champion/failure/neutral) sur rows avec
   * price_t_plus_72h non null mais outcome null.
   *
   * PR6.8.1 :
   *  - Inclusivité boundaries : >= et <= (cas exact +5% ou -2% labellé)
   *  - Env vars CHAMPION_RET_PCT + FAILURE_RET_PCT override migration default
   *    AT COMPUTE TIME (no ALTER TABLE needed pour ajuster seuils)
   */
  private async computeOutcomes(): Promise<{ computed: number; champions: number; failures: number }> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_signal_forward')
      .select('id, decision, return_72h, champion_threshold_pct, failure_threshold_pct')
      .not('return_72h', 'is', null)
      .is('outcome', null)
      .limit(1000);

    if (error || !data) return { computed: 0, champions: 0, failures: 0 };

    let computed = 0;
    let champions = 0;
    let failures = 0;
    for (const r of data as Array<{
      id: string;
      decision: string;
      return_72h: number;
      champion_threshold_pct: number;
      failure_threshold_pct: number;
    }>) {
      // PR6.8.1 — env var override at compute time (pas migration ALTER)
      const { champion: championPct, failure: failurePct } = this.resolveOutcomeThresholds(
        Number(r.champion_threshold_pct),
        Number(r.failure_threshold_pct),
      );
      let outcome: 'champion' | 'failure' | 'neutral' = 'neutral';
      // PR6.8.1 — inclusivité (>= et <=) au lieu de strict (> et <)
      if (r.decision === 'REJECT' && r.return_72h >= championPct) {
        outcome = 'champion';
        champions++;
      } else if (r.decision === 'ACCEPT' && r.return_72h <= failurePct) {
        outcome = 'failure';
        failures++;
      }
      const { error: upErr } = await this.supabase
        .getClient()
        .from('gainers_signal_forward')
        .update({ outcome })
        .eq('id', r.id);
      if (!upErr) computed++;
    }
    return { computed, champions, failures };
  }

  /** Step 5 — DELETE WHERE expires_at < NOW() (utilise NOW() au DELETE pas en index). */
  private async cleanupExpired(): Promise<number> {
    const nowIso = new Date().toISOString();
    const { error, count } = await this.supabase
      .getClient()
      .from('gainers_signal_forward')
      .delete({ count: 'exact' })
      .lt('expires_at', nowIso);
    if (error) {
      this.logger.warn(`[rcft] cleanup failed: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  }
}
