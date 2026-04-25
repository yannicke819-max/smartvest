/**
 * Runner : boucle principale du backtest.
 *
 * Itère chronologiquement sur les dates de trading. Pour chaque jour :
 *   1. Vérifie les positions ouvertes : stops, take-profits, horizon expiré
 *   2. Ferme les positions touchées (avec slippage + fees)
 *   3. Génère les nouvelles propositions via lisa-mock
 *   4. Filtre selon caps (asset class, position max, total positions)
 *   5. Ouvre les meilleures (avec slippage + fees + sizing conviction)
 *   6. Snapshot la valeur du portefeuille (equity curve)
 *
 * En fin de boucle : ferme toutes les positions encore ouvertes au prix
 * de close du dernier jour (forced_eob — end of backtest).
 */

import { randomUUID } from 'node:crypto';
import { applyFee, applySlippage } from './slippage';
import { candleAt, generateProposals, closeAt } from './lisa-mock';
import { extractTradingDates } from './data-replay';
import type {
  BacktestConfig,
  BacktestPosition,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  TickerHistory,
} from './types';

interface RunnerInput {
  config: BacktestConfig;
  histories: TickerHistory[];
  warnings: string[];
}

export function runBacktest(input: RunnerInput): BacktestResult {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const { config, histories, warnings } = input;

  const tradingDates = extractTradingDates(histories);
  if (tradingDates.length === 0) {
    return {
      config,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      metrics: {
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
        totalCostsUsd: 0,
      },
      equityCurve: [],
      trades: [],
      warnings: [...warnings, 'Aucune date de trading dans la fenêtre — univers vide ou EODHD échec total.'],
    };
  }

  // État interne
  let cashUsd = config.initialCapitalUsd;
  const openPositions: BacktestPosition[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let totalCostsUsd = 0;

  const historyBySymbol = new Map<string, TickerHistory>();
  for (const h of histories) historyBySymbol.set(h.symbol, h);

  // Boucle principale
  for (const date of tradingDates) {
    // 1. Check exits sur positions ouvertes
    const stillOpen: BacktestPosition[] = [];
    for (const pos of openPositions) {
      const hist = historyBySymbol.get(pos.symbol);
      if (!hist) {
        stillOpen.push(pos);
        continue;
      }
      const candle = candleAt(hist, date);
      if (!candle) {
        // Pas de candle ce jour-là (jour férié sur ce marché) → on garde
        stillOpen.push(pos);
        continue;
      }

      let exitReason: BacktestTrade['exitReason'] | null = null;
      let exitPrice: number | null = null;

      // Stop-loss : touché si low ≤ stop (long) ou high ≥ stop (short)
      if (pos.direction === 'long' && candle.low <= pos.stopLossPrice) {
        exitReason = 'stop_loss';
        exitPrice = pos.stopLossPrice;
      } else if (pos.direction === 'short' && candle.high >= pos.stopLossPrice) {
        exitReason = 'stop_loss';
        exitPrice = pos.stopLossPrice;
      }
      // Take-profit : si pas déjà touché par stop
      else if (pos.direction === 'long' && candle.high >= pos.takeProfitPrice) {
        exitReason = 'take_profit';
        exitPrice = pos.takeProfitPrice;
      } else if (pos.direction === 'short' && candle.low <= pos.takeProfitPrice) {
        exitReason = 'take_profit';
        exitPrice = pos.takeProfitPrice;
      }
      // Horizon expiré
      else if (date >= pos.horizonDate) {
        exitReason = 'horizon_expired';
        exitPrice = candle.close;
      }

      if (exitReason && exitPrice != null) {
        // Slippage défavorable + fee
        const slip = applySlippage(exitPrice, pos.quantity, 'close', pos.direction, config.slippageBps);
        const fee = applyFee(Math.abs(slip.effectivePrice * pos.quantity), config.feeBps);
        const proceeds = pos.direction === 'long'
          ? slip.effectivePrice * pos.quantity - fee
          : (2 * pos.entryPrice - slip.effectivePrice) * pos.quantity - fee; // short P&L

        const pnlUsd =
          pos.direction === 'long'
            ? (slip.effectivePrice - pos.entryPrice) * pos.quantity - fee
            : (pos.entryPrice - slip.effectivePrice) * pos.quantity - fee;

        cashUsd += pos.notionalUsd + pnlUsd;
        totalCostsUsd += fee + slip.slippageCostUsd;

        trades.push({
          symbol: pos.symbol,
          assetClass: pos.assetClass,
          direction: pos.direction,
          entryDate: pos.entryDate,
          exitDate: date,
          entryPrice: pos.entryPrice,
          exitPrice: slip.effectivePrice,
          quantity: pos.quantity,
          notionalUsd: pos.notionalUsd,
          pnlUsd,
          pnlPct: (pnlUsd / pos.notionalUsd) * 100,
          exitReason,
          convictionScore: pos.convictionScore,
        });
        // Position fermée — pas dans stillOpen
        void proceeds;
      } else {
        stillOpen.push(pos);
      }
    }
    openPositions.length = 0;
    openPositions.push(...stillOpen);

    // 2. Génère les propositions du jour
    const proposals = generateProposals(histories, date, config.antiConsensusStrength);

    // 3. Filtre selon caps + budget cash + positions max
    if (openPositions.length < config.maxOpenPositions) {
      // Calcul exposition courante par classe
      const exposureByClass = new Map<string, number>();
      let totalExposure = 0;
      for (const p of openPositions) {
        exposureByClass.set(p.assetClass, (exposureByClass.get(p.assetClass) ?? 0) + p.notionalUsd);
        totalExposure += p.notionalUsd;
      }

      const maxNotionalPerPosition =
        (config.initialCapitalUsd * config.maxPositionSizePct) / 100;
      const maxNotionalPerClass =
        (config.initialCapitalUsd * config.maxAssetClassExposurePct) / 100;

      // Pour chaque proposition triée par conviction, tenter d'ouvrir
      for (const prop of proposals) {
        if (openPositions.length >= config.maxOpenPositions) break;
        // Skip si déjà détenu (pas de double-position sur le même symbol)
        if (openPositions.some((p) => p.symbol === prop.symbol)) continue;

        // Cap par classe
        const classExposure = exposureByClass.get(prop.assetClass) ?? 0;
        const remainingClass = maxNotionalPerClass - classExposure;
        if (remainingClass <= 0) continue;

        // Cap par position
        const maxByPosition = Math.min(maxNotionalPerPosition, remainingClass);

        // Sizing conviction : 50 % à conviction 6, 100 % à conviction 10
        const convictionMultiplier = Math.max(0.4, Math.min(1, prop.convictionScore / 10));
        const targetNotional = maxByPosition * convictionMultiplier;

        // Cash disponible (95 % max — buffer 5 %)
        const availCash = cashUsd * 0.95;
        const notional = Math.min(targetNotional, availCash);
        if (notional < 50) continue; // trop petit, skip

        // Récupère le prix d'ouverture du jour
        const hist = historyBySymbol.get(prop.symbol);
        if (!hist) continue;
        const candle = candleAt(hist, date);
        if (!candle) continue;
        const openPrice = candle.open;
        if (openPrice <= 0) continue;

        // Slippage + fee
        const slip = applySlippage(openPrice, 0, 'open', prop.direction, config.slippageBps);
        const fee = applyFee(notional, config.feeBps);
        const effectivePrice = slip.effectivePrice;
        const quantity = (notional - fee) / effectivePrice;

        const stopPrice =
          prop.direction === 'long'
            ? effectivePrice * (1 - prop.stopLossPct / 100)
            : effectivePrice * (1 + prop.stopLossPct / 100);
        const tpPrice =
          prop.direction === 'long'
            ? effectivePrice * (1 + prop.takeProfitPct / 100)
            : effectivePrice * (1 - prop.takeProfitPct / 100);

        const horizonDate = addDays(date, config.maxHorizonDays);

        const newPos: BacktestPosition = {
          id: randomUUID(),
          symbol: prop.symbol,
          assetClass: prop.assetClass,
          direction: prop.direction,
          quantity,
          entryPrice: effectivePrice,
          entryDate: date,
          notionalUsd: notional,
          convictionScore: prop.convictionScore,
          stopLossPrice: stopPrice,
          takeProfitPrice: tpPrice,
          horizonDate,
        };
        openPositions.push(newPos);
        cashUsd -= notional;
        totalExposure += notional;
        exposureByClass.set(prop.assetClass, classExposure + notional);
        totalCostsUsd += fee + slip.slippageCostUsd;
      }
    }

    // 4. Snapshot equity
    let positionsUsd = 0;
    for (const p of openPositions) {
      const hist = historyBySymbol.get(p.symbol);
      if (!hist) {
        positionsUsd += p.notionalUsd;
        continue;
      }
      const candle = candleAt(hist, date);
      const mark = candle ? candle.close : p.entryPrice;
      const value =
        p.direction === 'long'
          ? mark * p.quantity
          : (2 * p.entryPrice - mark) * p.quantity;
      positionsUsd += value;
    }
    const equityUsd = cashUsd + positionsUsd;
    const peak = equityCurve.length > 0 ? Math.max(...equityCurve.map((e) => e.equityUsd), equityUsd) : equityUsd;
    const drawdownPct = peak > 0 ? ((peak - equityUsd) / peak) * 100 : 0;
    equityCurve.push({
      date,
      equityUsd,
      cashUsd,
      positionsUsd,
      openPositions: openPositions.length,
      drawdownPct,
    });
  }

  // 5. Forced close à la fin
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const pos of openPositions) {
    const hist = historyBySymbol.get(pos.symbol);
    if (!hist) continue;
    const lastClose = closeAt(hist, lastDate);
    if (lastClose == null) continue;
    const slip = applySlippage(lastClose, pos.quantity, 'close', pos.direction, config.slippageBps);
    const fee = applyFee(Math.abs(slip.effectivePrice * pos.quantity), config.feeBps);
    const pnlUsd =
      pos.direction === 'long'
        ? (slip.effectivePrice - pos.entryPrice) * pos.quantity - fee
        : (pos.entryPrice - slip.effectivePrice) * pos.quantity - fee;
    cashUsd += pos.notionalUsd + pnlUsd;
    totalCostsUsd += fee + slip.slippageCostUsd;
    trades.push({
      symbol: pos.symbol,
      assetClass: pos.assetClass,
      direction: pos.direction,
      entryDate: pos.entryDate,
      exitDate: lastDate,
      entryPrice: pos.entryPrice,
      exitPrice: slip.effectivePrice,
      quantity: pos.quantity,
      notionalUsd: pos.notionalUsd,
      pnlUsd,
      pnlPct: (pnlUsd / pos.notionalUsd) * 100,
      exitReason: 'forced_eob',
      convictionScore: pos.convictionScore,
    });
  }

  // Métriques finales
  // (import différé pour éviter cycle)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeMetrics } = require('./metrics') as typeof import('./metrics');
  const metrics = computeMetrics(equityCurve, trades, config.initialCapitalUsd, totalCostsUsd);

  return {
    config,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    metrics,
    equityCurve,
    trades,
    warnings,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
