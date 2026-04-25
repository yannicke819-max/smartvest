/**
 * Scoring composite d'une config — combine plusieurs métriques en un seul nombre.
 *
 * Sharpe seul est insuffisant : il ne pénalise pas le drawdown (un Sharpe 2 avec
 * -40% drawdown reste catastrophique pour un humain). On agrège :
 *
 *   composite = w1 × Sharpe
 *             - w2 × maxDrawdownPct/10
 *             - w3 × costsRatio        (coûts/profit brut)
 *             + w4 × min(profitFactor, 3)/3
 *
 * Les poids w1..w4 sont tunables. Défauts cohérents avec un profil sniper :
 *   w1 = 1.0   → Sharpe domine
 *   w2 = 0.4   → drawdown pénalisé, pas écrasant
 *   w3 = 0.3   → coûts pénalisés
 *   w4 = 0.5   → profit factor récompensé mais plafonné
 *
 * Un score positif = config rentable nette. Un score > 1.5 = solide.
 */

import type { BacktestMetrics } from '@smartvest/backtest';
import type { ScoredCandidate } from './types';

export interface ScoringWeights {
  sharpe: number;
  drawdown: number;
  costs: number;
  profitFactor: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  sharpe: 1.0,
  drawdown: 0.4,
  costs: 0.3,
  profitFactor: 0.5,
};

export function computeCompositeScore(
  metrics: BacktestMetrics,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  // Coûts : on regarde la part qu'ils représentent du gain brut. Si pas de
  // gain brut, on pénalise structurellement.
  const grossPnl =
    metrics.totalTrades > 0
      ? metrics.avgPnlPerTradeUsd * metrics.totalTrades + metrics.totalCostsUsd
      : 0;
  const costsRatio = grossPnl > 0 ? metrics.totalCostsUsd / grossPnl : 1.0;

  const sharpeTerm = weights.sharpe * metrics.sharpeRatio;
  const ddTerm = weights.drawdown * (metrics.maxDrawdownPct / 10);
  const costsTerm = weights.costs * Math.min(costsRatio, 1.0);
  const pfNormalized = Math.min(metrics.profitFactor, 3) / 3;
  const pfTerm = weights.profitFactor * pfNormalized;

  return sharpeTerm - ddTerm - costsTerm + pfTerm;
}

/**
 * Tri décroissant par compositeScore. Tiebreaker : Sharpe puis -drawdown.
 */
export function rankCandidates<T extends ScoredCandidate>(scored: T[]): T[] {
  return [...scored].sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (b.metrics.sharpeRatio !== a.metrics.sharpeRatio)
      return b.metrics.sharpeRatio - a.metrics.sharpeRatio;
    return a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct;
  });
}

/**
 * Stabilité : variance des scores composites sur sous-fenêtres.
 * Un score haut + variance basse = config robuste.
 *
 * Coefficient de variation (CV = std / |mean|) inversé pour que plus = mieux.
 */
export function computeStabilityScore(scoresAcrossWindows: number[]): number {
  if (scoresAcrossWindows.length < 2) return 1.0;
  const n = scoresAcrossWindows.length;
  const mean = scoresAcrossWindows.reduce((s, v) => s + v, 0) / n;
  if (Math.abs(mean) < 0.01) return 0;
  const variance =
    scoresAcrossWindows.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const cv = std / Math.abs(mean);
  // Inverse : CV de 0 (parfaitement stable) → 1.0, CV de 1+ → ~0.
  return 1 / (1 + cv);
}
