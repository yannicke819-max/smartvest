/**
 * Phase 3 — Modèle p_win oversold (régression logistique sur les features d'entrée).
 *
 * Les 115 trades oversold collectés portent `features_at_entry` (16 features
 * numériques : VIX/régime, RSI/vol/MA technique, bande de drop, news). Une fois
 * labellisés à J+10 (fwd_outcome_10d ∈ {0,1}), on entraîne un logistic
 * (réutilise l'outillage P9 fitLogistic) pour prédire P(win | features) à l'entrée.
 *
 * Pure functions (extraction + assemblage du training set) → testables sans DB.
 * Le fit lui-même vit dans OversoldProbabilityService (import @smartvest/ai-analyst).
 */

/** Les 16 features collectées dans features_at_entry (ordre = ordre du vecteur). */
export const OVERSOLD_FEATURE_NAMES = [
  'vix',
  'vix3mRatio',
  'hyg5d',
  'spy5d',
  'rsi14',
  'vol14',
  'drop1d',
  'drop3d',
  'trend20',
  'distMa20',
  'distMa50',
  'relVol20',
  'newsCount',
  'newsAgeHours',
  'newsAvgSentiment',
  'newsMinSentiment',
] as const;

/** Extrait un vecteur de features numériques d'un features_at_entry (non-fini → 0). */
export function extractFeatureRow(features: Record<string, unknown> | null | undefined): Record<string, number> {
  const row: Record<string, number> = {};
  for (const name of OVERSOLD_FEATURE_NAMES) {
    const v = features ? Number((features as Record<string, unknown>)[name]) : NaN;
    row[name] = Number.isFinite(v) ? v : 0;
  }
  return row;
}

export interface OversoldTrainTrade {
  features: Record<string, unknown> | null;
  fwdOutcome: number | null; // fwd_outcome_10d ∈ {0,1} ; null = pas encore labellisé
}

export interface OversoldTrainingSet {
  X: Array<Record<string, number>>;
  y: number[]; // 1 = win J+10, 0 = loss
  names: string[];
  n: number;
  wins: number;
}

/**
 * Assemble le training set : ne garde que les trades LABELLISÉS (fwdOutcome non null).
 * y = 1 si fwd_outcome_10d == 1 (win), 0 sinon.
 */
export function buildOversoldTrainingSet(trades: OversoldTrainTrade[]): OversoldTrainingSet {
  const X: Array<Record<string, number>> = [];
  const y: number[] = [];
  for (const t of trades) {
    if (t.fwdOutcome == null || !Number.isFinite(Number(t.fwdOutcome))) continue;
    X.push(extractFeatureRow(t.features));
    y.push(Number(t.fwdOutcome) === 1 ? 1 : 0);
  }
  return {
    X,
    y,
    names: [...OVERSOLD_FEATURE_NAMES],
    n: y.length,
    wins: y.reduce((a, v) => a + v, 0),
  };
}
