/**
 * Runner Monte Carlo : orchestre N simulations en mémoire.
 *
 * Boucle principale :
 *   1. Construit la table des rendements bootstrappables (1 pass sur les histories)
 *   2. Pour chaque path (1..N) :
 *        a. Tire horizonDays indices aléatoires dans la table
 *        b. Lance simulatePath() → equity curve + final equity
 *   3. Agrège les statistiques (percentiles, VaR, probabilités, fan chart)
 *
 * Performance : ~1ms par path pour 17 tickers × 30 jours en horizon. 1000 paths
 * = ~1 seconde. 10000 paths = ~10 secondes. Acceptable pour run synchrone.
 *
 * Pas de parallélisation Worker pour rester portable et simple — le bottleneck
 * réel est le data fetch EODHD au démarrage.
 */

import type { TickerHistory } from '@smartvest/backtest';
import { DEFAULT_UNIVERSE } from '@smartvest/backtest';
import { buildDailyReturnsTable, createRng, sampleIndices } from './bootstrap';
import { simulatePath, type SimulationContext } from './path-simulator';
import { buildFanChart, buildHistogram, computeStatistics, type PathSummary } from './statistics';
import type { MonteCarloConfig, MonteCarloResult } from './types';

export interface RunnerInput {
  config: MonteCarloConfig;
  histories: TickerHistory[];
  warnings: string[];
}

export function runMonteCarlo(input: RunnerInput): MonteCarloResult {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { config, histories, warnings: initialWarnings } = input;
  const warnings = [...initialWarnings];

  // 1. Build returns table
  const returnsTable = buildDailyReturnsTable(histories, config.asOfDate, config.lookbackDays);
  if (returnsTable.length < 10) {
    warnings.push(`Table de bootstrap insuffisante : ${returnsTable.length} jours seulement (min recommandé 30).`);
  }

  // 2. Setup context
  const initialPrices = new Map<string, number>();
  const assetClassBySymbol = new Map<string, string>();
  for (const h of histories) {
    // Prix le plus récent <= asOfDate
    const latest = [...h.candles].reverse().find((c) => c.date <= config.asOfDate);
    if (latest) initialPrices.set(h.symbol, latest.close);
    assetClassBySymbol.set(h.symbol, h.assetClass);
  }
  // Si aucun ticker custom n'est fourni, prendre tous ceux disponibles dans
  // le DEFAULT_UNIVERSE (asset_class connu).
  for (const u of DEFAULT_UNIVERSE) {
    if (!assetClassBySymbol.has(u.symbol)) assetClassBySymbol.set(u.symbol, u.assetClass);
  }

  const ctx: SimulationContext = {
    config,
    histories,
    returnsTable,
    initialPrices,
    assetClassBySymbol,
  };

  // 3. Run N paths
  const seed = config.randomSeed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = createRng(seed);

  const summaries: PathSummary[] = [];
  const equityCurves: number[][] = [];
  const finalEquities: number[] = [];

  for (let i = 0; i < config.numPaths; i++) {
    const indices = sampleIndices(returnsTable.length, config.horizonDays, rng);
    if (indices.length === 0) {
      warnings.push('Path skip : table de rendements vide.');
      continue;
    }
    const result = simulatePath(ctx, indices, rng);
    const returnPct = ((result.finalEquity - config.initialCapitalUsd) / config.initialCapitalUsd) * 100;
    summaries.push({
      finalEquity: result.finalEquity,
      returnPct,
      maxDrawdownPct: result.maxDrawdownPct,
    });
    equityCurves.push(result.equityCurve);
    finalEquities.push(result.finalEquity);
  }

  // 4. Aggregate
  const statistics = computeStatistics(summaries, config.initialCapitalUsd, config.targetEquityUsd);
  const histogram = buildHistogram(finalEquities, 30);
  const fanChart = buildFanChart(equityCurves);

  return {
    config,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    statistics,
    fanChart,
    histogram,
    warnings,
  };
}
