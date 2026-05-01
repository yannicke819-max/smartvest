/**
 * BLOC 1 — Trend filter EMA Golden Cross (ADR-005).
 *
 * Filtre binaire : EMA50 daily > EMA200 daily ⇒ Golden Cross établi.
 * Empiriquement : 41% → 54% win-rate sur les setups long avec ce filtre actif.
 */

import { CandidateRejectReason, TrendFilterKind } from '../domain/gainers-enums';
import type { GainersCandidateRaw } from '../domain/gainers-candidate.types';

export interface TrendFilterConfig {
  /** Active/désactive le filtre. Défaut true. */
  enabled: boolean;
}

export const DEFAULT_TREND_FILTER_CONFIG: TrendFilterConfig = {
  enabled: true,
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
 * - EMA50 ou EMA200 manquant → reject TREND_FILTER_FAIL (data unavailable)
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
