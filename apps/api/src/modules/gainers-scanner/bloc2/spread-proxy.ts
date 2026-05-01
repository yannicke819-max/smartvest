/**
 * BLOC 2 — Spread proxy v2 (synchro algo item #9 — formule canonique locked).
 *
 * Formule : median_5candles( (H - L) / ((H + L) / 2) )
 *   - Numérateur  : range absolu H-L
 *   - Dénominateur: mid-price = (H+L)/2 (Corwin-Schultz 2012 JF, eq. approchée)
 *   - Correction PR4 vs PR3 : ancien code utilisait (H-L)*0.5/close → sous-estimait 2×
 *
 * Volume floor : ignorer bougies dont vol < p20(volumes_window) pour éviter
 * biais des bougies mortes (illiquidité transitoire, auction pré-marché).
 *
 * Seuils gate (asset-class-aware, ADR-005 §synchro-v2) :
 *   - Equity  : spread ≤ 0.004 (0.40%)
 *   - Crypto  : spread ≤ 0.006 (0.60%)
 *
 * Fenêtre bougies : param explicite (1h ou daily selon orchestrateur).
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
  /** Spread proxy en fraction décimale (0.004 = 0.40%). */
  spreadFraction: number;
  source: SpreadProxySource;
  /** Nombre de bougies retenues après filtre p20 volume. */
  usableCandles: number;
}

export interface SpreadProxyConfig {
  /** Nombre de bougies les plus récentes à utiliser pour la médiane (défaut 5). */
  windowCandles: number;
  /**
   * Taille de la fenêtre pour calculer p20 du volume (défaut 20).
   * Si candles.length < volumePercentileWindow, utilise toutes les candles dispo.
   */
  volumePercentileWindow: number;
  /** Nombre minimum de bougies utilisables requis pour la médiane (défaut 3). */
  minUsableCandles: number;
  /** Seuil de rejet equity (défaut 0.004 = 0.40%). */
  spreadCapEquityFraction: number;
  /** Seuil de rejet crypto (défaut 0.006 = 0.60%). */
  spreadCapCryptoFraction: number;
}

export const DEFAULT_SPREAD_PROXY_CONFIG: SpreadProxyConfig = {
  windowCandles: 5,
  volumePercentileWindow: 20,
  minUsableCandles: 3,
  spreadCapEquityFraction: 0.004,
  spreadCapCryptoFraction: 0.006,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Calcule le k-ième percentile (interpolation linéaire). */
export function percentile(values: number[], k: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (k / 100) * (sorted.length - 1);
  const lower = Math.floor(pos);
  const frac = pos - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return sorted[lower] + frac * (sorted[lower + 1] - sorted[lower]);
}

/**
 * Calcule le spread proxy sur un lot de bougies.
 *
 * @param candles - Bougies dans l'ordre chronologique (la dernière = la plus récente).
 *                  Recommandé : 20+ bougies pour un p20 fiable.
 * @param resolution - Résolution des bougies : '1h' | 'daily' | '1m'
 * @param marketClass - Détermine le cap de rejet (equity vs crypto).
 */
export function computeSpreadProxy(
  candles: CandleOHLCV[],
  resolution: '1m' | '1h' | 'daily',
  marketClass: 'equity' | 'crypto',
  cfg: SpreadProxyConfig = DEFAULT_SPREAD_PROXY_CONFIG,
): SpreadProxyResult {
  const spreadCap = marketClass === 'crypto' ? cfg.spreadCapCryptoFraction : cfg.spreadCapEquityFraction;

  if (candles.length === 0) {
    return { spreadFraction: spreadCap, source: SpreadProxySource.STATIC_CAP_FALLBACK, usableCandles: 0 };
  }

  // p20 du volume sur la fenêtre de percentile (toutes les bougies dispo)
  const volWindow = candles.slice(-cfg.volumePercentileWindow);
  const p20Vol = percentile(volWindow.map((c) => c.volume), 20);

  // Bougies récentes pour la médiane spread
  const recentCandles = candles.slice(-cfg.windowCandles);
  const usable = recentCandles.filter(
    (c) => c.volume > 0 && c.volume >= p20Vol && c.high > 0 && c.low > 0 && c.high > c.low,
  );

  if (usable.length < cfg.minUsableCandles) {
    return {
      spreadFraction: spreadCap,
      source: SpreadProxySource.STATIC_CAP_FALLBACK,
      usableCandles: usable.length,
    };
  }

  // Formule canonique : (H - L) / ((H + L) / 2)
  const spreads = usable.map((c) => (c.high - c.low) / ((c.high + c.low) / 2));
  const medianSpread = median(spreads);

  const source: SpreadProxySource =
    resolution === '1m' ? SpreadProxySource.HL_1M_MEDIAN : SpreadProxySource.HL_5M_MEDIAN;

  return { spreadFraction: medianSpread, source, usableCandles: usable.length };
}

export function isSpreadTooWide(
  result: SpreadProxyResult,
  marketClass: 'equity' | 'crypto',
  cfg: SpreadProxyConfig = DEFAULT_SPREAD_PROXY_CONFIG,
): boolean {
  const cap = marketClass === 'crypto' ? cfg.spreadCapCryptoFraction : cfg.spreadCapEquityFraction;
  return result.spreadFraction > cap;
}
