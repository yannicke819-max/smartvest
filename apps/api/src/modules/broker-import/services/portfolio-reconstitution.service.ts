import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface ReconstitutedPosition {
  assetId: string;
  accountId: string;
  quantity: string;
  averageCost: string;
  costCurrency: string;
  lastTradeDate: string;
}

export interface ReconstitutionResult {
  portfolioId: string;
  positionsReconstituted: number;
  positionsClosed: number;
  cashMovements: number;
  firstTradeDate: string | null;
  lastTradeDate: string | null;
}

/**
 * Walks a portfolio's full transaction history in chronological order and
 * rebuilds the current positions + running average cost per position.
 *
 * Convention:
 *  - buy:  quantity += qty ; avg_cost = (old_value + qty*price + fees) / new_quantity
 *  - sell: quantity -= qty ; avg_cost unchanged (realized P&L is not tracked here)
 *  - when quantity reaches 0, the position is marked closed
 */
@Injectable()
export class PortfolioReconstitutionService {
  private readonly logger = new Logger(PortfolioReconstitutionService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async reconstitute(portfolioId: string): Promise<ReconstitutionResult> {
    if (!this.supabase.isReady()) {
      return this.emptyResult(portfolioId);
    }

    const client = this.supabase.getClient();

    const { data: txs, error } = await client
      .from('transactions')
      .select('id, type, trade_date, quantity, unit_price, currency, asset_id, account_id, portfolio_accounts!inner(portfolio_id)')
      .eq('portfolio_accounts.portfolio_id', portfolioId)
      .in('type', ['buy', 'sell'])
      .order('trade_date', { ascending: true });

    if (error || !txs) {
      this.logger.error(`reconstitute fetch failed: ${error?.message}`);
      return this.emptyResult(portfolioId);
    }

    type PositionKey = string; // `${accountId}|${assetId}`
    const positions = new Map<PositionKey, {
      accountId: string;
      assetId: string;
      quantity: Decimal;
      totalCost: Decimal;
      currency: string;
      lastTradeDate: string;
    }>();

    let firstDate: string | null = null;
    let lastDate: string | null = null;
    let cashMovements = 0;

    for (const tx of txs) {
      if (!tx.asset_id || !tx.account_id) continue;
      if (!firstDate) firstDate = tx.trade_date as string;
      lastDate = tx.trade_date as string;

      const key: PositionKey = `${tx.account_id}|${tx.asset_id}`;
      const qty = new Decimal(String(tx.quantity ?? 0));
      const price = new Decimal(String(tx.unit_price ?? 0));

      const existing = positions.get(key) ?? {
        accountId: tx.account_id as string,
        assetId: tx.asset_id as string,
        quantity: new Decimal(0),
        totalCost: new Decimal(0),
        currency: (tx.currency as string) ?? 'EUR',
        lastTradeDate: tx.trade_date as string,
      };

      if (tx.type === 'buy') {
        existing.totalCost = existing.totalCost.plus(qty.mul(price));
        existing.quantity = existing.quantity.plus(qty);
      } else if (tx.type === 'sell') {
        // Reduce quantity but keep running avg cost proportional
        if (!existing.quantity.isZero()) {
          const avgBefore = existing.totalCost.div(existing.quantity);
          existing.quantity = existing.quantity.minus(qty);
          existing.totalCost = existing.quantity.lte(0)
            ? new Decimal(0)
            : avgBefore.mul(existing.quantity);
        }
      }

      existing.lastTradeDate = tx.trade_date as string;
      positions.set(key, existing);
      cashMovements++;
    }

    // Upsert positions
    let positionsReconstituted = 0;
    let positionsClosed = 0;

    for (const [, p] of positions) {
      if (p.quantity.lte(0)) {
        // Close any existing row
        await client
          .from('positions')
          .update({ closed_at: p.lastTradeDate })
          .eq('account_id', p.accountId)
          .eq('asset_id', p.assetId)
          .is('closed_at', null);
        positionsClosed++;
        continue;
      }

      const avgCost = p.totalCost.div(p.quantity).toFixed(10);

      // Check existing open position
      const { data: existing } = await client
        .from('positions')
        .select('id')
        .eq('account_id', p.accountId)
        .eq('asset_id', p.assetId)
        .is('closed_at', null)
        .limit(1);

      if (existing && existing.length > 0) {
        await client
          .from('positions')
          .update({
            quantity: p.quantity.toFixed(10),
            average_cost: avgCost,
            cost_currency: p.currency,
          })
          .eq('id', existing[0].id);
      } else {
        await client.from('positions').insert({
          account_id: p.accountId,
          asset_id: p.assetId,
          quantity: p.quantity.toFixed(10),
          average_cost: avgCost,
          cost_currency: p.currency,
          opened_at: p.lastTradeDate,
        });
      }
      positionsReconstituted++;
    }

    return {
      portfolioId,
      positionsReconstituted,
      positionsClosed,
      cashMovements,
      firstTradeDate: firstDate,
      lastTradeDate: lastDate,
    };
  }

  private emptyResult(portfolioId: string): ReconstitutionResult {
    return {
      portfolioId,
      positionsReconstituted: 0,
      positionsClosed: 0,
      cashMovements: 0,
      firstTradeDate: null,
      lastTradeDate: null,
    };
  }
}
