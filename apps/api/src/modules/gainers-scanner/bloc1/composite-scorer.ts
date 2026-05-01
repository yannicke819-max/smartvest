/**
 * BLOC 1 — Composite scorer (ADR-005).
 *
 * Combine 3 dimensions normalisées en un score [0..1] :
 *   - Persistance multi-TF (pondération 50%)
 *   - Momentum 1m (pondération 30%, normalisé sur 10% comme plafond)
 *   - Volatilité inverse (pondération 20%, ATR/close ramené sur la clamp)
 *
 * Pas de RVOL ici — il sera inclus en BLOC 2 quand les baselines seront wirées.
 */

import type { GainersCandidateRaw } from '../domain/gainers-candidate.types';

export interface CompositeScorerConfig {
  /** Poids persistance (défaut 0.5). */
  weightPersistence: number;
  /** Poids momentum (défaut 0.3). */
  weightMomentum: number;
  /** Poids volatilité inverse (défaut 0.2). */
  weightVolatilityInv: number;
  /** Plafond de normalisation du momentum (défaut 0.10 = 10%). */
  momentumNormalizationCeiling: number;
  /** ATR clamp utilisé pour la volatilité inverse (défaut 0.15). */
  volatilityClampMaxAtrRel: number;
}

export const DEFAULT_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  weightPersistence: 0.5,
  weightMomentum: 0.3,
  weightVolatilityInv: 0.2,
  momentumNormalizationCeiling: 0.1,
  volatilityClampMaxAtrRel: 0.15,
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Calcule le score composite [0..1]. Retourne null si données insuffisantes
 * (persistence ou volatilité absentes — sinon le score serait artificiellement gonflé).
 */
export function computeCompositeScore(
  raw: GainersCandidateRaw,
  cfg: CompositeScorerConfig,
): number | null {
  if (raw.persistenceScore === null || raw.atrDailyRelative === null) return null;

  const persistenceComponent = clamp01(raw.persistenceScore);
  const momentumComponent = clamp01(raw.changePct1m / cfg.momentumNormalizationCeiling);
  const volatilityInvComponent = 1 - clamp01(raw.atrDailyRelative / cfg.volatilityClampMaxAtrRel);

  const weighted =
    cfg.weightPersistence * persistenceComponent +
    cfg.weightMomentum * momentumComponent +
    cfg.weightVolatilityInv * volatilityInvComponent;

  return clamp01(weighted);
}
