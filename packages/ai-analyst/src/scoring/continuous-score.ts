/**
 * PR #351 — Scoring discriminant continu [0..100]
 *
 * Remplace le ratio binaire positives/available (multi-tf-persistence) par un
 * score agrégeant amplitude (sigmoid chg vs cible classe), rvol (sigmoid avec
 * inversion us_sm pour FOMO), momentum 5m/15m/30m pondéré, persistence multi-TF
 * (existant clampé) et capQuality (bandes mcap Druckenmiller).
 *
 * Backed by 14j data analysis :
 *   - 96 513 candidats `filtered` avec score=0 (smoking gun 020560.KO :
 *     chg=16.94%, rvol=24.16x ignoré sur 477 snapshots consécutifs)
 *   - 269 opened sur 41 976 passed (0.19% taux d'ouverture)
 *   - Features TP vs SL discriminantes mesurées par classe (rvol asia,
 *     mcap us_large/us_sm, FOMO inverse us_sm)
 *
 * Activation via feature flag CONTINUOUS_SCORING_ENABLED côté scanner ;
 * fallback legacy si flag OFF.
 */

export type ScoringAssetClass =
  | 'asia_equity'
  | 'eu_equity'
  | 'us_equity_large'
  | 'us_equity_small_mid'
  | 'crypto_major';

export interface ScoreFeatures {
  /** top_gainers_log.change_pct, en % (ex : 16.94) */
  changePctSnapshot: number;
  /** volume / avg_vol_50d (ex : 24.16) */
  rvol: number;
  /** top_gainers_log.market_cap_usd, en USD */
  marketCapUsd: number | null;
  /** existant : positives/available, [0..1] */
  persistenceMultiTf: number;
  /** (close - close_5m_ago) / close_5m_ago, décimal (ex : 0.02 = +2%) */
  momentum5m: number | null;
  momentum15m: number | null;
  momentum30m: number | null;
  /** ATR(14) / close, optionnel — non utilisé v1 */
  atrNormalized: number | null;
}

export interface SubScores {
  amplitudeScore: number;     // [0..1]
  rvolScore: number;          // [0..1]
  momentumScore: number;      // [0..1]
  persistenceScore: number;   // [0..1]
  capQualityScore: number;    // [0..1]
}

export interface ScoreResult {
  total: number;              // [0..100]
  subScores: SubScores;
}

interface SubScoreWeights {
  amplitude: number;
  rvol: number;
  momentum: number;
  persistence: number;
  capQuality: number;
}

const AMPLITUDE_TARGET: Record<ScoringAssetClass, number> = {
  asia_equity: 10,
  eu_equity: 15,
  us_equity_large: 7,
  us_equity_small_mid: 15,
  crypto_major: 3,
};

const RVOL_TARGET: Record<ScoringAssetClass, number> = {
  asia_equity: 5,
  eu_equity: 5,
  us_equity_large: 3,
  us_equity_small_mid: 5, // inversé dans computeRvolScore
  crypto_major: 2,
};

const WEIGHTS: Record<ScoringAssetClass, SubScoreWeights> = {
  asia_equity: {
    amplitude: 0.20, rvol: 0.35, momentum: 0.20, persistence: 0.15, capQuality: 0.10,
  },
  eu_equity: {
    amplitude: 0.25, rvol: 0.20, momentum: 0.25, persistence: 0.20, capQuality: 0.10,
  },
  us_equity_large: {
    amplitude: 0.20, rvol: 0.15, momentum: 0.25, persistence: 0.10, capQuality: 0.30,
  },
  us_equity_small_mid: {
    amplitude: 0.20, rvol: 0.20, momentum: 0.20, persistence: 0.15, capQuality: 0.25,
  },
  crypto_major: {
    amplitude: 0.30, rvol: 0.10, momentum: 0.40, persistence: 0.15, capQuality: 0.05,
  },
};

const SIGMOID_K = 0.3; // pente sigmoid amplitude (courbe douce, pas de cliff)

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Sous-score amplitude : sigmoid logistique centrée sur la cible classe.
 * - asia (target=10) : chg=10% → 0.5, chg=20% → 0.95
 * - crypto (target=3) : chg=3% → 0.5, chg=10% → 0.88
 */
export function computeAmplitudeScore(changePct: number, assetClass: ScoringAssetClass): number {
  const target = AMPLITUDE_TARGET[assetClass];
  return 1 / (1 + Math.exp(-SIGMOID_K * (changePct - target)));
}

/**
 * Sous-score RVOL :
 * - us_equity_small_mid : INVERSE (rvol ≤3.5 = 1.0, décroissance linéaire
 *   jusqu'à rvol 8.5 = 0). FOMO penalty mesuré sur 14j (SL avg rvol 4.86
 *   vs TP avg rvol 3.27).
 * - autres classes : linéaire saturé à 1.0 au-dessus de RVOL_TARGET.
 */
export function computeRvolScore(rvol: number, assetClass: ScoringAssetClass): number {
  if (rvol <= 0) return 0;
  if (assetClass === 'us_equity_small_mid') {
    if (rvol <= 3.5) return 1.0;
    return Math.max(0, 1 - (rvol - 3.5) / 5);
  }
  const target = RVOL_TARGET[assetClass];
  return Math.min(1, rvol / target);
}

/**
 * Sous-score momentum : pondération 5m × 0.5 + 15m × 0.3 + 30m × 0.2.
 * Normalisation par TF : 5m=2%, 15m=5%, 30m=8% → 1.0 chacun.
 * Si certains TF sont null → repondération sur les disponibles.
 * Si TOUS null → 0.5 (neutre).
 */
export function computeMomentumScore(
  m5: number | null,
  m15: number | null,
  m30: number | null,
): number {
  if (m5 === null && m15 === null && m30 === null) return 0.5;
  const m5Norm = m5 === null ? 0 : clamp(m5 / 0.02, -1, 1);
  const m15Norm = m15 === null ? 0 : clamp(m15 / 0.05, -1, 1);
  const m30Norm = m30 === null ? 0 : clamp(m30 / 0.08, -1, 1);
  let totalWeight = 0;
  let weighted = 0;
  if (m5 !== null) { weighted += 0.5 * m5Norm; totalWeight += 0.5; }
  if (m15 !== null) { weighted += 0.3 * m15Norm; totalWeight += 0.3; }
  if (m30 !== null) { weighted += 0.2 * m30Norm; totalWeight += 0.2; }
  const raw = totalWeight > 0 ? weighted / totalWeight : 0;
  return (raw + 1) / 2; // [-1, 1] → [0, 1]
}

/** Sous-score persistence : ratio multi-TF existant clampé [0, 1]. */
export function computePersistenceSubScore(persistenceMultiTf: number): number {
  return clamp(persistenceMultiTf, 0, 1);
}

/**
 * Sous-score capQuality : bandes mcap Druckenmiller par classe.
 * - us_large : sweet spot 200-2000B (winners 14j avg=$334B), mega cap=0.7
 * - us_sm : sweet spot 0.3-10B (TP avg=$3.54B), penny<0.3B=0.2 (FOMO),
 *   drift>10B=0.5
 * - eu / asia / crypto : neutre 0.7 (mcap pas discriminant sur 14j)
 */
export function computeCapQualityScore(
  marketCapUsd: number | null,
  assetClass: ScoringAssetClass,
): number {
  if (marketCapUsd === null || marketCapUsd <= 0) return 0.5;
  const mcap = marketCapUsd / 1e9;
  switch (assetClass) {
    case 'us_equity_large':
      if (mcap < 200) return 0.5;
      if (mcap > 2000) return 0.7;
      return 1.0;
    case 'us_equity_small_mid':
      if (mcap < 0.3) return 0.2;
      if (mcap > 10) return 0.5;
      return 1.0;
    case 'eu_equity':
    case 'asia_equity':
    case 'crypto_major':
    default:
      return 0.7;
  }
}

/** Calcule le score continu [0..100] et retourne aussi les sous-scores. */
export function calculateContinuousScore(
  features: ScoreFeatures,
  assetClass: ScoringAssetClass,
): ScoreResult {
  const subScores: SubScores = {
    amplitudeScore: computeAmplitudeScore(features.changePctSnapshot, assetClass),
    rvolScore: computeRvolScore(features.rvol, assetClass),
    momentumScore: computeMomentumScore(
      features.momentum5m,
      features.momentum15m,
      features.momentum30m,
    ),
    persistenceScore: computePersistenceSubScore(features.persistenceMultiTf),
    capQualityScore: computeCapQualityScore(features.marketCapUsd, assetClass),
  };
  const w = WEIGHTS[assetClass];
  const total = 100 * (
    w.amplitude * subScores.amplitudeScore +
    w.rvol * subScores.rvolScore +
    w.momentum * subScores.momentumScore +
    w.persistence * subScores.persistenceScore +
    w.capQuality * subScores.capQualityScore
  );
  return { total: clamp(total, 0, 100), subScores };
}
