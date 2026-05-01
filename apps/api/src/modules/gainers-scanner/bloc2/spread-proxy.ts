/**
 * BLOC 2 — Spread proxy (ADR-005 §1bis, cap 0.30%).
 *
 * Implémentation : médiane de (H-L)×0.5/close sur les N dernières bougies
 * ayant un volume > 0. Inspiré de Corwin & Schultz (2012) "A Simple Way to
 * Estimate Bid-Ask Spreads from Daily High and Low Prices", simplifié pour
 * l'intraday 1m/5m.
 *
 * Toutes les fonctions sont pures — pas d'I/O.
 */

import { SpreadProxySource } from '../domain/gainers-enums';

export interface CandleOHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SpreadProxyResult {
  /** Spread proxy en fraction décimale (0.003 = 0.30%). */
  spreadFraction: number;
  source: SpreadProxySource;
  /** Nombre de bougies avec vol > 0 effectivement utilisées dans la médiane. */
  usableCandles: number;
}

export interface SpreadProxyConfig {
  /** Nombre minimum de bougies avec vol > 0 requis pour la médiane. Défaut 3. */
  minVolCandles: number;
  /** Cap absolu appliqué au résultat (fallback statique si < minVolCandles). Défaut 0.003. */
  spreadCapFraction: number;
}

export const DEFAULT_SPREAD_PROXY_CONFIG: SpreadProxyConfig = {
  minVolCandles: 3,
  spreadCapFraction: 0.003,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Calcule le spread proxy sur un lot de bougies.
 *
 * Si les bougies sont des 1m → source HL_1M_MEDIAN.
 * Si les bougies sont des 5m → source HL_5M_MEDIAN.
 * Si < minVolCandles bougies utilisables → STATIC_CAP_FALLBACK.
 */
export function computeSpreadProxy(
  candles: CandleOHLCV[],
  resolution: '1m' | '5m',
  cfg: SpreadProxyConfig = DEFAULT_SPREAD_PROXY_CONFIG,
): SpreadProxyResult {
  const usable = candles.filter((c) => c.volume > 0 && c.close > 0);

  if (usable.length < cfg.minVolCandles) {
    return {
      spreadFraction: cfg.spreadCapFraction,
      source: SpreadProxySource.STATIC_CAP_FALLBACK,
      usableCandles: usable.length,
    };
  }

  const halfSpreads = usable.map((c) => (c.high - c.low) * 0.5 / c.close);
  const medianHalfSpread = median(halfSpreads);
  // Pas de cap ici — la comparaison vs spreadCapFraction est faite par le caller (gate SPREAD_TOO_WIDE).

  return {
    spreadFraction: medianHalfSpread,
    source: resolution === '1m' ? SpreadProxySource.HL_1M_MEDIAN : SpreadProxySource.HL_5M_MEDIAN,
    usableCandles: usable.length,
  };
}

/** Détermine si le spread proxy dépasse le cap (rejet BLOC 2). */
export function isSpreadTooWide(result: SpreadProxyResult, capFraction: number): boolean {
  return result.spreadFraction > capFraction;
}
