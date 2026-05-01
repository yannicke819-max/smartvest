/**
 * BLOC 3 — RVOL intraday time-normalized.
 *
 * Formule : RVOL_normalized = (cumIntradayVol / elapsedFraction) / fullDayBaseline
 *   where elapsedFraction = elapsedMinutes / sessionMinutes
 *
 * Rationale : comparer un volume de 9h30 à 10h30 (60 min sur 390 min = 15.4% de la
 * session) au volume journalier total sans normalisation produit un biais ×6 par
 * rapport à la fin de journée. La normalisation ramène le cumul courant à son
 * équivalent plein-jour projeté, puis le divise par la baseline 20j.
 *
 * Seuils indicatifs (non gates, valeur informationnelle) :
 *   RVOL ≥ 2.0  → surge confirmé
 *   RVOL 1.5-2  → surge modéré
 *   RVOL < 1.5  → activité normale
 */

export interface RvolNormalizedInput {
  /** Volume cumulatif intraday depuis l'ouverture de session (USD). */
  cumIntradayVolUsd: number;
  /** Baseline plein-jour (médiane 20 jours) en USD. */
  fullDayBaselineUsd: number;
  /** Minutes écoulées depuis l'ouverture de session. */
  elapsedMinutes: number;
  /** Durée totale de la session en minutes. Equity US = 390, crypto = 1440. */
  sessionMinutes: number;
}

export interface RvolNormalizedResult {
  rvolNormalized: number;
  elapsedFraction: number;
  /** true si elapsedMinutes < MIN_ELAPSED_MINUTES (résultat peu fiable). */
  tooEarly: boolean;
}

/** Minimum de minutes écoulées pour que le RVOL soit significatif. */
const MIN_ELAPSED_MINUTES = 30;

export function computeRvolNormalized(input: RvolNormalizedInput): RvolNormalizedResult | null {
  const { cumIntradayVolUsd, fullDayBaselineUsd, elapsedMinutes, sessionMinutes } = input;

  if (fullDayBaselineUsd <= 0 || sessionMinutes <= 0 || elapsedMinutes <= 0) {
    return null;
  }

  const elapsedFraction = Math.min(elapsedMinutes / sessionMinutes, 1.0);
  const projectedFullDay = cumIntradayVolUsd / elapsedFraction;
  const rvolNormalized = projectedFullDay / fullDayBaselineUsd;

  return {
    rvolNormalized,
    elapsedFraction,
    tooEarly: elapsedMinutes < MIN_ELAPSED_MINUTES,
  };
}
