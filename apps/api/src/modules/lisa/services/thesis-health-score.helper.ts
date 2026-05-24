/**
 * Thesis Health Score — pure helper, aucun I/O.
 *
 * Calcule un score signé [-1, +1] qui mesure si la thèse momentum d'une position
 * ouverte s'est dégradée ou renforcée depuis l'ouverture, en agrégeant 3 sub-signaux
 * indépendants (poids configurables) :
 *
 *   - sub_A : market momentum (proxy de classe — ex BTC pour crypto)
 *   - sub_B : path quality / persistence multi-TF (re-scoring sur le symbole)
 *   - sub_C : LLM thesis validity (Gemini Flash-Lite, optionnel)
 *
 * Composite = w_A * sub_A + w_B * sub_B + w_C * sub_C
 * Default poids : 0.40 / 0.35 / 0.25.
 * Si sub_C indisponible (LLM off) : poids re-normalisés sur A+B uniquement.
 *
 * Mapping verdict → action (par défaut, surchargeable) :
 *   composite < -0.60     → CLOSE_NOW
 *   composite < -0.30     → TIGHTEN_SL (vers breakeven = entry)
 *   composite ∈ [-0.30, +0.30] → HOLD
 *   composite > +0.30     → RAISE_TP  (étend TP de +50 % du progress)
 *   composite > +0.60     → MOMENTUM_RIDE (TP désactivé, trailing stop dynamique)
 *
 * Tous les calculs sont déterministes et purs.
 */

export type RiskVerdict =
  | 'HOLD'
  | 'TIGHTEN_SL'
  | 'CLOSE_NOW'
  | 'RAISE_TP'
  | 'MOMENTUM_RIDE';

export interface ThesisHealthInput {
  // Sub-A : market momentum (ch1m proxy)
  marketCh1mAtEntry: number | null; // ex 3.40 % à l'open BTC
  marketCh1mNow: number | null;     // ex 2.04 % maintenant
  // Sub-B : path quality / persistence sur le symbole
  pathEffAtEntry: number | null;        // ex 0.614
  pathEffNow: number | null;            // ex 0.18
  persistenceAtEntry: number | null;    // ex 0.83 (5/6)
  persistenceNow: number | null;        // ex 0.33 (2/6)
  // Sub-C : LLM verdict (optionnel)
  llmScore: number | null;              // ∈ [-1, +1] ou null si LLM off/timeout
}

export interface ThesisHealthWeights {
  wA: number;
  wB: number;
  wC: number;
}

export const DEFAULT_WEIGHTS: ThesisHealthWeights = { wA: 0.40, wB: 0.35, wC: 0.25 };

export interface ThesisHealthThresholds {
  closeBelow: number;       // -0.60
  tightenBelow: number;     // -0.30
  raiseAbove: number;       // +0.30
  rideAbove: number;        // +0.60
}

export const DEFAULT_THRESHOLDS: ThesisHealthThresholds = {
  closeBelow: -0.60,
  tightenBelow: -0.30,
  raiseAbove: 0.30,
  rideAbove: 0.60,
};

export interface ThesisHealthResult {
  composite: number;            // [-1, +1]
  subA: number | null;          // [-1, +1] ou null si entry/now manquant
  subB: number | null;
  subC: number | null;          // toujours = input.llmScore
  weightsUsed: ThesisHealthWeights; // peut différer si sub_C absent
  verdict: RiskVerdict;
}

/**
 * Sub-A : market momentum delta.
 *   delta = (now - entry) / |entry|   (signé)
 * Clampé [-1, +1].
 * Retourne null si entry ou now manquant, ou si entry == 0 (évite div/0).
 */
export function computeSubA(
  marketCh1mAtEntry: number | null,
  marketCh1mNow: number | null,
): number | null {
  if (marketCh1mAtEntry == null || marketCh1mNow == null) return null;
  if (Math.abs(marketCh1mAtEntry) < 1e-6) return null;
  const delta = (marketCh1mNow - marketCh1mAtEntry) / Math.abs(marketCh1mAtEntry);
  return Math.max(-1, Math.min(1, delta));
}

/**
 * Sub-B : path/persistence delta (moyenne des deux deltas signés).
 * Retourne null si entry manquant pour les DEUX features (pas d'info exploitable).
 * Si seulement une des deux dispo, utilise celle-là.
 */
export function computeSubB(
  pathEffAtEntry: number | null,
  pathEffNow: number | null,
  persistenceAtEntry: number | null,
  persistenceNow: number | null,
): number | null {
  const dPath = (pathEffAtEntry != null && pathEffNow != null && pathEffAtEntry > 1e-6)
    ? (pathEffNow - pathEffAtEntry) / pathEffAtEntry
    : null;
  const dPers = (persistenceAtEntry != null && persistenceNow != null && persistenceAtEntry > 1e-6)
    ? (persistenceNow - persistenceAtEntry) / persistenceAtEntry
    : null;
  const vals = [dPath, dPers].filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.max(-1, Math.min(1, mean));
}

/**
 * Combine les sub-scores en composite signé, en gérant la disponibilité des sub-scores.
 * Si un sub-score est null, son poids est redistribué proportionnellement sur les autres.
 * Si TOUS sont null → composite = 0 (HOLD par défaut).
 */
export function computeComposite(
  subA: number | null,
  subB: number | null,
  subC: number | null,
  weights: ThesisHealthWeights = DEFAULT_WEIGHTS,
): { composite: number; weightsUsed: ThesisHealthWeights } {
  const parts: Array<{ value: number; weight: number; key: 'wA' | 'wB' | 'wC' }> = [];
  if (subA != null) parts.push({ value: subA, weight: weights.wA, key: 'wA' });
  if (subB != null) parts.push({ value: subB, weight: weights.wB, key: 'wB' });
  if (subC != null) parts.push({ value: subC, weight: weights.wC, key: 'wC' });
  if (parts.length === 0) {
    return { composite: 0, weightsUsed: { wA: 0, wB: 0, wC: 0 } };
  }
  const sumW = parts.reduce((s, p) => s + p.weight, 0);
  if (sumW < 1e-6) return { composite: 0, weightsUsed: { wA: 0, wB: 0, wC: 0 } };
  const composite = parts.reduce((s, p) => s + (p.value * p.weight) / sumW, 0);
  const used: ThesisHealthWeights = { wA: 0, wB: 0, wC: 0 };
  for (const p of parts) used[p.key] = p.weight / sumW;
  return { composite: Math.max(-1, Math.min(1, composite)), weightsUsed: used };
}

/**
 * Verdict mécanique selon le composite et des seuils configurables.
 * Note : ordre des checks important (du plus extrême au plus neutre).
 */
export function decideVerdict(
  composite: number,
  th: ThesisHealthThresholds = DEFAULT_THRESHOLDS,
): RiskVerdict {
  if (composite < th.closeBelow) return 'CLOSE_NOW';
  if (composite < th.tightenBelow) return 'TIGHTEN_SL';
  if (composite > th.rideAbove) return 'MOMENTUM_RIDE';
  if (composite > th.raiseAbove) return 'RAISE_TP';
  return 'HOLD';
}

/**
 * Point d'entrée principal : input → ThesisHealthResult complet.
 */
export function evaluateThesisHealth(
  input: ThesisHealthInput,
  weights: ThesisHealthWeights = DEFAULT_WEIGHTS,
  thresholds: ThesisHealthThresholds = DEFAULT_THRESHOLDS,
): ThesisHealthResult {
  const subA = computeSubA(input.marketCh1mAtEntry, input.marketCh1mNow);
  const subB = computeSubB(
    input.pathEffAtEntry, input.pathEffNow,
    input.persistenceAtEntry, input.persistenceNow,
  );
  const subC = input.llmScore;
  const { composite, weightsUsed } = computeComposite(subA, subB, subC, weights);
  const verdict = decideVerdict(composite, thresholds);
  return { composite, subA, subB, subC, weightsUsed, verdict };
}
