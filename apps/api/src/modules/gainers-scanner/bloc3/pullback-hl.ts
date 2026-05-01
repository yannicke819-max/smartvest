/**
 * BLOC 3 — Trigger PULLBACK_HL_FIBO.
 *
 * Signal déclenché quand le prix recule vers un niveau Fibonacci (38.2, 50 ou 61.8%)
 * calculé sur le dernier swing high/low N=5 (Bulkowski 2021), avec confirmation
 * de volume surge (vol courant ≥ 1.5× baseline).
 *
 * Conditions d'entrée :
 *   1. Swing high + swing low identifiés (N=5, au moins 2 pivots droit/gauche)
 *   2. Prix courant dans la zone de retracement (tolerance ±0.5% du niveau Fibo)
 *   3. Volume surge confirmé (surgeRatio ≥ surgeMultiplier)
 *   4. Prix au-dessus du swing low (structure non cassée)
 */

import { EntryTriggerKind } from '../domain/gainers-enums';
import type { GainersEntrySignal } from '../domain/gainers-candidate.types';
import type { CandleOHLCV } from '../bloc2/spread-proxy';
import { computeSwingPivots, nearestFiboLevel } from './swing-pivot';
import { detectVolumeSurge } from './volume-surge';

export interface PullbackHLConfig {
  /** Tolerance autour du niveau Fibo en fraction (défaut 0.005 = ±0.5%). */
  fiboToleranceFraction: number;
  /** Multiplicateur surge volume minimum (défaut 1.5). */
  volumeSurgeMultiplier: number;
}

export const DEFAULT_PULLBACK_HL_CONFIG: PullbackHLConfig = {
  fiboToleranceFraction: 0.005,
  volumeSurgeMultiplier: 1.5,
};

export interface PullbackHLInput {
  symbol: string;
  candles: CandleOHLCV[];
  /** Baseline volume pour le surge check (médiane 20j ou moyenne fenêtre). */
  volumeBaseline: number;
  ema50Daily: number | null;
  ema200Daily: number | null;
  vwap: number | null;
  detectedAt: string;
}

export function evaluatePullbackHL(
  input: PullbackHLInput,
  cfg: PullbackHLConfig = DEFAULT_PULLBACK_HL_CONFIG,
): GainersEntrySignal | null {
  const { symbol, candles, volumeBaseline, ema50Daily, ema200Daily, vwap, detectedAt } = input;

  if (candles.length < 5) return null;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const pivots = computeSwingPivots(highs, lows);

  if (!pivots.swingHigh || !pivots.swingLow || !pivots.fiboLevels) return null;

  const lastCandle = candles[candles.length - 1];
  const currentPrice = lastCandle.close;

  if (currentPrice <= pivots.swingLow.price) return null;

  const levels = pivots.fiboLevels;
  const nearest = nearestFiboLevel(currentPrice, levels);
  const targetLevel =
    nearest === 38.2 ? levels.level382
    : nearest === 50 ? levels.level500
    : levels.level618;

  const distFromFibo = Math.abs(currentPrice - targetLevel) / targetLevel;
  if (distFromFibo > cfg.fiboToleranceFraction) return null;

  const surge = detectVolumeSurge(
    { currentVolume: lastCandle.volume, baselineVolume: volumeBaseline },
    cfg.volumeSurgeMultiplier,
  );
  if (!surge.isSurge) return null;

  return {
    symbol,
    triggerKind: EntryTriggerKind.PULLBACK_HL_FIBO,
    swingHigh: pivots.swingHigh.price,
    swingLow: pivots.swingLow.price,
    fiboLevel: nearest,
    vwap,
    ema50Daily,
    ema200Daily,
    detectedAt,
  };
}
