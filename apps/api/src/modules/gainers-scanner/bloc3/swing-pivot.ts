/**
 * BLOC 3 — Swing high/low N=5 (Bulkowski 2021) + retracement Fibonacci.
 *
 * Pivot swing high : bougie[i].high est le plus haut des N bougies centrées sur i.
 * Pivot swing low  : bougie[i].low  est le plus bas  des N bougies centrées sur i.
 *
 * Avec N=5 (2 bougies à gauche, 2 à droite) : pattern Bulkowski recommandé.
 * Le dernier pivot disponible est utilisé comme référence pour le pullback.
 *
 * Niveaux Fibonacci : 38.2%, 50%, 61.8% du range [swingLow, swingHigh].
 * Le niveau atteint est celui dont le prix est le plus proche.
 */

export interface SwingPivot {
  index: number;
  price: number;
}

export interface FiboLevels {
  level382: number;
  level500: number;
  level618: number;
}

export interface SwingPivotResult {
  swingHigh: SwingPivot | null;
  swingLow: SwingPivot | null;
  fiboLevels: FiboLevels | null;
  /**
   * Issue #193 — diagnostic when pivots not found:
   * - CANDLE_COUNT_BELOW_9 : moins de 9 bougies (besoin 5+5-1 chevauchés)
   * - INSUFFICIENT_SWING_AMPLITUDE : pivots existent mais swingHigh ≤ swingLow
   * - NOISE_TOO_HIGH : aucune bougie ne bat ses voisines
   * null si swingHigh ET swingLow détectés avec amplitude valide.
   */
  noPivotReason: 'CANDLE_COUNT_BELOW_9' | 'INSUFFICIENT_SWING_AMPLITUDE' | 'NOISE_TOO_HIGH' | null;
}

const N_HALF = 2;

function findLastSwingHigh(highs: number[]): SwingPivot | null {
  for (let i = highs.length - N_HALF - 1; i >= N_HALF; i--) {
    const pivot = highs[i];
    let isHigh = true;
    for (let j = i - N_HALF; j <= i + N_HALF; j++) {
      if (j !== i && highs[j] >= pivot) { isHigh = false; break; }
    }
    if (isHigh) return { index: i, price: pivot };
  }
  return null;
}

function findLastSwingLow(lows: number[]): SwingPivot | null {
  for (let i = lows.length - N_HALF - 1; i >= N_HALF; i--) {
    const pivot = lows[i];
    let isLow = true;
    for (let j = i - N_HALF; j <= i + N_HALF; j++) {
      if (j !== i && lows[j] <= pivot) { isLow = false; break; }
    }
    if (isLow) return { index: i, price: pivot };
  }
  return null;
}

export function computeSwingPivots(
  highs: number[],
  lows: number[],
): SwingPivotResult {
  // Need at least 9 candles for 2 non-overlapping N=5 pivots
  // (5+5-1 = 9 with shared center, or 10 fully separated).
  if (highs.length < 9 || lows.length < 9) {
    return {
      swingHigh: null,
      swingLow: null,
      fiboLevels: null,
      noPivotReason: 'CANDLE_COUNT_BELOW_9',
    };
  }

  const swingHigh = findLastSwingHigh(highs);
  const swingLow = findLastSwingLow(lows);

  if (!swingHigh || !swingLow) {
    // At least one pivot was never validated by neighbors → noisy/flat series
    return {
      swingHigh,
      swingLow,
      fiboLevels: null,
      noPivotReason: 'NOISE_TOO_HIGH',
    };
  }

  if (swingHigh.price <= swingLow.price) {
    // Both pivots exist but swingHigh below or equal to swingLow → degenerate
    return {
      swingHigh,
      swingLow,
      fiboLevels: null,
      noPivotReason: 'INSUFFICIENT_SWING_AMPLITUDE',
    };
  }

  const range = swingHigh.price - swingLow.price;
  const fiboLevels: FiboLevels = {
    level382: swingHigh.price - 0.382 * range,
    level500: swingHigh.price - 0.500 * range,
    level618: swingHigh.price - 0.618 * range,
  };

  return { swingHigh, swingLow, fiboLevels, noPivotReason: null };
}

/** Retourne le niveau Fibonacci (38.2, 50, 61.8) le plus proche du prix courant. */
export function nearestFiboLevel(
  price: number,
  levels: FiboLevels,
): 38.2 | 50 | 61.8 {
  const dists: [38.2 | 50 | 61.8, number][] = [
    [38.2, Math.abs(price - levels.level382)],
    [50,   Math.abs(price - levels.level500)],
    [61.8, Math.abs(price - levels.level618)],
  ];
  return dists.reduce((best, cur) => (cur[1] < best[1] ? cur : best))[0];
}
