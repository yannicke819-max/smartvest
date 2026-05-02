/**
 * BLOC 3 — Trigger VWAP_RECLAIM.
 *
 * Signal déclenché quand le prix croise au-dessus du VWAP intraday après être
 * passé dessous, avec confirmation EMA50 > EMA200 (trend filter) et volume surge.
 *
 * Conditions d'entrée :
 *   1. Bougie précédente : close < VWAP (prix sous VWAP)
 *   2. Bougie courante  : close > VWAP (reclaim)
 *   3. EMA50 daily > EMA200 daily (Golden Cross — trend bullish)
 *   4. Volume surge confirmé (vol courant ≥ 1.5× baseline)
 *
 * Le VWAP doit être calculé sur la session intraday courante (bougies depuis l'open).
 */

import { EntryTriggerKind } from '../domain/gainers-enums';
import type { GainersEntrySignal } from '../domain/gainers-candidate.types';
import type { CandleOHLCV } from '../bloc2/spread-proxy';
import { detectVolumeSurge } from './volume-surge';

export interface VwapReclaimConfig {
  /** Multiplicateur surge volume minimum (défaut 1.5). */
  volumeSurgeMultiplier: number;
}

export const DEFAULT_VWAP_RECLAIM_CONFIG: VwapReclaimConfig = {
  volumeSurgeMultiplier: 1.5,
};

export interface VwapReclaimInput {
  symbol: string;
  candles: CandleOHLCV[];
  vwap: number;
  ema50Daily: number | null;
  ema200Daily: number | null;
  volumeBaseline: number;
  detectedAt: string;
}

export function evaluateVwapReclaim(
  input: VwapReclaimInput,
  cfg: VwapReclaimConfig = DEFAULT_VWAP_RECLAIM_CONFIG,
): GainersEntrySignal | null {
  const { symbol, candles, vwap, ema50Daily, ema200Daily, volumeBaseline, detectedAt } = input;

  if (candles.length < 2 || vwap <= 0) return null;

  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  if (prev.close >= vwap) return null;
  if (curr.close <= vwap) return null;

  if (!ema50Daily || !ema200Daily || ema50Daily <= ema200Daily) return null;

  const surge = detectVolumeSurge(
    { currentVolume: curr.volume, baselineVolume: volumeBaseline },
    cfg.volumeSurgeMultiplier,
  );
  if (!surge.isSurge) return null;

  return {
    symbol,
    triggerKind: EntryTriggerKind.VWAP_RECLAIM,
    swingHigh: null,
    swingLow: null,
    fiboLevel: null,
    vwap,
    ema50Daily,
    ema200Daily,
    detectedAt,
  };
}
