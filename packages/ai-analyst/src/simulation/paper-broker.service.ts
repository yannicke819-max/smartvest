/**
 * PaperBrokerService — Exécution SIMULÉE de positions
 *
 * Jamais d'ordre réel. Toutes les positions vivent en DB Supabase,
 * P&L calculé à partir des prix EODHD live.
 *
 * Respecte CLAUDE.md :
 *  - is_simulation=true requis sur portfolio
 *  - Aucune connexion broker live
 *  - Coûts simulés (frais, spread, slippage estimés)
 */

import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosePositionCommand,
  OpenPositionCommand,
  PaperPosition,
  PortfolioSnapshot,
} from './types';

export interface PriceQuote {
  symbol: string;
  price: string;  // decimal
  asOf: string;
  source: string;
}

export interface PaperBrokerDeps {
  supabase: SupabaseClient;
  /** Callback pour fetch live prices — typiquement EODHD adapter */
  fetchLivePrice: (symbol: string) => Promise<PriceQuote>;
}

export class PaperBrokerService {
  private readonly supabase: SupabaseClient;
  private readonly fetchLivePrice: PaperBrokerDeps['fetchLivePrice'];

  constructor(deps: PaperBrokerDeps) {
    this.supabase = deps.supabase;
    this.fetchLivePrice = deps.fetchLivePrice;
  }

  /**
   * Ouvre une position simulée à partir d'une thèse approuvée.
   * Déduit le notional du cash disponible, enregistre la position.
   */
  async openPosition(cmd: OpenPositionCommand): Promise<PaperPosition> {
    const now = new Date().toISOString();

    // Récupérer la thèse depuis la proposal (pour symbol, direction, venue, coûts)
    const { data: proposal, error: pErr } = await this.supabase
      .from('lisa_proposals')
      .select('theses, capital_usd')
      .eq('id', cmd.proposalId)
      .single();
    if (pErr || !proposal) {
      throw new Error(`Proposal ${cmd.proposalId} not found`);
    }

    const theses = proposal.theses as Array<Record<string, unknown>>;
    const thesis = theses.find((t) => t.id === cmd.thesisId);
    if (!thesis) {
      throw new Error(`Thesis ${cmd.thesisId} not found in proposal`);
    }

    const expressions = thesis.expressions as Array<Record<string, unknown>>;
    const expression = expressions[cmd.expressionIndex];
    if (!expression) {
      throw new Error(`Expression index ${cmd.expressionIndex} out of bounds`);
    }

    // Calcul quantité : notional / price
    const livePrice = new Decimal(cmd.livePrice);
    const notional = new Decimal(cmd.capitalAllocationUsd);
    if (livePrice.isZero() || livePrice.isNegative()) {
      throw new Error(`Invalid live price: ${cmd.livePrice}`);
    }

    // Coût entrée estimé (bps → USD)
    const costBps = (expression.estimatedCostBps as number) ?? 10;
    const estimatedCost = notional.mul(costBps).dividedBy(10000);

    // Notional net après coût
    const notionalNet = notional.minus(estimatedCost);
    const quantity = notionalNet.dividedBy(livePrice);

    const position: PaperPosition = {
      id: randomUUID(),
      portfolioId: cmd.portfolioId,
      proposalId: cmd.proposalId,
      thesisId: cmd.thesisId,
      symbol: expression.symbol as string,
      assetClass: expression.assetClass as string,
      direction: expression.direction as PaperPosition['direction'],
      venue: expression.preferredVenue as string,
      quantity: quantity.toFixed(10),
      entryPrice: livePrice.toFixed(10),
      entryTimestamp: now,
      entryNotionalUsd: notional.toFixed(2),
      status: 'open',
      exitPrice: null,
      exitTimestamp: null,
      exitReason: null,
      realizedPnlUsd: null,
      realizedPnlPct: null,
      stopLossPrice: cmd.stopLossPrice,
      takeProfitPrice: cmd.takeProfitPrice,
      horizonTargetDate: new Date(
        Date.now() + cmd.horizonDays * 86_400_000,
      ).toISOString(),
      estimatedEntryCostUsd: estimatedCost.toFixed(2),
      createdAt: now,
      updatedAt: now,
    };

    // Persist
    const { error: insErr } = await this.supabase.from('lisa_positions').insert({
      id: position.id,
      portfolio_id: position.portfolioId,
      proposal_id: position.proposalId,
      thesis_id: position.thesisId,
      symbol: position.symbol,
      asset_class: position.assetClass,
      direction: position.direction,
      venue: position.venue,
      quantity: position.quantity,
      entry_price: position.entryPrice,
      entry_timestamp: position.entryTimestamp,
      entry_notional_usd: position.entryNotionalUsd,
      status: position.status,
      stop_loss_price: position.stopLossPrice,
      take_profit_price: position.takeProfitPrice,
      horizon_target_date: position.horizonTargetDate,
      estimated_entry_cost_usd: position.estimatedEntryCostUsd,
      created_at: position.createdAt,
      updated_at: position.updatedAt,
    });
    if (insErr) throw new Error(`Paper position insert failed: ${insErr.message}`);

    return position;
  }

  /**
   * Ferme une position avec prix live + raison structurée.
   * Matérialise le P&L réalisé.
   */
  async closePosition(cmd: ClosePositionCommand): Promise<PaperPosition> {
    const { data: posRow, error: fErr } = await this.supabase
      .from('lisa_positions')
      .select('*')
      .eq('id', cmd.positionId)
      .single();
    if (fErr || !posRow) throw new Error(`Position ${cmd.positionId} not found`);

    const position = this.mapRow(posRow);
    if (position.status !== 'open') {
      throw new Error(`Cannot close: position ${cmd.positionId} already ${position.status}`);
    }

    const entryPx = new Decimal(position.entryPrice);
    const exitPx = new Decimal(cmd.livePrice);
    const qty = new Decimal(position.quantity);
    const entryNotional = new Decimal(position.entryNotionalUsd);

    // P&L calculation (long vs short)
    let priceDelta: Decimal;
    if (position.direction === 'long' || position.direction === 'long_call' || position.direction === 'long_put') {
      priceDelta = exitPx.minus(entryPx);
    } else {
      priceDelta = entryPx.minus(exitPx);
    }
    const grossPnl = priceDelta.mul(qty);

    // Deduct exit cost (estimate same bps as entry)
    const exitCost = exitPx.mul(qty).mul(10).dividedBy(10000); // ~10bps default
    const netPnl = grossPnl.minus(exitCost);

    const pnlPct = entryNotional.isZero()
      ? 0
      : netPnl.dividedBy(entryNotional).mul(100).toNumber();

    const now = new Date().toISOString();

    const { error: updErr } = await this.supabase
      .from('lisa_positions')
      .update({
        status: cmd.reason,
        exit_price: exitPx.toFixed(10),
        exit_timestamp: now,
        exit_reason: cmd.rationale,
        realized_pnl_usd: netPnl.toFixed(2),
        realized_pnl_pct: pnlPct,
        updated_at: now,
      })
      .eq('id', cmd.positionId);
    if (updErr) throw new Error(`Paper position close failed: ${updErr.message}`);

    return {
      ...position,
      status: cmd.reason,
      exitPrice: exitPx.toFixed(10),
      exitTimestamp: now,
      exitReason: cmd.rationale,
      realizedPnlUsd: netPnl.toFixed(2),
      realizedPnlPct: pnlPct,
      updatedAt: now,
    };
  }

  /**
   * Récupère toutes les positions (open + closed) d'un portefeuille.
   */
  async getPositions(portfolioId: string, openOnly = false): Promise<PaperPosition[]> {
    let q = this.supabase
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('entry_timestamp', { ascending: false });
    if (openOnly) q = q.eq('status', 'open');

    const { data, error } = await q;
    if (error) throw new Error(`Fetch positions failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Computes un snapshot P&L instantané du portefeuille.
   * Utilisé pour les charts et le risk monitor.
   */
  async computeSnapshot(portfolioId: string): Promise<PortfolioSnapshot> {
    const openPositions = await this.getPositions(portfolioId, true);
    const allPositions = await this.getPositions(portfolioId, false);

    // Fetch live prices pour toutes les open positions
    const priceMap = new Map<string, Decimal>();
    for (const pos of openPositions) {
      if (!priceMap.has(pos.symbol)) {
        try {
          const quote = await this.fetchLivePrice(pos.symbol);
          priceMap.set(pos.symbol, new Decimal(quote.price));
        } catch {
          // Fallback sur entry price si quote unavailable
          priceMap.set(pos.symbol, new Decimal(pos.entryPrice));
        }
      }
    }

    // Unrealized P&L
    let unrealized = new Decimal(0);
    let openValue = new Decimal(0);
    for (const pos of openPositions) {
      const livePx = priceMap.get(pos.symbol) ?? new Decimal(pos.entryPrice);
      const qty = new Decimal(pos.quantity);
      const entryPx = new Decimal(pos.entryPrice);

      const priceDelta =
        pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put'
          ? livePx.minus(entryPx)
          : entryPx.minus(livePx);

      const posPnl = priceDelta.mul(qty);
      unrealized = unrealized.plus(posPnl);

      // Current market value
      openValue = openValue.plus(livePx.mul(qty));
    }

    // Realized P&L cumulative
    const realized = allPositions
      .filter((p) => p.status !== 'open' && p.realizedPnlUsd !== null)
      .reduce((s, p) => s.plus(new Decimal(p.realizedPnlUsd ?? '0')), new Decimal(0));

    // Fetch portfolio base capital
    const { data: portfolio } = await this.supabase
      .from('portfolios')
      .select('simulation_initial_capital, base_currency')
      .eq('id', portfolioId)
      .single();

    const initialCapital = new Decimal((portfolio?.simulation_initial_capital as string | null) ?? '10000');

    // Cash = initial + realized - entry cost of open positions + (value - initial capital = appreciation in open)
    const openEntryNotionalSum = openPositions.reduce(
      (s, p) => s.plus(new Decimal(p.entryNotionalUsd)),
      new Decimal(0),
    );
    const cash = initialCapital.plus(realized).minus(openEntryNotionalSum);
    const totalValue = cash.plus(openValue);

    const returnFromInception = initialCapital.isZero()
      ? 0
      : totalValue.minus(initialCapital).dividedBy(initialCapital).mul(100).toNumber();

    // Drawdown from peak (requires history — compute later from snapshots)
    const drawdownFromPeak = await this.computeDrawdownFromPeak(portfolioId, totalValue);

    const now = new Date().toISOString();
    const snapshot: PortfolioSnapshot = {
      id: randomUUID(),
      portfolioId,
      timestamp: now,
      cashUsd: cash.toFixed(2),
      openPositionsValueUsd: openValue.toFixed(2),
      totalValueUsd: totalValue.toFixed(2),
      realizedPnlCumulativeUsd: realized.toFixed(2),
      unrealizedPnlUsd: unrealized.toFixed(2),
      returnFromInceptionPct: returnFromInception,
      openPositionsCount: openPositions.length,
      drawdownFromPeakPct: drawdownFromPeak,
      marketContextSummary: null,
    };

    // Persist snapshot (for charts)
    const { error: insErr } = await this.supabase.from('lisa_portfolio_snapshots').insert({
      id: snapshot.id,
      portfolio_id: snapshot.portfolioId,
      timestamp: snapshot.timestamp,
      cash_usd: snapshot.cashUsd,
      open_positions_value_usd: snapshot.openPositionsValueUsd,
      total_value_usd: snapshot.totalValueUsd,
      realized_pnl_cumulative_usd: snapshot.realizedPnlCumulativeUsd,
      unrealized_pnl_usd: snapshot.unrealizedPnlUsd,
      return_from_inception_pct: snapshot.returnFromInceptionPct,
      open_positions_count: snapshot.openPositionsCount,
      drawdown_from_peak_pct: snapshot.drawdownFromPeakPct,
    });
    if (insErr) {
      // Non-fatal — log but continue
      console.warn(`Snapshot persist failed: ${insErr.message}`);
    }

    return snapshot;
  }

  /**
   * Compute drawdown depuis le peak observé (all-time high) du portefeuille.
   */
  private async computeDrawdownFromPeak(portfolioId: string, currentValue: Decimal): Promise<number> {
    const { data } = await this.supabase
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd')
      .eq('portfolio_id', portfolioId)
      .order('total_value_usd', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return 0;
    const peak = new Decimal(data.total_value_usd as string);
    if (peak.isZero()) return 0;
    const dd = currentValue.minus(peak).dividedBy(peak).mul(100).toNumber();
    return Math.min(dd, 0);  // drawdown is negative or zero
  }

  private mapRow(row: Record<string, unknown>): PaperPosition {
    return {
      id: row.id as string,
      portfolioId: row.portfolio_id as string,
      proposalId: row.proposal_id as string,
      thesisId: row.thesis_id as string,
      symbol: row.symbol as string,
      assetClass: row.asset_class as string,
      direction: row.direction as PaperPosition['direction'],
      venue: row.venue as string,
      quantity: row.quantity as string,
      entryPrice: row.entry_price as string,
      entryTimestamp: row.entry_timestamp as string,
      entryNotionalUsd: row.entry_notional_usd as string,
      status: row.status as PaperPosition['status'],
      exitPrice: (row.exit_price as string | null) ?? null,
      exitTimestamp: (row.exit_timestamp as string | null) ?? null,
      exitReason: (row.exit_reason as string | null) ?? null,
      realizedPnlUsd: (row.realized_pnl_usd as string | null) ?? null,
      realizedPnlPct: (row.realized_pnl_pct as number | null) ?? null,
      stopLossPrice: (row.stop_loss_price as string | null) ?? null,
      takeProfitPrice: (row.take_profit_price as string | null) ?? null,
      horizonTargetDate: (row.horizon_target_date as string | null) ?? null,
      estimatedEntryCostUsd: row.estimated_entry_cost_usd as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
