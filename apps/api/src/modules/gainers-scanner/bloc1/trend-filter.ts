/**
 * BLOC 1 — Trend filter EMA Golden Cross (ADR-005).
 *
 * Filtre binaire : EMA50 daily > EMA200 daily ⇒ Golden Cross établi.
 * Empiriquement : 41% → 54% win-rate sur les setups long avec ce filtre actif.
 *
 * TODO(PR6-shadow): vérifier l'affirmation "41%→54%" sur le dataset shadow run.
 * Documenter le dataset source (nb sessions, nb signaux ACCEPT, date range)
 * dans docs/adr/ADR-005-gainers-algo-v1.md §Shadow mode — rapport G*Power.
 */

import { CandidateRejectReason, TrendFilterKind } from '../domain/gainers-enums';
import type { GainersCandidateRaw } from '../domain/gainers-candidate.types';

export interface TrendFilterConfig {
  /** Active/désactive le filtre. Défaut true. */
  enabled: boolean;
  /**
   * PR6.6.5 — Shadow mode tolérance : si true ET ema50/ema200 daily est null
   * (cache OHLCV partiel pour equity hors-watchlist, OU fetch Binance flaky
   * intermittent crypto), retourne pass=true kind=NONE au lieu de
   * TREND_FILTER_FAIL.
   *
   * Default false : préserve comportement strict prod ADR-005 §1bis (algos
   * lockés). Activable uniquement via SHADOW_TREND_FILTER_CONFIG ou
   * SHADOW_BLOC1_FULL_CONFIG dans le pipeline shadow run.
   *
   * Justification : pour equity, le cron `ohlcv_cache_daily` (21:30 UTC)
   * ne couvre pas tous les tickers remontés par EODHD screener. Tickers
   * hors-cache → EMAs null → REJECT TREND systématique → corruption shadow
   * stats (100% trend_fail observé lundi 04/05 sur 1041 cycles). Cohérent
   * avec philosophie SHADOW_BLOC1_CONFIG (PR6.4 shadowSkipNullFields=true
   * sur ATR + persistence) — ce flag étend la tolérance au trend filter.
   *
   * Note ML : un kind=NONE résultant signal à AutoTuner V2 que ce signal n'a
   * pas été filtré sur trend, donc ne doit PAS être considéré comme
   * "validation trend filter" dans les stats post-Phase 4.
   */
  shadowSkipNullFields?: boolean;
}

export const DEFAULT_TREND_FILTER_CONFIG: TrendFilterConfig = {
  enabled: true,
  shadowSkipNullFields: false,
};

/**
 * PR6.6.5 — Config trend filter pour shadow run.
 * Identique à DEFAULT mais avec shadowSkipNullFields=true → tolère EMAs null.
 */
export const SHADOW_TREND_FILTER_CONFIG: TrendFilterConfig = {
  ...DEFAULT_TREND_FILTER_CONFIG,
  shadowSkipNullFields: true,
};

export interface TrendFilterResult {
  pass: boolean;
  kind: TrendFilterKind;
  reason: CandidateRejectReason | null;
  ema50: number | null;
  ema200: number | null;
}

/**
 * Évalue le trend filter sur les EMAs daily du candidat.
 * - enabled=false → pass=true, kind=NONE
 * - EMA50 ou EMA200 manquant :
 *     - shadowSkipNullFields=true (shadow mode) → pass=true, kind=NONE (PR6.6.5)
 *     - sinon → reject TREND_FILTER_FAIL (data unavailable, prod strict)
 * - EMA50 > EMA200 → pass, kind=EMA_GOLDEN_CROSS
 * - EMA50 ≤ EMA200 → reject TREND_FILTER_FAIL
 */
export function evaluateTrendFilter(
  raw: GainersCandidateRaw,
  cfg: TrendFilterConfig,
): TrendFilterResult {
  if (!cfg.enabled) {
    return {
      pass: true,
      kind: TrendFilterKind.NONE,
      reason: null,
      ema50: raw.ema50Daily,
      ema200: raw.ema200Daily,
    };
  }
  const ema50 = raw.ema50Daily;
  const ema200 = raw.ema200Daily;
  if (ema50 === null || ema200 === null) {
    // PR6.6.5 — shadow tolère EMA null (cache OHLCV partiel equity, fetch
    // Binance flaky crypto). Prod strict (cfg.shadowSkipNullFields !== true).
    if (cfg.shadowSkipNullFields) {
      return {
        pass: true,
        kind: TrendFilterKind.NONE,
        reason: null,
        ema50,
        ema200,
      };
    }
    return {
      pass: false,
      kind: TrendFilterKind.EMA_GOLDEN_CROSS,
      reason: CandidateRejectReason.TREND_FILTER_FAIL,
      ema50,
      ema200,
    };
  }
  if (ema50 > ema200) {
    return {
      pass: true,
      kind: TrendFilterKind.EMA_GOLDEN_CROSS,
      reason: null,
      ema50,
      ema200,
    };
  }
  return {
    pass: false,
    kind: TrendFilterKind.EMA_GOLDEN_CROSS,
    reason: CandidateRejectReason.TREND_FILTER_FAIL,
    ema50,
    ema200,
  };
}
