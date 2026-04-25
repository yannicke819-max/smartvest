/**
 * Phase A — Single-shot optimizer.
 *
 * Exécute N backtests en parallèle (chacun sur la même fenêtre temporelle)
 * pour les configs de la grille, score chacun, retourne le leaderboard.
 *
 * Utilisation typique : exploration manuelle, comparaison de configs sur
 * une période d'intérêt. Pas de validation out-of-sample, pas de stabilité —
 * c'est volontairement simple. Voir Phase C pour validation rigoureuse.
 *
 * Concurrence : on cap à `MAX_PARALLEL` pour ne pas saturer EODHD ni la
 * mémoire. Les data sont chargées UNE seule fois et partagées entre les
 * runs (chaque candidat = un re-run du runner sur les mêmes histoires).
 */

import { runBacktest, type BacktestConfig, type TickerHistory } from '@smartvest/backtest';
import {
  candidateToBacktestConfig,
  type OptimizerCandidate,
  type OptimizerLeaderboard,
  type ScoredCandidate,
} from './types';
import { computeCompositeScore, rankCandidates } from './scorer';

const MAX_PARALLEL = 4;

export interface SingleShotInput {
  candidates: OptimizerCandidate[];
  histories: TickerHistory[];
  baseConfig: Pick<
    BacktestConfig,
    | 'fromDate'
    | 'toDate'
    | 'initialCapitalUsd'
    | 'universe'
    | 'profile'
    | 'maxOpenPositions'
    | 'slippageBps'
    | 'feeBps'
    | 'maxHorizonDays'
  >;
}

export async function runSingleShot(input: SingleShotInput): Promise<OptimizerLeaderboard> {
  const { candidates, histories, baseConfig } = input;
  const scored: ScoredCandidate[] = [];

  // Concurrence limitée — chaque run est CPU-bound mais court (~100ms par run
  // sur 90 jours × 17 tickers). Pas besoin de queue sophistiquée.
  for (let i = 0; i < candidates.length; i += MAX_PARALLEL) {
    const batch = candidates.slice(i, i + MAX_PARALLEL);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const config = candidateToBacktestConfig(candidate, baseConfig);
        const result = runBacktest({ config, histories, warnings: [] });
        return {
          candidate,
          metrics: result.metrics,
          compositeScore: computeCompositeScore(result.metrics),
        };
      }),
    );
    scored.push(...results);
  }

  const ranked = rankCandidates(scored);
  return {
    ranked,
    best: ranked[0] ?? null,
  };
}
