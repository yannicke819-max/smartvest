/**
 * Calcul des métriques classiques de performance backtest.
 *
 * Toutes les formules sont annotées et conformes aux conventions hedge fund :
 *  - Sharpe annualisé : (mean_daily_return / std_daily_return) × sqrt(252)
 *  - Max drawdown : peak-to-trough sur la courbe d'équité
 *  - Win rate : trades gagnants / total
 *  - Profit factor : sum(gains) / sum(|pertes|)
 *  - Calmar : annualized_return / max_drawdown_abs
 */

import type { BacktestMetrics, BacktestTrade, EquityPoint } from './types';

const TRADING_DAYS_PER_YEAR = 252;

export function computeMetrics(
  equityCurve: EquityPoint[],
  trades: BacktestTrade[],
  initialCapital: number,
  totalCostsUsd: number,
): BacktestMetrics {
  if (equityCurve.length === 0) {
    return {
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      sharpeRatio: 0,
      maxDrawdownPct: 0,
      winRatePct: 0,
      profitFactor: 0,
      calmarRatio: 0,
      avgPnlPerTradeUsd: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalCostsUsd,
    };
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equityUsd;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  // Annualisation : (1 + r)^(252/n) - 1
  const days = equityCurve.length;
  const annualizedReturnPct =
    days > 0
      ? (Math.pow(finalEquity / initialCapital, TRADING_DAYS_PER_YEAR / days) - 1) * 100
      : 0;

  // Daily returns pour Sharpe
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const r = (equityCurve[i].equityUsd - equityCurve[i - 1].equityUsd) / equityCurve[i - 1].equityUsd;
    if (Number.isFinite(r)) dailyReturns.push(r);
  }

  let sharpeRatio = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyReturns.length;
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;
  }

  // Max drawdown
  let peak = equityCurve[0].equityUsd;
  let maxDDPct = 0;
  for (const p of equityCurve) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    const dd = ((peak - p.equityUsd) / peak) * 100;
    if (dd > maxDDPct) maxDDPct = dd;
  }

  // Win rate / profit factor
  let winners = 0;
  let losers = 0;
  let grossWins = 0;
  let grossLosses = 0;
  for (const t of trades) {
    if (t.pnlUsd > 0) {
      winners++;
      grossWins += t.pnlUsd;
    } else if (t.pnlUsd < 0) {
      losers++;
      grossLosses += Math.abs(t.pnlUsd);
    }
  }
  const winRatePct = trades.length > 0 ? (winners / trades.length) * 100 : 0;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
  const avgPnlPerTradeUsd =
    trades.length > 0 ? trades.reduce((s, t) => s + t.pnlUsd, 0) / trades.length : 0;

  const calmarRatio = maxDDPct > 0 ? annualizedReturnPct / maxDDPct : 0;

  return {
    totalReturnPct,
    annualizedReturnPct,
    sharpeRatio,
    maxDrawdownPct: maxDDPct,
    winRatePct,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
    calmarRatio,
    avgPnlPerTradeUsd,
    totalTrades: trades.length,
    winningTrades: winners,
    losingTrades: losers,
    totalCostsUsd,
  };
}
