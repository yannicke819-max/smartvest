/**
 * BLOC 3 — VWAP intraday cumulatif.
 *
 * VWAP = Σ(typical_price × volume) / Σ(volume)
 * typical_price = (H + L + C) / 3
 *
 * Calculé depuis l'ouverture de session sur les bougies reçues.
 * La résolution recommandée est 1m (crypto Binance) ou 5m (equity EODHD).
 */

import type { CandleOHLCV } from '../bloc2/spread-proxy';

export interface VwapResult {
  vwap: number;
  /** true si < 2 bougies valides (résultat non significatif). */
  insufficient: boolean;
}

export function computeVwap(candles: CandleOHLCV[]): VwapResult {
  if (candles.length === 0) return { vwap: 0, insufficient: true };

  let cumTypicalVol = 0;
  let cumVol = 0;

  for (const c of candles) {
    if (c.volume <= 0) continue;
    const typical = (c.high + c.low + c.close) / 3;
    cumTypicalVol += typical * c.volume;
    cumVol += c.volume;
  }

  if (cumVol === 0) return { vwap: 0, insufficient: true };

  return {
    vwap: cumTypicalVol / cumVol,
    insufficient: false,
  };
}
