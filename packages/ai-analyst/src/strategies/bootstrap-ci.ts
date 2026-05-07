/**
 * Bootstrap confidence interval pour la moyenne.
 *
 * PR #280 — Utilisé par le shadow user-pipeline pour décider si un gate
 * est over-strict (CI lower > 0 → on rate de l'argent en moyenne) ou
 * healthy (CI upper < 0 → le gate filtre des trades perdants).
 *
 * Pourquoi bootstrap (pas t-test) : la distribution PnL/trade est
 * fortement asymétrique (TP plafond, SL plancher, queue gauche fat-tail
 * sur les bizarreries d'execution). Le bootstrap est non-paramétrique,
 * pas de hypothèse normalité, robuste aux outliers.
 *
 * Méthode : percentile bootstrap (Efron 1979). Ré-échantillonne avec
 * remise B fois, calcule la moyenne sur chaque échantillon, prend les
 * quantiles 2.5% et 97.5%.
 */

export interface BootstrapResult {
  mean: number;
  ciLow: number;        // 2.5 percentile bootstrap mean
  ciHigh: number;       // 97.5 percentile bootstrap mean
  n: number;            // sample size
  iterations: number;   // B
}

/**
 * Mulberry32 deterministic PRNG. Permet d'avoir des CI reproductibles
 * dans les tests (même seed → mêmes résultats). En prod on accepte
 * Math.random (légèrement variable mais 1000 itérations stabilisent).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCI(
  samples: readonly number[],
  options: { iterations?: number; alpha?: number; seed?: number } = {},
): BootstrapResult {
  const n = samples.length;
  if (n === 0) {
    return { mean: 0, ciLow: 0, ciHigh: 0, n: 0, iterations: 0 };
  }
  if (n === 1) {
    return { mean: samples[0], ciLow: samples[0], ciHigh: samples[0], n: 1, iterations: 0 };
  }

  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = options.seed != null ? mulberry32(options.seed) : Math.random;

  const mean = samples.reduce((acc, x) => acc + x, 0) / n;

  const bootMeans = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += samples[idx];
    }
    bootMeans[b] = sum / n;
  }

  bootMeans.sort();
  const lowIdx = Math.floor(iterations * (alpha / 2));
  const highIdx = Math.ceil(iterations * (1 - alpha / 2)) - 1;
  const ciLow = bootMeans[Math.max(0, lowIdx)];
  const ciHigh = bootMeans[Math.min(iterations - 1, highIdx)];

  return { mean, ciLow, ciHigh, n, iterations };
}

/**
 * Verdict pour un gate du shadow user-pipeline.
 *
 *   - INSUFFICIENT_DATA : n < threshold (default 100)
 *   - GATE_TOO_STRICT   : CI ne contient pas 0 ET ciLow > 0
 *                          → en moyenne ces rejets auraient été profitables
 *   - GATE_HEALTHY      : CI ne contient pas 0 ET ciHigh < 0
 *                          → en moyenne ces rejets auraient perdu de l'argent
 *   - INCONCLUSIVE      : CI traverse 0 (pas de signal statistique fort)
 */
export type GateVerdict =
  | 'INSUFFICIENT_DATA'
  | 'GATE_TOO_STRICT'
  | 'GATE_HEALTHY'
  | 'INCONCLUSIVE';

export function verdictFromCI(
  result: BootstrapResult,
  options: { minN?: number } = {},
): GateVerdict {
  const minN = options.minN ?? 100;
  if (result.n < minN) return 'INSUFFICIENT_DATA';
  if (result.ciLow > 0) return 'GATE_TOO_STRICT';
  if (result.ciHigh < 0) return 'GATE_HEALTHY';
  return 'INCONCLUSIVE';
}
