/**
 * P9-UX ADDENDUM — Path quality / smoothness metrics.
 *
 * Détecte la **monotonie** d'une montée de prix sur une fenêtre temporelle.
 * Une montée +5% qui se déroule en ligne droite n'a pas le même profil
 * de risque qu'une montée +5% avec rebonds violents.
 *
 * Métriques calculées sur série de prix consécutifs (typiquement bougies
 * 1m sur les fenêtres 5/10/15/30/60 min):
 *
 *   pathEfficiency = |end - start| / Σ|p_i - p_{i-1}|     ∈ [0, 1]
 *     1.0 = monotone parfait, 0 = aléatoire complet
 *
 *   pullbackDepth  = (max - minAfterMax) / max            ∈ [0, ∞[
 *     Profondeur du pullback maximal après le sommet, en fraction
 *
 *   monotonicity   = #candles positives / #candles totales ∈ [0, 1]
 *
 *   smoothnessLabel : 'smooth' | 'mixed' | 'choppy' (rule-based)
 *
 * Pure : pas d'I/O, testable en isolation.
 */

/** 'idle' = série plate (Σ|Δp|=0) : marché fermé ou données figées — pas un jugement de qualité. */
export type SmoothnessLabel = 'smooth' | 'mixed' | 'choppy' | 'idle';

export interface PathQualityMetrics {
  pathEfficiency: number;
  pullbackDepth: number;
  monotonicity: number;
  smoothnessLabel: SmoothnessLabel;
  /** Nombre de prix utilisés (sample size). */
  n: number;
}

/**
 * Calcule path efficiency : |end - start| / sum(|p_i - p_{i-1}|).
 * Si la somme des variations est 0 (prix constant) → 1 (parfait).
 * Edge cases : moins de 2 prix → null (donnée insuffisante).
 */
export function computePathEfficiency(prices: number[]): number | null {
  if (prices.length < 2) return null;
  const start = prices[0];
  const end = prices[prices.length - 1];
  let totalVariation = 0;
  for (let i = 1; i < prices.length; i++) {
    totalVariation += Math.abs(prices[i] - prices[i - 1]);
  }
  if (totalVariation === 0) return 1; // prix constant = parfait monotone
  return Math.abs(end - start) / totalVariation;
}

/**
 * Pullback depth = (max - minAfterMax) / max. Capture la profondeur du
 * plus grand drawdown SUR le sommet max de la fenêtre.
 * Edge case : max = first price → 0 (pas de sommet atteint, pas de pullback)
 */
export function computePullbackDepth(prices: number[]): number {
  if (prices.length < 2) return 0;
  let maxPrice = prices[0];
  let maxIdx = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > maxPrice) {
      maxPrice = prices[i];
      maxIdx = i;
    }
  }
  if (maxIdx === prices.length - 1) {
    // Max atteint à la fin → pas de pullback observé
    return 0;
  }
  let minAfterMax = prices[maxIdx + 1];
  for (let i = maxIdx + 2; i < prices.length; i++) {
    if (prices[i] < minAfterMax) minAfterMax = prices[i];
  }
  if (maxPrice === 0) return 0;
  return Math.max(0, (maxPrice - minAfterMax) / maxPrice);
}

/**
 * Monotonicity = % de bougies positives (close > open ou prev) sur la série.
 * Edge case : moins de 2 prix → 0.
 */
export function computeMonotonicity(prices: number[]): number {
  if (prices.length < 2) return 0;
  let positive = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) positive++;
  }
  return positive / (prices.length - 1);
}

/**
 * Classification rule-based :
 *   smooth : efficiency ≥ 0.7 ET pullback ≤ 1%
 *   choppy : efficiency < 0.4 OU pullback > 2%
 *   mixed  : entre les deux
 */
export function classifySmoothness(
  efficiency: number,
  pullback: number,
): SmoothnessLabel {
  if (efficiency >= 0.7 && pullback <= 0.01) return 'smooth';
  if (efficiency < 0.4 || pullback > 0.02) return 'choppy';
  return 'mixed';
}

/**
 * Helper de bout-en-bout : prend une série de prix → retourne metrics.
 * Si la série est trop courte (< 2) → null.
 */
export function evaluatePathQuality(prices: number[]): PathQualityMetrics | null {
  if (prices.length < 2) return null;
  const eff = computePathEfficiency(prices);
  if (eff === null) return null;
  const pullback = computePullbackDepth(prices);
  const monotonicity = computeMonotonicity(prices);

  // Flat series: Σ|Δp|=0 means all prices identical (market closed / data frozen).
  // computePathEfficiency returns 1 for flat, which would be misclassified as 'smooth'.
  let totalVariation = 0;
  for (let i = 1; i < prices.length; i++) totalVariation += Math.abs(prices[i] - prices[i - 1]);
  const isFlat = totalVariation === 0;

  return {
    pathEfficiency: eff,
    pullbackDepth: pullback,
    monotonicity,
    smoothnessLabel: isFlat ? 'idle' : classifySmoothness(eff, pullback),
    n: prices.length,
  };
}

/**
 * Pour un set de candles 1-min, calcule la path quality sur la fenêtre
 * des N dernières minutes. Utilisé par le scanner pour évaluer la
 * "smoothness" sur 5m, 10m, 15m, 30m, 60m.
 */
export function evaluateWindowPathQuality(
  candles: Array<{ close: number }>,
  windowMinutes: number,
): PathQualityMetrics | null {
  if (candles.length < 2) return null;
  const sliceStart = Math.max(0, candles.length - windowMinutes - 1);
  const slice = candles.slice(sliceStart);
  const prices = slice
    .map((c) => c.close)
    .filter((p) => Number.isFinite(p) && p > 0);
  return evaluatePathQuality(prices);
}
