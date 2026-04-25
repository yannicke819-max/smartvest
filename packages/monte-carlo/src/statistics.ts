/**
 * Statistiques agrégées sur N trajectoires Monte Carlo.
 *
 * Inclut :
 *  - percentiles classiques (P5/P25/P50/P75/P95)
 *  - probabilités d'événements (P(equity > target), P(perte > X%))
 *  - VaR / CVaR à 95%
 *  - histogramme bucketé pour visualisation
 *  - fan chart : équité au quantile par jour pour superposition
 */

import type { MonteCarloStatistics } from './types';

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const w = idx - lo;
  return sortedValues[lo] * (1 - w) + sortedValues[hi] * w;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface PathSummary {
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
}

export function computeStatistics(
  paths: PathSummary[],
  initialCapital: number,
  targetEquity: number | undefined,
): MonteCarloStatistics {
  const finals = paths.map((p) => p.finalEquity).sort((a, b) => a - b);
  const returns = paths.map((p) => p.returnPct).sort((a, b) => a - b);
  const drawdowns = paths.map((p) => p.maxDrawdownPct).sort((a, b) => a - b);

  const probAboveTarget =
    targetEquity != null
      ? paths.filter((p) => p.finalEquity > targetEquity).length / paths.length
      : null;

  const probLossAbove = {
    lossPct5: paths.filter((p) => p.returnPct < -5).length / paths.length,
    lossPct10: paths.filter((p) => p.returnPct < -10).length / paths.length,
    lossPct15: paths.filter((p) => p.returnPct < -15).length / paths.length,
  };

  // VaR 95% : perte (USD) que 5% des chemins dépassent. CVaR : moyenne dans la queue.
  const lossesUsd = paths.map((p) => Math.max(0, initialCapital - p.finalEquity)).sort((a, b) => a - b);
  const var95Usd = percentile(lossesUsd, 95);
  const tail = lossesUsd.filter((l) => l >= var95Usd);
  const cvar95Usd = tail.length > 0 ? mean(tail) : var95Usd;

  return {
    numPaths: paths.length,
    finalEquity: {
      mean: mean(finals),
      median: percentile(finals, 50),
      p5: percentile(finals, 5),
      p25: percentile(finals, 25),
      p75: percentile(finals, 75),
      p95: percentile(finals, 95),
      min: finals[0] ?? 0,
      max: finals[finals.length - 1] ?? 0,
    },
    returnPct: {
      mean: mean(returns),
      median: percentile(returns, 50),
      p5: percentile(returns, 5),
      p25: percentile(returns, 25),
      p75: percentile(returns, 75),
      p95: percentile(returns, 95),
    },
    maxDrawdownPct: {
      mean: mean(drawdowns),
      median: percentile(drawdowns, 50),
      p95: percentile(drawdowns, 95),
      max: drawdowns[drawdowns.length - 1] ?? 0,
    },
    probAboveTarget,
    probLossAbove,
    var95Usd,
    cvar95Usd,
  };
}

/**
 * Histogramme : bucketise les equities finales en N bins. Utile pour graph.
 */
export function buildHistogram(
  finalEquities: number[],
  numBins: number,
): Array<{ binStart: number; binEnd: number; count: number; pct: number }> {
  if (finalEquities.length === 0) return [];
  const sorted = [...finalEquities].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === max) {
    return [{ binStart: min, binEnd: max, count: finalEquities.length, pct: 100 }];
  }
  const binWidth = (max - min) / numBins;
  const bins = Array.from({ length: numBins }, (_, i) => ({
    binStart: min + i * binWidth,
    binEnd: min + (i + 1) * binWidth,
    count: 0,
    pct: 0,
  }));
  for (const v of finalEquities) {
    const idx = Math.min(numBins - 1, Math.floor((v - min) / binWidth));
    bins[idx].count++;
  }
  for (const b of bins) b.pct = (b.count / finalEquities.length) * 100;
  return bins;
}

/**
 * Fan chart : pour chaque jour de l'horizon, calcule les quantiles de
 * l'équité across paths. Permet de superposer une bande P5-P95 sur le
 * graphique de la trajectoire médiane.
 */
export function buildFanChart(
  equityCurves: number[][],
): Array<{ dayIndex: number; p5: number; p25: number; p50: number; p75: number; p95: number }> {
  if (equityCurves.length === 0) return [];
  const horizonDays = equityCurves[0].length;
  const out: Array<{ dayIndex: number; p5: number; p25: number; p50: number; p75: number; p95: number }> = [];
  for (let day = 0; day < horizonDays; day++) {
    const valuesAtDay: number[] = [];
    for (const curve of equityCurves) {
      if (curve[day] != null) valuesAtDay.push(curve[day]);
    }
    valuesAtDay.sort((a, b) => a - b);
    out.push({
      dayIndex: day,
      p5: percentile(valuesAtDay, 5),
      p25: percentile(valuesAtDay, 25),
      p50: percentile(valuesAtDay, 50),
      p75: percentile(valuesAtDay, 75),
      p95: percentile(valuesAtDay, 95),
    });
  }
  return out;
}
