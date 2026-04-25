/**
 * Génération et expansion de la grille de configs candidates.
 *
 * Le produit cartésien complet peut exploser : 3×3×3×3×3 = 243 configs.
 * On limite à `maxCandidates` (défaut 30) en sélectionnant les variations
 * orthogonales — un point central + variations 1D autour. Plus efficace
 * qu'un grid search dense, et moins susceptible à la malédiction
 * dimensionnelle.
 */

import type { OptimizerCandidate, SearchSpace } from './types';

/**
 * Expand naïvement le produit cartésien complet.
 * À utiliser uniquement si le résultat n'excède pas maxCandidates.
 */
export function expandCartesian(space: SearchSpace): OptimizerCandidate[] {
  const out: OptimizerCandidate[] = [];
  for (const ac of space.antiConsensusStrengths) {
    for (const mp of space.maxPositionSizePcts) {
      for (const ma of space.maxAssetClassExposurePcts) {
        for (const sl of space.stopLossPcts) {
          for (const tp of space.takeProfitPcts) {
            out.push({
              antiConsensusStrength: ac,
              maxPositionSizePct: mp,
              maxAssetClassExposurePct: ma,
              stopLossPct: sl,
              takeProfitPct: tp,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Stratégie « centre + axes » : prend la valeur médiane de chaque dimension,
 * puis génère des variantes en faisant varier UNE seule dimension à la fois.
 *
 * Pour 5 dimensions × 3 valeurs : 1 (centre) + 5×2 (variations) = 11 configs.
 * Bien plus exploitable que les 243 du cartésien, et capture déjà les
 * sensibilités principales par dimension.
 */
export function expandOrthogonal(space: SearchSpace): OptimizerCandidate[] {
  const median = <T>(arr: T[]): T => arr[Math.floor(arr.length / 2)];

  const center: OptimizerCandidate = {
    antiConsensusStrength: median(space.antiConsensusStrengths),
    maxPositionSizePct: median(space.maxPositionSizePcts),
    maxAssetClassExposurePct: median(space.maxAssetClassExposurePcts),
    stopLossPct: median(space.stopLossPcts),
    takeProfitPct: median(space.takeProfitPcts),
  };

  const candidates: OptimizerCandidate[] = [center];
  const seen = new Set<string>([keyOf(center)]);

  // Variations 1D autour du centre
  for (const v of space.antiConsensusStrengths) {
    const c = { ...center, antiConsensusStrength: v };
    if (!seen.has(keyOf(c))) { candidates.push(c); seen.add(keyOf(c)); }
  }
  for (const v of space.maxPositionSizePcts) {
    const c = { ...center, maxPositionSizePct: v };
    if (!seen.has(keyOf(c))) { candidates.push(c); seen.add(keyOf(c)); }
  }
  for (const v of space.maxAssetClassExposurePcts) {
    const c = { ...center, maxAssetClassExposurePct: v };
    if (!seen.has(keyOf(c))) { candidates.push(c); seen.add(keyOf(c)); }
  }
  for (const v of space.stopLossPcts) {
    const c = { ...center, stopLossPct: v };
    if (!seen.has(keyOf(c))) { candidates.push(c); seen.add(keyOf(c)); }
  }
  for (const v of space.takeProfitPcts) {
    const c = { ...center, takeProfitPct: v };
    if (!seen.has(keyOf(c))) { candidates.push(c); seen.add(keyOf(c)); }
  }

  return candidates;
}

/**
 * Sélection automatique : cartésien si <= maxCandidates, sinon orthogonal.
 */
export function expandSearchSpace(
  space: SearchSpace,
  maxCandidates: number,
): OptimizerCandidate[] {
  const cart = expandCartesian(space);
  if (cart.length <= maxCandidates) return cart;
  const ortho = expandOrthogonal(space);
  return ortho.slice(0, maxCandidates);
}

function keyOf(c: OptimizerCandidate): string {
  return `${c.antiConsensusStrength}|${c.maxPositionSizePct}|${c.maxAssetClassExposurePct}|${c.stopLossPct}|${c.takeProfitPct}`;
}

/** Search space par défaut — calibré pour le profil sniper actuel. */
export const DEFAULT_SEARCH_SPACE: SearchSpace = {
  antiConsensusStrengths: [3, 5, 7],
  maxPositionSizePcts: [6, 8, 10],
  maxAssetClassExposurePcts: [15, 20, 25],
  stopLossPcts: [1.5, 2, 3],
  takeProfitPcts: [3, 4, 6],
};
