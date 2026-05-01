/**
 * BLOC 3 — Détection de gap et de surge de volume.
 *
 * Gap up : open > prev_close × (1 + gapMinPct). Confirme un breakout overnight.
 * Volume surge : vol_current > baseline × surgeMultiplier. Confirme l'intérêt acheteur.
 *
 * Ces checks sont utilisés comme filtres de confirmation au sein des triggers
 * PULLBACK_HL_FIBO et VWAP_RECLAIM, pas comme gates indépendants.
 */

export interface GapInput {
  open: number;
  prevClose: number;
}

export interface GapResult {
  isGapUp: boolean;
  gapFraction: number;
}

export function detectGapUp(input: GapInput, gapMinFraction = 0.005): GapResult {
  const { open, prevClose } = input;
  if (prevClose <= 0) return { isGapUp: false, gapFraction: 0 };
  const gapFraction = (open - prevClose) / prevClose;
  return { isGapUp: gapFraction >= gapMinFraction, gapFraction };
}

export interface VolumeSurgeInput {
  /** Volume de la bougie courante (unités asset ou USD, cohérent avec baseline). */
  currentVolume: number;
  /** Baseline de référence (médiane 20j ou volume moyen de la fenêtre). */
  baselineVolume: number;
}

export interface VolumeSurgeResult {
  isSurge: boolean;
  /** Ratio currentVolume / baselineVolume. */
  surgeRatio: number;
}

export function detectVolumeSurge(
  input: VolumeSurgeInput,
  surgeMultiplier = 1.5,
): VolumeSurgeResult {
  const { currentVolume, baselineVolume } = input;
  if (baselineVolume <= 0) return { isSurge: false, surgeRatio: 0 };
  const surgeRatio = currentVolume / baselineVolume;
  return { isSurge: surgeRatio >= surgeMultiplier, surgeRatio };
}
