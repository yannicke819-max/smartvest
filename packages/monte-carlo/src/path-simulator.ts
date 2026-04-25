/**
 * Simulation d'une trajectoire unique.
 *
 * À partir d'un état initial (capital, prix de référence par ticker),
 * applique horizonDays rendements bootstrappés et fait tourner la
 * mock-Lisa à chaque jour pour ouvrir/fermer des positions.
 *
 * Pour rester rapide (1000 paths × 30 jours = 30k itérations), on utilise
 * une mock-Lisa SIMPLIFIÉE : pas de signaux techniques basés sur historique
 * (pas de RSI, pas de Bollinger — ils nécessiteraient 20j de candles
 * fictives) → on génère des propositions basées uniquement sur le rendement
 * cumulé récent et l'anti-consensus.
 *
 * Ce raccourci est volontaire : Monte Carlo ne cherche pas à modéliser la
 * stratégie à la perfection, mais à explorer la sensibilité au bruit.
 */

import { applyFee, applySlippage, type TickerHistory } from '@smartvest/backtest';
import { markOption } from '@smartvest/options';
import type { DailyReturns } from './bootstrap';
import type { MonteCarloConfig } from './types';

interface SyntheticOption {
  symbol: string;
  assetClass: string;
  kind: 'call' | 'put';
  strike: number;
  expiry: string;
  contracts: number;
  premiumPaid: number;
  notionalUsd: number; // = premium payé
  iv: number;
  /** Date d'ouverture pour DTE calcul. */
  entryDate: string;
}

export interface SyntheticPosition {
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  notionalUsd: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  daysHeld: number;
  convictionScore: number;
}

export interface PathState {
  cashUsd: number;
  positions: SyntheticPosition[];
  options: SyntheticOption[];
  /** Prix courant simulé par ticker. */
  currentPrices: Map<string, number>;
  /** Historique equity pour drawdown. */
  equityCurve: number[];
  /** Date courante (pour calcul DTE des options). */
  currentDate: string;
}

export interface SimulationContext {
  config: MonteCarloConfig;
  histories: TickerHistory[];
  returnsTable: DailyReturns[];
  /** Prix de référence à asOfDate, par ticker. */
  initialPrices: Map<string, number>;
  /** Asset class par ticker. */
  assetClassBySymbol: Map<string, string>;
}

const ANTI_CONSENSUS_THRESHOLD_BASE = 10;

/**
 * Calcule le rendement N-jours d'un ticker dans le path simulé. Utilisé pour
 * détecter momentum (anti-consensus rejette les rendements positifs trop
 * forts).
 */
function recentReturnPct(
  state: PathState,
  symbol: string,
  initialPrices: Map<string, number>,
): number {
  const initial = initialPrices.get(symbol);
  const current = state.currentPrices.get(symbol);
  if (!initial || !current || initial <= 0) return 0;
  return ((current - initial) / initial) * 100;
}

/**
 * Heuristique simplifiée : génère des propositions pour le jour courant.
 *  - Rejette les tickers en momentum > seuil anti-consensus
 *  - Préfère les tickers en pullback (return négatif récent) — long
 *  - Préfère les tickers en run-up extrême — short (mean reversion)
 */
function generateSimpleProposals(
  state: PathState,
  ctx: SimulationContext,
  rng: () => number,
): Array<{ symbol: string; direction: 'long' | 'short'; convictionScore: number }> {
  const proposals: Array<{ symbol: string; direction: 'long' | 'short'; convictionScore: number }> = [];
  const consensusThreshold = ANTI_CONSENSUS_THRESHOLD_BASE - ctx.config.antiConsensusStrength;

  for (const symbol of ctx.initialPrices.keys()) {
    // Skip si déjà détenu
    if (state.positions.some((p) => p.symbol === symbol)) continue;

    const ret = recentReturnPct(state, symbol, ctx.initialPrices);
    // Anti-consensus filter
    if (Math.abs(ret) > consensusThreshold && ctx.config.antiConsensusStrength > 3) continue;

    // Setup détection : pullback significatif → long, run-up extreme → short
    if (ret < -3 && ret > -15) {
      proposals.push({ symbol, direction: 'long', convictionScore: 6 + Math.min(2, Math.floor(-ret / 5)) });
    } else if (ret > 5 && ret < 15) {
      proposals.push({ symbol, direction: 'short', convictionScore: 6 + Math.min(2, Math.floor(ret / 8)) });
    }
  }

  // Bruit RNG pour casser les ex aequo (sinon les paths produisent les
  // mêmes propositions par déterminisme).
  for (const p of proposals) p.convictionScore += rng() * 0.5;

  proposals.sort((a, b) => b.convictionScore - a.convictionScore);
  return proposals.slice(0, 5);
}

/**
 * Simule une trajectoire complète. Retourne l'état final + courbe d'équité.
 */
export function simulatePath(
  ctx: SimulationContext,
  bootstrapIndices: number[],
  rng: () => number,
): { finalEquity: number; equityCurve: number[]; trades: number; maxDrawdownPct: number } {
  // Date initiale = asOfDate du config. On synthétise des dates suivantes
  // en ajoutant 1 jour calendaire par tick (approximation : on ignore les
  // weekends/jours fériés pour les options DTE — accept tradeoff).
  const startDate = new Date(ctx.config.asOfDate);
  const state: PathState = {
    cashUsd: ctx.config.initialCapitalUsd,
    positions: [],
    options: [],
    currentPrices: new Map(ctx.initialPrices),
    equityCurve: [ctx.config.initialCapitalUsd],
    currentDate: ctx.config.asOfDate,
  };
  let totalTrades = 0;

  // Caps effectifs : avec levier, l'exposition par position et par classe est
  // amplifiée du multiple. Modèle simplifié de marge : cashImpact = notional / leverage.
  const leverageMult = ctx.config.enableLeverage ? ctx.config.maxLeverage : 1.0;
  const maxNotionalPerPosition =
    (ctx.config.initialCapitalUsd * ctx.config.maxPositionSizePct * leverageMult) / 100;
  const maxNotionalPerClass =
    (ctx.config.initialCapitalUsd * ctx.config.maxAssetClassExposurePct * leverageMult) / 100;

  for (let day = 0; day < bootstrapIndices.length; day++) {
    const dayReturns = ctx.returnsTable[bootstrapIndices[day]];
    // Synthétique : avancer la date du calendrier de 1 jour
    const dayDate = new Date(startDate.getTime() + (day + 1) * 86_400_000);
    state.currentDate = dayDate.toISOString().slice(0, 10);

    // 1. Applique les rendements aux prix courants
    for (const [sym, ret] of dayReturns.returnsBySymbol) {
      const cur = state.currentPrices.get(sym);
      if (cur != null) state.currentPrices.set(sym, cur * (1 + ret));
    }

    // 1bis. Check exits options (expiration ou TP×2)
    const stillOpenOpt: SyntheticOption[] = [];
    for (const opt of state.options) {
      const spot = state.currentPrices.get(opt.symbol);
      if (spot == null) {
        stillOpenOpt.push(opt);
        continue;
      }
      // Expiration : DTE calculé entre dates ISO
      const expired = state.currentDate >= opt.expiry;
      const mark = markOption({
        spot,
        strike: opt.strike,
        expiryDate: opt.expiry,
        asOfDate: state.currentDate,
        iv: opt.iv,
        kind: opt.kind,
        contracts: opt.contracts,
        premiumPaid: opt.premiumPaid,
      });
      if (expired || mark.totalValueUsd >= opt.premiumPaid * 2) {
        const fee = applyFee(mark.totalValueUsd, ctx.config.feeBps);
        state.cashUsd += mark.totalValueUsd - fee;
        totalTrades++;
      } else {
        stillOpenOpt.push(opt);
      }
    }
    state.options = stillOpenOpt;

    // 2. Vérifie les exits sur positions ouvertes
    const stillOpen: SyntheticPosition[] = [];
    for (const pos of state.positions) {
      const curPrice = state.currentPrices.get(pos.symbol);
      if (curPrice == null) {
        stillOpen.push(pos);
        continue;
      }
      let exitPrice: number | null = null;
      if (pos.direction === 'long') {
        if (curPrice <= pos.stopLossPrice) exitPrice = pos.stopLossPrice;
        else if (curPrice >= pos.takeProfitPrice) exitPrice = pos.takeProfitPrice;
      } else {
        if (curPrice >= pos.stopLossPrice) exitPrice = pos.stopLossPrice;
        else if (curPrice <= pos.takeProfitPrice) exitPrice = pos.takeProfitPrice;
      }
      pos.daysHeld++;
      if (exitPrice == null && pos.daysHeld >= ctx.config.maxHorizonDays) {
        exitPrice = curPrice;
      }
      if (exitPrice != null) {
        const slip = applySlippage(exitPrice, pos.quantity, 'close', pos.direction, ctx.config.slippageBps);
        const fee = applyFee(Math.abs(slip.effectivePrice * pos.quantity), ctx.config.feeBps);
        const pnl =
          pos.direction === 'long'
            ? (slip.effectivePrice - pos.entryPrice) * pos.quantity - fee
            : (pos.entryPrice - slip.effectivePrice) * pos.quantity - fee;
        // Rendre la marge engagée + PnL net.
        state.cashUsd += pos.notionalUsd / leverageMult + pnl;
        totalTrades++;
      } else {
        stillOpen.push(pos);
      }
    }
    state.positions = stillOpen;

    // 3. Génère propositions et ouvre si capacité dispo
    const proposals = generateSimpleProposals(state, ctx, rng);
    if (state.positions.length + state.options.length < ctx.config.maxOpenPositions) {
      const exposureByClass = new Map<string, number>();
      for (const p of state.positions) {
        exposureByClass.set(p.assetClass, (exposureByClass.get(p.assetClass) ?? 0) + p.notionalUsd);
      }

      for (const prop of proposals) {
        if (state.positions.length + state.options.length >= ctx.config.maxOpenPositions) break;
        const cls = ctx.assetClassBySymbol.get(prop.symbol) ?? 'unknown';
        const classExposure = exposureByClass.get(cls) ?? 0;
        const remainingClass = maxNotionalPerClass - classExposure;
        if (remainingClass <= 0) continue;
        const maxByPosition = Math.min(maxNotionalPerPosition, remainingClass);
        const targetNotional = maxByPosition * Math.max(0.4, prop.convictionScore / 10);

        const curPrice = state.currentPrices.get(prop.symbol);
        if (!curPrice || curPrice <= 0) continue;

        // Si options activées ET conviction ≥ 8 : ouvrir un long call (long)
        // ou long put (short) à la place du sous-jacent. Asymétrie naturelle :
        // downside borné au premium, upside levier implicite par delta.
        if (ctx.config.enableOptions && prop.convictionScore >= 8) {
          const otm = ctx.config.strikeOtmPct / 100;
          const optKind: 'call' | 'put' = prop.direction === 'long' ? 'call' : 'put';
          const strike = optKind === 'call' ? curPrice * (1 + otm) : curPrice * (1 - otm);
          const expiryDate = new Date(state.currentDate);
          expiryDate.setUTCDate(expiryDate.getUTCDate() + ctx.config.optionsDte);
          const expiry = expiryDate.toISOString().slice(0, 10);
          const oneContract = markOption({
            spot: curPrice,
            strike,
            expiryDate: expiry,
            asOfDate: state.currentDate,
            iv: ctx.config.defaultIv,
            kind: optKind,
            contracts: 1,
            premiumPaid: 0,
          });
          if (oneContract.totalValueUsd <= 0) continue;
          const contracts = Math.floor(targetNotional / oneContract.totalValueUsd);
          if (contracts < 1) continue;
          const premiumPaid = oneContract.totalValueUsd * contracts;
          const fee = applyFee(premiumPaid, ctx.config.feeBps);
          if (premiumPaid + fee > state.cashUsd * 0.95) continue;

          state.options.push({
            symbol: prop.symbol,
            assetClass: cls,
            kind: optKind,
            strike,
            expiry,
            contracts,
            premiumPaid,
            notionalUsd: premiumPaid,
            iv: ctx.config.defaultIv,
            entryDate: state.currentDate,
          });
          state.cashUsd -= premiumPaid + fee;
          exposureByClass.set(cls, classExposure + premiumPaid);
          continue;
        }

        // Cash impact = notional / leverage (modèle margin simplifié).
        const targetCashImpact = targetNotional / leverageMult;
        const cashCap = state.cashUsd * 0.95;
        if (targetCashImpact > cashCap) continue; // pas assez de marge
        const notional = targetNotional;
        if (notional < 50) continue;

        const slip = applySlippage(curPrice, 0, 'open', prop.direction, ctx.config.slippageBps);
        const fee = applyFee(notional, ctx.config.feeBps);
        const effectivePrice = slip.effectivePrice;
        const quantity = (notional - fee) / effectivePrice;

        const stopPrice =
          prop.direction === 'long'
            ? effectivePrice * (1 - ctx.config.stopLossPct / 100)
            : effectivePrice * (1 + ctx.config.stopLossPct / 100);
        const tpPrice =
          prop.direction === 'long'
            ? effectivePrice * (1 + ctx.config.takeProfitPct / 100)
            : effectivePrice * (1 - ctx.config.takeProfitPct / 100);

        state.positions.push({
          symbol: prop.symbol,
          assetClass: cls,
          direction: prop.direction,
          quantity,
          entryPrice: effectivePrice,
          notionalUsd: notional,
          stopLossPrice: stopPrice,
          takeProfitPrice: tpPrice,
          daysHeld: 0,
          convictionScore: Math.floor(prop.convictionScore),
        });
        // Cash impact = notional / leverage (margin model). Sans levier =
        // notional complet. Avec levier, on consume moins de cash pour même
        // exposition.
        state.cashUsd -= notional / leverageMult;
        exposureByClass.set(cls, classExposure + notional);
      }
    }

    // 4. Snapshot equity (mark-to-market)
    // Avec levier, l'equity = cash + (mark-to-market exposition - margin déjà mise).
    // Pour simplifier : on tracke le P&L latent comme (current - entry) × qty,
    // et l'equity = cashUsd + sum(margin_engagee + pnl_latent) où margin_engagee
    // = entry_notional / leverage.
    let positionsValue = 0;
    for (const p of state.positions) {
      const cur = state.currentPrices.get(p.symbol) ?? p.entryPrice;
      const pnl =
        p.direction === 'long'
          ? (cur - p.entryPrice) * p.quantity
          : (p.entryPrice - cur) * p.quantity;
      const marginEngagee = p.notionalUsd / leverageMult;
      positionsValue += marginEngagee + pnl;
    }
    // Mark-to-market options
    for (const opt of state.options) {
      const spot = state.currentPrices.get(opt.symbol) ?? opt.strike;
      const m = markOption({
        spot,
        strike: opt.strike,
        expiryDate: opt.expiry,
        asOfDate: state.currentDate,
        iv: opt.iv,
        kind: opt.kind,
        contracts: opt.contracts,
        premiumPaid: opt.premiumPaid,
      });
      positionsValue += m.totalValueUsd;
    }
    state.equityCurve.push(state.cashUsd + positionsValue);
  }

  // Force close remaining options
  for (const opt of state.options) {
    const spot = state.currentPrices.get(opt.symbol) ?? opt.strike;
    const m = markOption({
      spot,
      strike: opt.strike,
      expiryDate: opt.expiry,
      asOfDate: state.currentDate,
      iv: opt.iv,
      kind: opt.kind,
      contracts: opt.contracts,
      premiumPaid: opt.premiumPaid,
    });
    const fee = applyFee(m.totalValueUsd, ctx.config.feeBps);
    state.cashUsd += m.totalValueUsd - fee;
    totalTrades++;
  }

  // Force close remaining positions au prix courant final
  for (const pos of state.positions) {
    const cur = state.currentPrices.get(pos.symbol) ?? pos.entryPrice;
    const slip = applySlippage(cur, pos.quantity, 'close', pos.direction, ctx.config.slippageBps);
    const fee = applyFee(Math.abs(slip.effectivePrice * pos.quantity), ctx.config.feeBps);
    const pnl =
      pos.direction === 'long'
        ? (slip.effectivePrice - pos.entryPrice) * pos.quantity - fee
        : (pos.entryPrice - slip.effectivePrice) * pos.quantity - fee;
    state.cashUsd += pos.notionalUsd / leverageMult + pnl;
    totalTrades++;
  }
  const finalEquity = state.cashUsd;

  // Drawdown
  let peak = state.equityCurve[0];
  let maxDD = 0;
  for (const v of state.equityCurve) {
    if (v > peak) peak = v;
    const dd = ((peak - v) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    finalEquity,
    equityCurve: state.equityCurve,
    trades: totalTrades,
    maxDrawdownPct: maxDD,
  };
}
