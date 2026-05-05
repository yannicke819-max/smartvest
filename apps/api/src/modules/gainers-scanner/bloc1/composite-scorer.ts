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
  /**
   * PR6.6.6 — Shadow mode best-effort scoring : si true ET persistenceScore
   * ou atrDailyRelative null, calcule un score partiel basé uniquement sur
   * les composants disponibles (renormalisation des poids).
   *
   * Default false : préserve comportement strict prod (ADR-005 §1bis : un
   * score partiel pourrait être trompeur). Activable uniquement via
   * SHADOW_BLOC1_FULL_CONFIG (PR6.6.5).
   *
   * Effet : composite_score n'est plus null pour les ACCEPT shadow → ranking
   * possible + AutoTuner V2 a un score à analyser. Le score est marqué
   * "partial" via la convention que persistence ou atr étaient null
   * (audit via gainers_v1_shadow_signals.composite_score IS NOT NULL +
   * raw fields stored elsewhere si needed).
   */
  shadowAllowPartialScore?: boolean;
}

export const DEFAULT_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  weightPersistence: 0.5,
  weightMomentum: 0.3,
  weightVolatilityInv: 0.2,
  momentumNormalizationCeiling: 0.1,
  volatilityClampMaxAtrRel: 0.15,
  shadowAllowPartialScore: false,
};

/**
 * PR6.6.6 — Composite scorer config pour shadow run.
 * Identique à DEFAULT mais shadowAllowPartialScore=true → calcule score
 * best-effort même avec persistence ou atr null.
 */
export const SHADOW_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  ...DEFAULT_COMPOSITE_SCORER_CONFIG,
  shadowAllowPartialScore: true,
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Calcule le score composite [0..1].
 *
 * Mode strict (default) : retourne null si persistence ou atr absents
 * (ADR-005 §1bis prod : score partiel = trompeur).
 *
 * Mode shadow PR6.6.6 (cfg.shadowAllowPartialScore=true) :
 *   - Calcule le score sur les composants disponibles uniquement
 *   - PR6.6.6.1 : missing-penalty (PAS renormalize) → score reflète
 *     la complétude des données. Max possible :
 *       - momentum only :          0.3 (= weightMomentum)
 *       - momentum + atr :         0.5 (= weightMomentum + weightVolatilityInv)
 *       - momentum + persistence : 0.8 (= weightMomentum + weightPersistence)
 *       - tous présents :          1.0
 *
 *   - Avantage vs renormalize : ranking préservé (full > partial),
 *     AutoTuner V2 trie par confidence, évite l'artifact "tous ACCEPT
 *     shadow à 1.000" observé sur smoke test Q2 (changePct1m ≥ 10% +
 *     persistence/atr null → renormalize donnait 1.0 systématique).
 *
 *   - Garde-fou implicite : un ACCEPT shadow avec score < 0.3 = bug
 *     (momentum manquant impossible). Score 0.3 = momentum max only.
 *
 * Note : changePct1m (momentum) est TOUJOURS disponible (vient du screener).
 */
export function computeCompositeScore(
  raw: GainersCandidateRaw,
  cfg: CompositeScorerConfig,
): number | null {
  const persistenceAvail = raw.persistenceScore !== null;
  const atrAvail = raw.atrDailyRelative !== null;

  // Mode strict : null si features manquantes
  if (!cfg.shadowAllowPartialScore && (!persistenceAvail || !atrAvail)) {
    return null;
  }

  const momentumComponent = clamp01(raw.changePct1m / cfg.momentumNormalizationCeiling);

  // Mode strict ou shadow avec tous composants présents
  if (persistenceAvail && atrAvail) {
    const persistenceComponent = clamp01(raw.persistenceScore!);
    const volatilityInvComponent = 1 - clamp01(raw.atrDailyRelative! / cfg.volatilityClampMaxAtrRel);
    const weighted =
      cfg.weightPersistence * persistenceComponent +
      cfg.weightMomentum * momentumComponent +
      cfg.weightVolatilityInv * volatilityInvComponent;
    return clamp01(weighted);
  }

  // Mode shadow partial — PR6.6.6.1 missing-penalty (PAS renormalize)
  let weightedSum = 0;

  // Momentum (toujours dispo via changePct1m)
  weightedSum += cfg.weightMomentum * momentumComponent;

  if (persistenceAvail) {
    const persistenceComponent = clamp01(raw.persistenceScore!);
    weightedSum += cfg.weightPersistence * persistenceComponent;
  }

  if (atrAvail) {
    const volatilityInvComponent = 1 - clamp01(raw.atrDailyRelative! / cfg.volatilityClampMaxAtrRel);
    weightedSum += cfg.weightVolatilityInv * volatilityInvComponent;
  }

  return clamp01(weightedSum);
}
