/**
 * Phase B — Logique d'auto-application avec garde-fous.
 *
 * Reçoit le leaderboard d'un run + la config courante + l'état précédent
 * (last apply timestamp), décide d'appliquer ou pas selon 4 critères :
 *
 *   1. Significance        : nouveau score > courant + SIGNIFICANCE_DELTA
 *   2. Stability            : stabilityScore > MIN_STABILITY (Phase C uniquement)
 *   3. Cooldown             : >= MIN_COOLDOWN_DAYS depuis dernière application
 *   4. No regime change     : la config courante ne s'est pas effondrée trop
 *                             rapidement (pas de panique)
 *
 * Tous les seuils sont des constantes documentées et tunables ici.
 * En cas de doute, on PRÉFÈRE NE PAS APPLIQUER — l'inertie protège
 * contre l'overfitting au passé récent.
 */

import type {
  AutoApplyDecision,
  AutoApplyState,
  OptimizerCandidate,
  OptimizerLeaderboard,
  ScoredCandidate,
} from './types';

const SIGNIFICANCE_DELTA = 0.3;
const MIN_STABILITY = 0.6;
const MIN_COOLDOWN_DAYS = 7;

export interface AutoApplyEvaluationInput {
  leaderboard: OptimizerLeaderboard;
  /** Config courante (= ce qui tourne en prod, à comparer au best). */
  currentCandidate: OptimizerCandidate | null;
  /** Score de la config courante sur la même période — IMPÉRATIF de
   *  comparer pommes / pommes. Doit être calculé par le caller en
   *  rejouant la config courante sur la fenêtre du run. */
  currentScore: number | null;
  /** État de l'auto-apply (toggle on/off + last apply). */
  state: AutoApplyState;
  /** Si true, ignore le toggle (utile pour preview/dry-run). */
  dryRun?: boolean;
}

export function evaluateAutoApply(input: AutoApplyEvaluationInput): AutoApplyDecision {
  const { leaderboard, currentCandidate, currentScore, state, dryRun } = input;

  // Toggle off → toujours skip (sauf dry-run)
  if (!state.enabled && !dryRun) {
    return {
      willApply: false,
      reasonCode: 'skip_disabled',
      reasonText: 'Mode auto-apply désactivé.',
    };
  }

  // Pas de best → impossible d'agir
  if (!leaderboard.best) {
    return {
      willApply: false,
      reasonCode: 'skip_no_improvement',
      reasonText: 'Aucun candidat scoré dans le leaderboard.',
    };
  }

  const best: ScoredCandidate = leaderboard.best;

  // Pas de config courante connue → on n'applique pas tant qu'on ne sait pas
  // ce qu'on remplace (évite « blind first apply »).
  if (currentCandidate == null || currentScore == null) {
    return {
      willApply: false,
      reasonCode: 'skip_no_current_config',
      reasonText: 'Config courante inconnue ou non scorée — pas de baseline pour comparer.',
      scoreNew: best.compositeScore,
    };
  }

  // Cooldown
  if (state.lastApplyAt != null) {
    const lastMs = new Date(state.lastApplyAt).getTime();
    const ageDays = (Date.now() - lastMs) / (1000 * 60 * 60 * 24);
    if (ageDays < MIN_COOLDOWN_DAYS) {
      return {
        willApply: false,
        reasonCode: 'skip_cooldown',
        reasonText: `Cooldown actif : dernier apply il y a ${ageDays.toFixed(1)}j (min ${MIN_COOLDOWN_DAYS}j).`,
        scoreCurrent: currentScore,
        scoreNew: best.compositeScore,
      };
    }
  }

  // Significance
  const delta = best.compositeScore - currentScore;
  if (delta < SIGNIFICANCE_DELTA) {
    return {
      willApply: false,
      reasonCode: 'skip_no_improvement',
      reasonText: `Gain insuffisant : nouveau ${best.compositeScore.toFixed(2)} vs courant ${currentScore.toFixed(2)} (delta ${delta.toFixed(2)} < ${SIGNIFICANCE_DELTA}).`,
      scoreCurrent: currentScore,
      scoreNew: best.compositeScore,
    };
  }

  // Stability (si fourni — Phase C uniquement)
  if (best.stabilityScore != null && best.stabilityScore < MIN_STABILITY) {
    return {
      willApply: false,
      reasonCode: 'skip_unstable',
      reasonText: `Config trop instable : stability ${best.stabilityScore.toFixed(2)} < ${MIN_STABILITY}. Probable overfit sur la fenêtre.`,
      scoreCurrent: currentScore,
      scoreNew: best.compositeScore,
    };
  }

  // Tous les garde-fous OK → apply
  return {
    willApply: !dryRun,
    reasonCode: 'applied',
    reasonText: dryRun
      ? `[DRY RUN] Aurait appliqué : score ${best.compositeScore.toFixed(2)} > ${currentScore.toFixed(2)} (+${delta.toFixed(2)}).`
      : `Apply : score ${best.compositeScore.toFixed(2)} > ${currentScore.toFixed(2)} (+${delta.toFixed(2)}).`,
    appliedConfig: best.candidate,
    scoreCurrent: currentScore,
    scoreNew: best.compositeScore,
  };
}

export const AUTO_APPLY_THRESHOLDS = {
  SIGNIFICANCE_DELTA,
  MIN_STABILITY,
  MIN_COOLDOWN_DAYS,
} as const;
