/**
 * Scanner Momentum Shadow Comparator — Phase 4 du refactor scanner.
 *
 * Capture la distribution des buckets dans le pool de candidats fed à TRADER +
 * le bucket choisi par Mistral. Permet l'analyse offline :
 *   - Quels buckets Mistral préfère-t-il (sweet_spot_rising vs peak_parabolic) ?
 *   - Quel est le winRate par bucket sur N jours ?
 *   - Le composite ranking + momentum aide-t-il vs legacy refund_1d_p.desc ?
 *
 * Aucun effet sur la décision — pur logging. Persistance via decision_log
 * (kind='scanner_momentum_shadow').
 *
 * Gating env : SCANNER_AB_SHADOW_ENABLED (default OFF). Marche que Phase 2 soit
 * ON ou OFF — si OFF, candidatesWithMomentum=0 (utile pour A/B baseline).
 */

/**
 * Shape minimal d'un candidat post-enrichCandidateWithMath. On ne dépend pas
 * de TopGainerCandidate ici car le caller (TRADER) manipule la version
 * enrichie `Record<string, unknown>` dans laquelle momentum/bucket sont
 * forwardés par enrichCandidateWithMath (Phase 2).
 */
export interface ShadowCandidate {
  symbol?: unknown;
  changePct?: unknown;
  bucket?: unknown;
  momentum?: { risingScore?: unknown } | unknown;
  [key: string]: unknown;
}

export interface MomentumShadowSummary {
  /** Total candidats dans le pool fed à TRADER ce cycle. */
  candidatesTotal: number;
  /** Combien ont un champ `momentum` peuplé (= Phase 2 ON + fetch OK). */
  candidatesWithMomentum: number;
  /** Distribution des buckets (count par bucket). */
  bucketDistribution: Record<string, number>;
  /** Top 5 candidats par risingScore (debug + spot-check). */
  topByRising: Array<{ symbol: string; bucket: string | null; risingScore: number; changePct: number }>;
  /** Symbole choisi par Mistral, si action_kind = open_directional. */
  chosenSymbol: string | null;
  /** Bucket du symbole choisi (null si Mistral a hold ou si Phase 2 OFF). */
  chosenBucket: string | null;
  /** risingScore du symbole choisi (null si Phase 2 OFF). */
  chosenRisingScore: number | null;
  /** changePct du symbole choisi. */
  chosenChangePct: number | null;
}

/**
 * Construit un MomentumShadowSummary à partir du pool de candidats + de la
 * décision Mistral (symbol choisi, ou null si hold).
 */
export function summarizeMomentumDecisions(
  candidates: ShadowCandidate[],
  chosenSymbol: string | null,
): MomentumShadowSummary {
  const getRising = (c: ShadowCandidate): number | null => {
    const m = c.momentum as { risingScore?: unknown } | undefined;
    if (!m || typeof m.risingScore !== 'number') return null;
    return m.risingScore;
  };
  const getBucket = (c: ShadowCandidate): string | null =>
    typeof c.bucket === 'string' ? c.bucket : null;
  const getSymbol = (c: ShadowCandidate): string =>
    typeof c.symbol === 'string' ? c.symbol : '';
  const getChangePct = (c: ShadowCandidate): number | null =>
    typeof c.changePct === 'number' ? c.changePct : null;

  const candidatesTotal = candidates.length;
  const candidatesWithMomentum = candidates.filter((c) => getRising(c) !== null).length;

  const bucketDistribution: Record<string, number> = {};
  for (const c of candidates) {
    const b = getBucket(c) ?? 'unclassified';
    bucketDistribution[b] = (bucketDistribution[b] ?? 0) + 1;
  }

  const topByRising = [...candidates]
    .filter((c) => getRising(c) !== null)
    .sort((a, b) => (getRising(b) ?? 0) - (getRising(a) ?? 0))
    .slice(0, 5)
    .map((c) => ({
      symbol: getSymbol(c),
      bucket: getBucket(c),
      risingScore: Math.round((getRising(c) ?? 0) * 100) / 100,
      changePct: Math.round((getChangePct(c) ?? 0) * 100) / 100,
    }));

  let chosenBucket: string | null = null;
  let chosenRisingScore: number | null = null;
  let chosenChangePct: number | null = null;
  if (chosenSymbol) {
    const match = candidates.find((c) => getSymbol(c) === chosenSymbol);
    if (match) {
      chosenBucket = getBucket(match);
      chosenRisingScore = getRising(match);
      chosenChangePct = getChangePct(match);
    }
  }

  return {
    candidatesTotal,
    candidatesWithMomentum,
    bucketDistribution,
    topByRising,
    chosenSymbol,
    chosenBucket,
    chosenRisingScore,
    chosenChangePct,
  };
}
