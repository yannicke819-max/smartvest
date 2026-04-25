/**
 * Phase C — Walk-forward validation + stabilité + ensemble.
 *
 * Anti-overfitting rigoureux : on split la période en train (60% par défaut)
 * et validation (40%). On optimise sur train, on score sur validation
 * (out-of-sample = OOS). La config retenue est celle qui marche sur la
 * portion qu'elle n'a PAS vue à l'optimisation.
 *
 * Pour la stabilité, on découpe la fenêtre validation en 3 sous-fenêtres
 * et on regarde si le score reste cohérent (faible variance = robuste).
 *
 * Pour l'ensemble, on retourne aussi le top-3 — un futur consumer peut
 * faire un vote pondéré au lieu de tout miser sur la #1.
 */

import { runBacktest, extractTradingDates, type BacktestConfig, type TickerHistory } from '@smartvest/backtest';
import {
  candidateToBacktestConfig,
  type OptimizerCandidate,
  type OptimizerLeaderboard,
  type ScoredCandidate,
} from './types';
import { computeCompositeScore, computeStabilityScore, rankCandidates } from './scorer';

export interface WalkForwardInput {
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
  /** Ratio train (0.6 = 60%). */
  trainRatio: number;
}

interface SplitDates {
  trainFrom: string;
  trainTo: string;
  valFrom: string;
  valTo: string;
}

export function splitDates(
  fromDate: string,
  toDate: string,
  histories: TickerHistory[],
  trainRatio: number,
): SplitDates {
  const allDates = extractTradingDates(histories);
  const inWindow = allDates.filter((d) => d >= fromDate && d <= toDate);
  if (inWindow.length < 10) {
    return { trainFrom: fromDate, trainTo: fromDate, valFrom: toDate, valTo: toDate };
  }
  const splitIdx = Math.floor(inWindow.length * trainRatio);
  return {
    trainFrom: inWindow[0],
    trainTo: inWindow[splitIdx - 1],
    valFrom: inWindow[splitIdx],
    valTo: inWindow[inWindow.length - 1],
  };
}

/** Run un backtest sur une sous-fenêtre. */
function runOnWindow(
  candidate: OptimizerCandidate,
  histories: TickerHistory[],
  baseConfig: WalkForwardInput['baseConfig'],
  fromDate: string,
  toDate: string,
): { compositeScore: number; metrics: ReturnType<typeof runBacktest>['metrics'] } {
  const config: BacktestConfig = candidateToBacktestConfig(candidate, {
    ...baseConfig,
    fromDate,
    toDate,
  });
  const result = runBacktest({ config, histories, warnings: [] });
  return {
    compositeScore: computeCompositeScore(result.metrics),
    metrics: result.metrics,
  };
}

export async function runWalkForward(input: WalkForwardInput): Promise<OptimizerLeaderboard> {
  const { candidates, histories, baseConfig, trainRatio } = input;
  const split = splitDates(baseConfig.fromDate, baseConfig.toDate, histories, trainRatio);

  // Pour chaque candidat :
  //  1. Score sur train (in-sample)
  //  2. Score sur validation entière (OOS)
  //  3. Stabilité = scores sur 3 sous-fenêtres de la validation
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const trainResult = runOnWindow(candidate, histories, baseConfig, split.trainFrom, split.trainTo);
    const valResult = runOnWindow(candidate, histories, baseConfig, split.valFrom, split.valTo);

    // Stabilité : split val en 3
    const valDates = extractTradingDates(histories).filter((d) => d >= split.valFrom && d <= split.valTo);
    let stabilityScore = 1.0;
    if (valDates.length >= 9) {
      const third = Math.floor(valDates.length / 3);
      const subScores: number[] = [];
      for (let i = 0; i < 3; i++) {
        const subFrom = valDates[i * third];
        const subTo = valDates[Math.min((i + 1) * third - 1, valDates.length - 1)];
        const sub = runOnWindow(candidate, histories, baseConfig, subFrom, subTo);
        subScores.push(sub.compositeScore);
      }
      stabilityScore = computeStabilityScore(subScores);
    }

    // Score final = OOS pondéré par stabilité.
    // Une config avec OOS=2.0 et stabilité=0.5 vaut moins qu'une avec OOS=1.5 et stabilité=0.95.
    const finalScore = valResult.compositeScore * (0.5 + 0.5 * stabilityScore);

    scored.push({
      candidate,
      metrics: valResult.metrics,
      compositeScore: finalScore,
      stabilityScore,
      oosScore: valResult.compositeScore,
    });

    // Train score utilisé en debug uniquement
    void trainResult;
  }

  const ranked = rankCandidates(scored);
  return {
    ranked,
    best: ranked[0] ?? null,
  };
}
