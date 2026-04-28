/**
 * P3-C — Pre-filter RSI rapide pour le scanner rebound-tp.
 *
 * Problème : 500 tickers × 26 ticks/jour = 13 000 fetches OHLCV.
 * Solution : phase 1 = lecture cache en mémoire/DB, calc RSI pur,
 * garde seulement les tickers où RSI < threshold (~30-50 sur 500).
 *
 * Pure function. Réutilise le RSI Wilder simplifié de scanRebound
 * (cohérence garantie : si phase 1 dit "RSI < threshold", scanRebound
 * en phase 2 verra le même RSI).
 */

import type { Candle } from './rebound-tp';

export interface PrefilterResult {
  ticker: string;
  rsi14: number;
  /** True si rsi14 < threshold ET valeurs cohérentes. */
  passes: boolean;
  /** Diagnostic si fail (insufficient_bars, invalid_data, rsi_too_high). */
  reason?: string;
}

/**
 * Évalue le pre-filter sur un ticker. Retourne `passes: true` si le
 * ticker mérite la phase 2 (full scan).
 */
export function evaluatePrefilter(
  ticker: string,
  bars: Candle[] | null | undefined,
  rsiThreshold: number,
  rsiPeriod: number = 14,
): PrefilterResult {
  if (!Array.isArray(bars) || bars.length < rsiPeriod + 1) {
    return { ticker, rsi14: NaN, passes: false, reason: 'insufficient_bars' };
  }

  // Sanity check sur les N+1 derniers closes (les seuls utilisés).
  const startIdx = bars.length - rsiPeriod - 1;
  const closes: number[] = [];
  for (let i = startIdx; i < bars.length; i++) {
    const c = bars[i].close;
    if (!Number.isFinite(c) || c <= 0) {
      return { ticker, rsi14: NaN, passes: false, reason: 'invalid_data' };
    }
    closes.push(c);
  }

  // RSI Wilder simplifié — moyennes arithmétiques sur les N retours.
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / rsiPeriod;
  const avgLoss = losses / rsiPeriod;
  let rsi14: number;
  if (avgLoss === 0) {
    rsi14 = avgGain === 0 ? 50 : 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi14 = 100 - 100 / (1 + rs);
  }

  if (rsi14 >= rsiThreshold) {
    return { ticker, rsi14, passes: false, reason: 'rsi_too_high' };
  }
  return { ticker, rsi14, passes: true };
}

/**
 * Évalue le pre-filter sur un univers complet. Retourne uniquement
 * les tickers qui passent (candidats pour phase 2).
 */
export function prefilterUniverse(
  universe: Array<{ ticker: string; bars: Candle[] | null | undefined }>,
  rsiThreshold: number,
  rsiPeriod: number = 14,
): PrefilterResult[] {
  return universe
    .map((u) => evaluatePrefilter(u.ticker, u.bars, rsiThreshold, rsiPeriod))
    .filter((r) => r.passes);
}
