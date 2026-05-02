/**
 * BLOC 3 — Détection de cassure de structure post-signal.
 *
 * Un pullback_HL_fibo est invalidé si le prix live descend sous le swing low N=5
 * identifié au moment du signal d'entrée. C'est la condition de "structure break" :
 * le setup n'est plus valide, le moteur BLOC 4 doit invalider la position.
 *
 * Règle : price < entrySwingLow → STRUCTURE_BREAK
 */

export interface StructureBreakInput {
  /** Prix courant (dernière bougie close ou tick live). */
  currentPrice: number;
  /** Swing low N=5 calculé au moment du signal d'entrée. */
  entrySwingLow: number;
  /** Tolérance en fraction (défaut 0 = strict). Ex: 0.001 = 0.1% de marge. */
  toleranceFraction?: number;
}

export interface StructureBreakResult {
  isBroken: boolean;
  /** Écart entre currentPrice et entrySwingLow, en fraction (peut être négatif). */
  distanceFraction: number;
}

export function detectStructureBreak(input: StructureBreakInput): StructureBreakResult {
  const { currentPrice, entrySwingLow, toleranceFraction = 0 } = input;

  if (entrySwingLow <= 0) {
    return { isBroken: false, distanceFraction: 0 };
  }

  const distanceFraction = (currentPrice - entrySwingLow) / entrySwingLow;
  const isBroken = distanceFraction < -toleranceFraction;

  return { isBroken, distanceFraction };
}
