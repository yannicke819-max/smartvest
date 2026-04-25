/**
 * Types publics du strategy-optimizer.
 *
 * Trois modes d'exécution sélectionnables séparément :
 *   - SINGLE_SHOT  : test une grille de configs sur une fenêtre fixe (Phase A)
 *   - WALK_FORWARD : split train/val + ensembles + stabilité (Phase C)
 *   - AUTO_APPLY   : tourne quotidiennement, applique avec garde-fous (Phase B)
 *
 * Chacun produit un OptimizerRun stocké en DB pour audit / rollback.
 */

import { z } from 'zod';
import type { BacktestConfig, BacktestMetrics, BacktestResult } from '@smartvest/backtest';

// ─────────────────────────────────────────────────────────────────────────────
// Search space — grille de configs à tester
// ─────────────────────────────────────────────────────────────────────────────

export const SearchSpaceSchema = z.object({
  antiConsensusStrengths: z.array(z.number().int().min(0).max(10)).default([3, 5, 7]),
  maxPositionSizePcts: z.array(z.number().min(1).max(50)).default([6, 8, 10]),
  maxAssetClassExposurePcts: z.array(z.number().min(1).max(100)).default([15, 20, 25]),
  stopLossPcts: z.array(z.number().min(0.5).max(10)).default([1.5, 2, 3]),
  takeProfitPcts: z.array(z.number().min(0.5).max(20)).default([3, 4, 6]),
});

export type SearchSpace = z.infer<typeof SearchSpaceSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Configurations à scorer + leaderboard
// ─────────────────────────────────────────────────────────────────────────────

/** Sous-ensemble de BacktestConfig que l'optimizer fait varier. */
export interface OptimizerCandidate {
  antiConsensusStrength: number;
  maxPositionSizePct: number;
  maxAssetClassExposurePct: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export interface ScoredCandidate {
  candidate: OptimizerCandidate;
  metrics: BacktestMetrics;
  /** Score composite (Sharpe pondéré pénalisé par drawdown + coûts). */
  compositeScore: number;
  /** Stability score : variance des Sharpes sur sous-fenêtres (Phase C uniquement). */
  stabilityScore?: number;
  /** Score validation out-of-sample (Phase C uniquement). */
  oosScore?: number;
}

export interface OptimizerLeaderboard {
  /** Triés par compositeScore décroissant. */
  ranked: ScoredCandidate[];
  /** Best = ranked[0]. */
  best: ScoredCandidate | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode + paramètres d'exécution
// ─────────────────────────────────────────────────────────────────────────────

export const OptimizerRunModeSchema = z.enum(['single_shot', 'walk_forward', 'auto_apply']);
export type OptimizerRunMode = z.infer<typeof OptimizerRunModeSchema>;

export const OptimizerRunParamsSchema = z.object({
  mode: OptimizerRunModeSchema,
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  initialCapitalUsd: z.number().positive().default(10_000),
  /** Split train/val pour walk-forward (default 0.6 = 60% train). */
  trainRatio: z.number().min(0.3).max(0.9).default(0.6),
  searchSpace: SearchSpaceSchema.optional(),
  /** Limite la combinatoire pour rester gérable (défaut : 30 max). */
  maxCandidates: z.number().int().min(1).max(100).default(30),
});

export type OptimizerRunParams = z.infer<typeof OptimizerRunParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Résultat d'un run
// ─────────────────────────────────────────────────────────────────────────────

export interface OptimizerRunResult {
  mode: OptimizerRunMode;
  fromDate: string;
  toDate: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  candidatesTested: number;
  leaderboard: OptimizerLeaderboard;
  /** Décision Phase B uniquement. */
  applyDecision?: AutoApplyDecision;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — décision d'application
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoApplyDecision {
  willApply: boolean;
  /** Code-machine pour la raison (apply OU skip). */
  reasonCode:
    | 'applied'
    | 'skip_no_improvement'
    | 'skip_unstable'
    | 'skip_cooldown'
    | 'skip_regime_change'
    | 'skip_disabled'
    | 'skip_no_current_config';
  /** Texte humain. */
  reasonText: string;
  /** La config retenue si applied (nouvelle config Lisa). */
  appliedConfig?: OptimizerCandidate;
  /** Score nouveau vs courant. */
  scoreCurrent?: number;
  scoreNew?: number;
}

export interface AutoApplyState {
  enabled: boolean;
  lastRunAt: string | null;
  lastApplyAt: string | null;
  /** Mode du dernier run (single_shot ou walk_forward). */
  lastMode: OptimizerRunMode | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper : projeter un OptimizerCandidate sur un BacktestConfig
// ─────────────────────────────────────────────────────────────────────────────

export function candidateToBacktestConfig(
  candidate: OptimizerCandidate,
  base: Pick<BacktestConfig, 'fromDate' | 'toDate' | 'initialCapitalUsd' | 'universe' | 'profile' | 'maxOpenPositions' | 'slippageBps' | 'feeBps' | 'maxHorizonDays'>,
): BacktestConfig {
  return {
    ...base,
    enableOptions: false,
    defaultIv: 0.30,
    optionsDte: 14,
    strikeOtmPct: 2,
    antiConsensusStrength: candidate.antiConsensusStrength,
    maxPositionSizePct: candidate.maxPositionSizePct,
    maxAssetClassExposurePct: candidate.maxAssetClassExposurePct,
    stopLossPct: candidate.stopLossPct,
    takeProfitPct: candidate.takeProfitPct,
  };
}

export type { BacktestResult };
