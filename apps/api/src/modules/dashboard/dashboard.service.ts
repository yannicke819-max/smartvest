import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

@Injectable()
export class DashboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getSummary(portfolioId: string) {
    if (!this.supabase.isReady()) return this.emptyResponse(portfolioId);
    const client = this.supabase.getClient();

    const [posRes, txRes, quotesRes] = await Promise.all([
      client
        .from('positions')
        .select('id, quantity, average_cost, cost_currency, assets(id, ticker, name, asset_class, currency), portfolio_accounts!inner(portfolio_id)')
        .eq('portfolio_accounts.portfolio_id', portfolioId)
        .is('closed_at', null),
      client
        .from('transactions')
        .select('id, type, trade_date, quantity, unit_price, currency, execution, assets(ticker, name), portfolio_accounts!inner(portfolio_id)')
        .eq('portfolio_accounts.portfolio_id', portfolioId)
        .order('trade_date', { ascending: false })
        .limit(10),
      client.from('latest_quotes').select('*'),
    ]);

    const positions = posRes.data ?? [];
    const transactions = txRes.data ?? [];
    const quotes: Record<string, number> = {};
    for (const q of quotesRes.data ?? []) {
      quotes[q.asset_id as string] = parseFloat(q.price as string);
    }

    let totalCost = new Decimal(0);
    let totalValue = new Decimal(0);
    const allocationByClass: Record<string, Decimal> = {};

    for (const p of positions) {
      const qty = new Decimal(p.quantity as string);
      const avgCost = new Decimal(p.average_cost as string);
      const positionCost = qty.mul(avgCost).abs();
      totalCost = totalCost.plus(positionCost);

      const assetId = (p.assets as any)?.id ?? '';
      const quote = quotes[assetId];
      const positionValue = quote ? qty.mul(new Decimal(quote)).abs() : positionCost;
      totalValue = totalValue.plus(positionValue);

      const cls: string = (p.assets as any)?.asset_class ?? 'other';
      allocationByClass[cls] = (allocationByClass[cls] ?? new Decimal(0)).plus(positionValue);
    }

    const pnlAbsolute = totalValue.minus(totalCost);
    const pnlPercent = totalCost.isZero()
      ? new Decimal(0)
      : pnlAbsolute.div(totalCost).mul(100);

    const totalValueNum = totalValue.toNumber();
    const normalizedAllocation: Record<string, number> = {};
    for (const [cls, val] of Object.entries(allocationByClass)) {
      normalizedAllocation[cls] = totalValueNum > 0 ? val.div(totalValueNum).toNumber() : 0;
    }

    return {
      portfolioId,
      totalValue: totalValue.toFixed(2),
      totalCost: totalCost.toFixed(2),
      pnlAbsolute: pnlAbsolute.toFixed(2),
      pnlPercent: pnlPercent.toFixed(2),
      positionCount: positions.length,
      allocationByClass: normalizedAllocation,
      recentTransactions: transactions,
    };
  }

  private emptyResponse(portfolioId: string) {
    return {
      portfolioId,
      totalValue: '0',
      totalCost: '0',
      pnlAbsolute: '0',
      pnlPercent: '0',
      positionCount: 0,
      allocationByClass: {},
      recentTransactions: [],
    };
  }
}
