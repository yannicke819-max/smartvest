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
  /**
   * PR #465 — Direction de la position. Pour les SHORTs, les sub-A et sub-B
   * sont inversés : un momentum/persistence qui se DÉGRADE pour un long est
   * une VALIDATION de la thèse pour un short (fade-the-top). Default 'long'
   * pour back-compat. Le sub-C (LLM) n'est PAS inversé ici car le prompt
   * downstream reçoit déjà la direction explicitement.
   */
  direction?: 'long' | 'short';
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

// =============================================================================
// Feature #2 — Sizing calibré sur la conviction d'entrée
// =============================================================================

export interface ConvictionSizingConfig {
  /** Si true, mult=0 (SKIP) quand composite < 0. Default true. */
  skipIfNegative: boolean;
  /** Multiplier pour composite ∈ [0, lowThreshold]. Default 0.7. */
  multLow: number;
  /** Multiplier pour composite ∈ [highThreshold, 1.0]. Default 1.5. */
  multHigh: number;
  /** Seuil bas : sub-mult appliqué en-dessous. Default 0.30. */
  lowThreshold: number;
  /** Seuil haut : sub-mult appliqué au-dessus. Default 0.60. */
  highThreshold: number;
  /** Cap dur du multiplicateur final. Sécurité. Default 2.0. */
  maxMultiplier: number;
}

export const DEFAULT_CONVICTION_SIZING: ConvictionSizingConfig = {
  skipIfNegative: true,
  multLow: 0.7,
  multHigh: 1.5,
  lowThreshold: 0.30,
  highThreshold: 0.60,
  maxMultiplier: 2.0,
};

export interface EntryConvictionInput {
  /** pathEff @ open ∈ [0, 1] ; ~0.50 = neutre, > 0.70 = clean trend */
  pathEff: number | null;
  /** persistenceScore @ open ∈ [0, 1] ; 4/6 = 0.67 = standard threshold */
  persistence: number | null;
  /** ch1m % @ open (ex 4.5 % de pump) ; > 5 % = très fort */
  ch1mPct: number | null;
}

/**
 * Compute un "conviction score" ∈ [-1, +1] basé sur la qualité du setup au moment
 * de l'ouverture (pas un delta — c'est le score brut du candidat).
 *
 * Normalisation :
 *   pathEff      : (v - 0.55) / 0.30  clampé [-1, +1]   (0.55 = neutre)
 *   persistence  : (v - 0.50) / 0.30  clampé [-1, +1]
 *   ch1m         : min(v / 5.0, 1.0)  (5 % = strong, plus = clamp)
 *
 * Moyenne des features dispos. Si TOUTES null → 0 (sizing standard).
 */
export function computeEntryConvictionScore(input: EntryConvictionInput): number {
  const parts: number[] = [];
  if (input.pathEff != null && Number.isFinite(input.pathEff)) {
    parts.push(Math.max(-1, Math.min(1, (input.pathEff - 0.55) / 0.30)));
  }
  if (input.persistence != null && Number.isFinite(input.persistence)) {
    parts.push(Math.max(-1, Math.min(1, (input.persistence - 0.50) / 0.30)));
  }
  if (input.ch1mPct != null && Number.isFinite(input.ch1mPct)) {
    parts.push(Math.max(-1, Math.min(1, input.ch1mPct / 5.0)));
  }
  if (parts.length === 0) return 0;
  return parts.reduce((s, v) => s + v, 0) / parts.length;
}

/**
 * Décide le multiplicateur de sizing selon le composite d'entrée.
 *   composite < 0 (si skipIfNegative=true)    → 0 (SKIP open)
 *   composite ∈ [0, lowThreshold]              → multLow (default 0.7)
 *   composite ∈ [lowThreshold, highThreshold]  → 1.0 (sizing standard)
 *   composite > highThreshold                  → multHigh (default 1.5)
 * Toujours clampé ∈ [0, maxMultiplier].
 *
 * Si composite est NaN/null (cas où on n'a pas pu le calculer), retourne 1.0
 * (sizing standard) — back-compat safe.
 */
export function decideSizingMultiplier(
  composite: number | null,
  cfg: ConvictionSizingConfig = DEFAULT_CONVICTION_SIZING,
): number {
  if (composite == null || !Number.isFinite(composite)) return 1.0;
  if (composite < 0) return cfg.skipIfNegative ? 0 : cfg.multLow;
  let mult: number;
  if (composite < cfg.lowThreshold) mult = cfg.multLow;
  else if (composite > cfg.highThreshold) mult = cfg.multHigh;
  else mult = 1.0;
  return Math.max(0, Math.min(cfg.maxMultiplier, mult));
}

/**
 * Parse config depuis env vars.
 */
export function parseConvictionSizingConfig(env: {
  CONVICTION_SIZING_ENABLED?: string | undefined;
  CONVICTION_SIZING_MULT_LOW?: string | undefined;
  CONVICTION_SIZING_MULT_HIGH?: string | undefined;
  CONVICTION_SIZING_LOW_THRESHOLD?: string | undefined;
  CONVICTION_SIZING_HIGH_THRESHOLD?: string | undefined;
  CONVICTION_SIZING_SKIP_IF_NEGATIVE?: string | undefined;
  CONVICTION_SIZING_MAX_MULTIPLIER?: string | undefined;
}): { enabled: boolean; cfg: ConvictionSizingConfig } {
  const enabled = (env.CONVICTION_SIZING_ENABLED ?? 'false').toLowerCase() === 'true';
  const parseFloat01 = (raw: string | undefined, def: number, min: number, max: number): number => {
    const n = Number.parseFloat(raw ?? '');
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  return {
    enabled,
    cfg: {
      skipIfNegative: (env.CONVICTION_SIZING_SKIP_IF_NEGATIVE ?? 'true').toLowerCase() !== 'false',
      multLow: parseFloat01(env.CONVICTION_SIZING_MULT_LOW, DEFAULT_CONVICTION_SIZING.multLow, 0, 2),
      multHigh: parseFloat01(env.CONVICTION_SIZING_MULT_HIGH, DEFAULT_CONVICTION_SIZING.multHigh, 0, 3),
      lowThreshold: parseFloat01(env.CONVICTION_SIZING_LOW_THRESHOLD, DEFAULT_CONVICTION_SIZING.lowThreshold, 0, 1),
      highThreshold: parseFloat01(env.CONVICTION_SIZING_HIGH_THRESHOLD, DEFAULT_CONVICTION_SIZING.highThreshold, 0, 1),
      maxMultiplier: parseFloat01(env.CONVICTION_SIZING_MAX_MULTIPLIER, DEFAULT_CONVICTION_SIZING.maxMultiplier, 0.5, 5),
    },
  };
}

/**
 * Point d'entrée principal : input → ThesisHealthResult complet.
 */
export function evaluateThesisHealth(
  input: ThesisHealthInput,
  weights: ThesisHealthWeights = DEFAULT_WEIGHTS,
  thresholds: ThesisHealthThresholds = DEFAULT_THRESHOLDS,
): ThesisHealthResult {
  const rawSubA = computeSubA(input.marketCh1mAtEntry, input.marketCh1mNow);
  const rawSubB = computeSubB(
    input.pathEffAtEntry, input.pathEffNow,
    input.persistenceAtEntry, input.persistenceNow,
  );
  // PR #465 — invert sub-A / sub-B for SHORT positions. For a short, a momentum
  // qui s'effrite (rawSub < 0 sur un long = trend cassé) est en réalité une
  // CONFIRMATION de la thèse de fade (rawSub doit devenir > 0 pour le short).
  // Sub-C n'est pas inversé ici : le prompt LLM downstream reçoit la direction
  // et raisonne avec dans le bon sens.
  const sign = input.direction === 'short' ? -1 : 1;
  const subA = rawSubA != null ? rawSubA * sign : null;
  const subB = rawSubB != null ? rawSubB * sign : null;
  const subC = input.llmScore;
  const { composite, weightsUsed } = computeComposite(subA, subB, subC, weights);
  const verdict = decideVerdict(composite, thresholds);
  return { composite, subA, subB, subC, weightsUsed, verdict };
}
