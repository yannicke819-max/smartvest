/**
 * BLOC 1 — Composite scorer (ADR-005, recalibré PR #362 data-driven).
 *
 * Combine 3 dimensions normalisées en un score [0..1] :
 *   - Persistance multi-TF
 *   - Momentum 1m (changePct1m, normalisé sur un plafond)
 *   - Volatilité inverse (ATR/close ramené sur la clamp)
 *
 * PR #362 — Recalibrage data-driven (basé sur 251 positions fermées, 14j mai 2026,
 * jointes avec leurs shadow signals) :
 *
 *   1. momentumNormalizationCeiling 0.10 → 0.25 : tout candidat asia/eu avec
 *      changePct1m >= 10% saturait le component à 1.0 (30/31 positions du
 *      19 mai avaient score=1.000). Nouveau plafond 25% permet de différencier
 *      les bursts (15-25%) des super-bursts (25+%).
 *
 *   2. Poids per-class : les classes n'ont pas le même signal d'edge.
 *      Mesures empiriques (Δ moyenne TP vs SL sur 14j) :
 *        - eu_equity  : ch1m discrimine fort (+3.47), persistance neutre
 *          → poids momentum 0.55, persistance 0.25
 *        - us_equity_large : persistance discrimine fort (+0.121), ch1m
 *          INVERSÉ (-0.52 = high momentum = trap)
 *          → poids momentum 0.25, persistance 0.55
 *        - asia_equity : ch1m discrimine modéré (+1.71)
 *          → poids momentum 0.40, persistance 0.40
 *        - us_equity_small_mid : ch1m faible (+0.52)
 *          → poids momentum 0.35, persistance 0.45
 *        - autres (crypto, fx, commodity, sample insuffisant) : poids default
 *
 *   3. Boost momentum non-linéaire : si changePct1m franchit un seuil de
 *      conviction par classe ET la classe en bénéficie historiquement,
 *      multiplier le score final par momentumBoostMultiplier.
 *
 *      Mesures par bucket :
 *        - eu : ch1m ≥ 10% → WR 54-58% vs <10% = 29% (+25pp) → boost ≥10 ×1.25
 *        - asia : ch1m ≥ 15% → WR 39% vs <15% = 25% (+14pp) → boost ≥15 ×1.20
 *        - us_large : ch1m ≥ 10% → WR 40% vs <10% = 28% (+12pp) → boost ≥10 ×1.15
 *
 * Compatibilité : si assetClass absent OU classe absente de perClassWeights,
 * fallback sur weightPersistence/weightMomentum/weightVolatilityInv (default
 * historique 0.5/0.3/0.2 inchangé pour les tests de régression).
 */

import type {
  GainersAssetClass,
  GainersCandidateRaw,
} from '../domain/gainers-candidate.types';

export interface CompositeScorerWeights {
  weightPersistence: number;
  weightMomentum: number;
  weightVolatilityInv: number;
}

export interface MomentumBoostRule {
  /** Seuil changePct1m à franchir (en pct absolu, ex : 10 pour 10%). */
  threshold: number;
  /** Facteur multiplicatif appliqué au score final si franchi. */
  multiplier: number;
}

export interface CompositeScorerConfig extends CompositeScorerWeights {
  /** Plafond de normalisation du momentum (PR #362 : default 0.25 = 25%, ex-0.10). */
  momentumNormalizationCeiling: number;
  /** ATR clamp utilisé pour la volatilité inverse (défaut 0.15). */
  volatilityClampMaxAtrRel: number;
  /**
   * PR6.6.6 — Shadow mode best-effort scoring (cf. doc historique).
   * Default false : prod strict ADR-005 §1bis.
   */
  shadowAllowPartialScore?: boolean;
  /**
   * PR #362 — Poids spécifiques par asset class. Si raw.assetClass est
   * présent ET défini ici, ces poids remplacent les poids globaux.
   * Sinon fallback sur weightPersistence/weightMomentum/weightVolatilityInv.
   */
  perClassWeights?: Partial<Record<GainersAssetClass, CompositeScorerWeights>>;
  /**
   * PR #362 — Boost momentum non-linéaire par classe. Appliqué APRÈS calcul
   * du score pondéré, avant clamp01. Si raw.changePct1m >= threshold,
   * score *= multiplier (cap à 1.0).
   */
  perClassMomentumBoost?: Partial<Record<GainersAssetClass, MomentumBoostRule>>;
}

/**
 * PR #362 — Poids per-class data-driven.
 * Mesures : 251 positions fermées sur 14 jours (5-19 mai 2026), shadow signals
 * joints sur (symbol, entry_timestamp ±5min/+20min), filtre decision='accept'.
 *
 * Critère de sélection des poids :
 *   - Δ moyenne_TP_vs_SL sur chaque dimension par classe
 *   - Bucket WR par dimension pour valider le sens et la magnitude
 *   - Sample min 25 positions/classe (crypto sample 9 → garde default)
 */
export const DEFAULT_PER_CLASS_WEIGHTS: NonNullable<
  CompositeScorerConfig['perClassWeights']
> = {
  // eu : ch1m TP=18.53 vs SL=15.06 (Δ +3.47). Persistance inverse (TP<SL).
  // Bucket 10-15: WR 54%, 25+: WR 58%, 5-10: 29% → momentum dominant.
  eu_equity: {
    weightMomentum: 0.55,
    weightPersistence: 0.25,
    weightVolatilityInv: 0.2,
  },
  // us_large : ch1m INVERSÉ (TP=7.06 vs SL=7.58, Δ -0.52).
  // Persistence TP=0.969 vs SL=0.848 (Δ +0.121, le plus fort signal mesuré).
  // → bascule sur persistance dominante.
  us_equity_large: {
    weightMomentum: 0.25,
    weightPersistence: 0.55,
    weightVolatilityInv: 0.2,
  },
  // asia : ch1m TP=12.67 vs SL=10.96 (Δ +1.71). Persistence TP=0.987 vs SL=0.943 (Δ +0.044).
  // Bucket 15-25: WR 39%, 10-15: 29%, 5-10: 24% → momentum modéré utile.
  asia_equity: {
    weightMomentum: 0.4,
    weightPersistence: 0.4,
    weightVolatilityInv: 0.2,
  },
  // us_small_mid : ch1m TP=13.00 vs SL=12.48 (Δ +0.52, faible).
  // Persistence TP=0.875 vs SL=0.920 (Δ -0.045, inversé).
  // → conservateur, momentum modéré, défaut sur persistance.
  us_equity_small_mid: {
    weightMomentum: 0.35,
    weightPersistence: 0.45,
    weightVolatilityInv: 0.2,
  },
};

/**
 * PR #362 — Boost momentum non-linéaire par classe.
 * Seuils issus des buckets ch1m mesurés par classe : on déclenche le boost
 * uniquement quand le bucket franchit un WR significativement supérieur à la
 * baseline classe.
 *
 * Multipliers conservateurs (×1.15 à ×1.25) : on cap le score à 1.0 de toute
 * façon. L'effet réel = remonter dans le ranking les candidats à fort momentum.
 */
export const DEFAULT_PER_CLASS_MOMENTUM_BOOST: NonNullable<
  CompositeScorerConfig['perClassMomentumBoost']
> = {
  // eu : bucket 10-15 WR 54%, 25+ WR 58% vs 5-10 WR 29% → break ≥10
  eu_equity: { threshold: 10, multiplier: 1.25 },
  // asia : bucket 15-25 WR 39% vs <15 WR 25% → break ≥15 (le 25+ sample 6 est noisy)
  asia_equity: { threshold: 15, multiplier: 1.2 },
  // us_large : bucket 10-15 WR 40% vs 5-10 WR 31% → break ≥10 boost modéré
  us_equity_large: { threshold: 10, multiplier: 1.15 },
  // us_small_mid : pattern inversé (5-10 WR 36% > 10-15 WR 14%) → PAS de boost
  // crypto / fx / commodity : sample insuffisant → PAS de boost
};

export const DEFAULT_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  // Poids globaux fallback (identiques à l'historique ADR-005)
  weightPersistence: 0.5,
  weightMomentum: 0.3,
  weightVolatilityInv: 0.2,
  // PR #362 : plafond 0.25 (ex-0.10) — anti-saturation asia/eu
  momentumNormalizationCeiling: 0.25,
  volatilityClampMaxAtrRel: 0.15,
  shadowAllowPartialScore: false,
  // PR #362 : data-driven per-class
  perClassWeights: DEFAULT_PER_CLASS_WEIGHTS,
  perClassMomentumBoost: DEFAULT_PER_CLASS_MOMENTUM_BOOST,
};

/**
 * PR6.6.6 — Composite scorer config pour shadow run.
 * Identique à DEFAULT mais shadowAllowPartialScore=true.
 */
export const SHADOW_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  ...DEFAULT_COMPOSITE_SCORER_CONFIG,
  shadowAllowPartialScore: true,
};

/**
 * PR #362 — Legacy config pour tests de régression : ceiling 0.10, poids
 * globaux 0.5/0.3/0.2, pas de per-class, pas de boost. Conserve l'ancien
 * comportement bit-perfect pour les specs PR6.6.x avant recalibrage.
 */
export const LEGACY_COMPOSITE_SCORER_CONFIG: CompositeScorerConfig = {
  weightPersistence: 0.5,
  weightMomentum: 0.3,
  weightVolatilityInv: 0.2,
  momentumNormalizationCeiling: 0.1,
  volatilityClampMaxAtrRel: 0.15,
  shadowAllowPartialScore: false,
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * PR #362 — Résout les poids à utiliser pour ce candidat.
 * Si raw.assetClass existe ET cfg.perClassWeights[class] défini → per-class.
 * Sinon → poids globaux (weightPersistence/weightMomentum/weightVolatilityInv).
 */
function resolveWeights(
  raw: GainersCandidateRaw,
  cfg: CompositeScorerConfig,
): CompositeScorerWeights {
  if (raw.assetClass && cfg.perClassWeights) {
    const cls = cfg.perClassWeights[raw.assetClass];
    if (cls) {
      return cls;
    }
  }
  return {
    weightPersistence: cfg.weightPersistence,
    weightMomentum: cfg.weightMomentum,
    weightVolatilityInv: cfg.weightVolatilityInv,
  };
}

/**
 * PR #362 — Applique le boost momentum non-linéaire si la classe a un boost
 * configuré ET changePct1m franchit le seuil. Cap à 1.0.
 *
 * Note : changePct1m peut être stocké en valeur fractionnaire (0.10 = 10%)
 * ou en pourcentage absolu (10 = 10%). La table gainers_user_shadow_signals
 * stocke en absolu (ch1m_tp_avg=18 = 18%). Côté code, changePct1m est en
 * fractionnaire (cf. momentumNormalizationCeiling=0.10 ex). On uniformise :
 * thresholds dans MomentumBoostRule sont exprimés en POURCENTAGE ABSOLU.
 */
function applyMomentumBoost(
  scoreBeforeBoost: number,
  raw: GainersCandidateRaw,
  cfg: CompositeScorerConfig,
): number {
  if (!raw.assetClass || !cfg.perClassMomentumBoost) {
    return scoreBeforeBoost;
  }
  const rule = cfg.perClassMomentumBoost[raw.assetClass];
  if (!rule) {
    return scoreBeforeBoost;
  }
  // changePct1m est en fractionnaire (0.20 = 20%). On compare en absolu.
  const changePctAbs = raw.changePct1m * 100;
  if (changePctAbs >= rule.threshold) {
    return clamp01(scoreBeforeBoost * rule.multiplier);
  }
  return scoreBeforeBoost;
}

/**
 * Calcule le score composite [0..1].
 *
 * Mode strict (default) : retourne null si persistence ou atr absents
 * (ADR-005 §1bis prod).
 *
 * Mode shadow PR6.6.6 (cfg.shadowAllowPartialScore=true) :
 *   - Calcule sur composants disponibles avec missing-penalty
 *   - Per-class et boost appliqués UNIQUEMENT en mode strict (tous composants
 *     présents), car le shadow partial sert à diagnostiquer la complétude
 *     données, pas à scorer pour décision réelle.
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
    const weights = resolveWeights(raw, cfg);
    const persistenceComponent = clamp01(raw.persistenceScore!);
    const volatilityInvComponent =
      1 - clamp01(raw.atrDailyRelative! / cfg.volatilityClampMaxAtrRel);
    const weighted =
      weights.weightPersistence * persistenceComponent +
      weights.weightMomentum * momentumComponent +
      weights.weightVolatilityInv * volatilityInvComponent;
    const scoreBeforeBoost = clamp01(weighted);
    return applyMomentumBoost(scoreBeforeBoost, raw, cfg);
  }

  // Mode shadow partial — PR6.6.6.1 missing-penalty (PAS renormalize)
  // PR #362 : on garde la logique partial historique (poids globaux fallback),
  // pas de per-class ici car features manquantes = diagnostic.
  let weightedSum = 0;
  weightedSum += cfg.weightMomentum * momentumComponent;
  if (persistenceAvail) {
    const persistenceComponent = clamp01(raw.persistenceScore!);
    weightedSum += cfg.weightPersistence * persistenceComponent;
  }
  if (atrAvail) {
    const volatilityInvComponent =
      1 - clamp01(raw.atrDailyRelative! / cfg.volatilityClampMaxAtrRel);
    weightedSum += cfg.weightVolatilityInv * volatilityInvComponent;
  }
  return clamp01(weightedSum);
}
