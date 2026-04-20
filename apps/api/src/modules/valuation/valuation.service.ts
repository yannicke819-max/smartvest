import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface PositionValuation {
  positionId: string;
  assetId: string;
  ticker: string;
  assetClass: string;
  quantity: string;
  averageCost: string;
  costCurrency: string;
  currentPrice: string | null;
  priceCurrency: string | null;
  marketValue: string;
  costBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
  priceAsOf: string | null;
  marketState: string;
  changePercent: string | null;
}

export interface PortfolioValuation {
  portfolioId: string;
  currency: string;
  totalMarketValue: string;
  totalCostBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
  positionCount: number;
  valuedAt: string;
  positions: PositionValuation[];
}

export interface AllocationBreakdown {
  byClass: Record<string, { value: string; weight: number }>;
  byCurrency: Record<string, { value: string; weight: number }>;
}

export interface PerformanceSummary {
  portfolioId: string;
  totalMarketValue: string;
  totalCostBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
  topGainer: { ticker: string; pnlPercent: string } | null;
  topLoser: { ticker: string; pnlPercent: string } | null;
  positionCount: number;
}

@Injectable()
export class ValuationService {
  constructor(private readonly supabase: SupabaseService) {}

  async getPortfolioValuation(portfolioId: string): Promise<PortfolioValuation> {
    if (!this.supabase.isReady()) return this.emptyValuation(portfolioId);

    const client = this.supabase.getClient();

    const [posRes, quotesRes, portfolioRes] = await Promise.all([
      client
        .from('positions')
        .select('id, quantity, average_cost, cost_currency, assets(id, ticker, name, asset_class, currency), portfolio_accounts!inner(portfolio_id)')
        .eq('portfolio_accounts.portfolio_id', portfolioId)
        .is('closed_at', null),
      client.from('latest_quotes').select('*'),
      client.from('portfolios').select('currency').eq('id', portfolioId).single(),
    ]);

    const positions = posRes.data ?? [];
    const portfolioCurrency = (portfolioRes.data?.currency as string) ?? 'EUR';

    const quoteMap: Record<string, typeof quotesRes.data extends (infer T)[] | null ? T : never> = {};
    for (const q of quotesRes.data ?? []) {
      quoteMap[q.asset_id as string] = q;
    }

    let totalMarketValue = new Decimal(0);
    let totalCostBasis = new Decimal(0);
    const positionValuations: PositionValuation[] = [];

    for (const p of positions) {
      const asset = p.assets as { id: string; ticker: string; asset_class: string; currency: string } | null;
      const qty = new Decimal(p.quantity as string);
      const avgCost = new Decimal(p.average_cost as string);
      const costBasis = qty.mul(avgCost).abs();

      const quote = asset ? quoteMap[asset.id] : null;
      const currentPrice = quote ? new Decimal(String(quote.price)) : null;
      const marketValue = currentPrice ? qty.mul(currentPrice).abs() : costBasis;

      totalCostBasis = totalCostBasis.plus(costBasis);
      totalMarketValue = totalMarketValue.plus(marketValue);

      const pnlAbsolute = marketValue.minus(costBasis);
      const pnlPercent = costBasis.isZero()
        ? new Decimal(0)
        : pnlAbsolute.div(costBasis).mul(100);

      positionValuations.push({
        positionId: p.id as string,
        assetId: asset?.id ?? '',
        ticker: asset?.ticker ?? '',
        assetClass: asset?.asset_class ?? 'other',
        quantity: String(p.quantity),
        averageCost: String(p.average_cost),
        costCurrency: p.cost_currency as string,
        currentPrice: currentPrice?.toFixed(10) ?? null,
        priceCurrency: asset?.currency ?? null,
        marketValue: marketValue.toFixed(2),
        costBasis: costBasis.toFixed(2),
        pnlAbsolute: pnlAbsolute.toFixed(2),
        pnlPercent: pnlPercent.toFixed(4),
        priceAsOf: quote ? String(quote.as_of) : null,
        marketState: quote ? String(quote.market_state ?? 'unknown') : 'unknown',
        changePercent: quote?.change_percent ? String(quote.change_percent) : null,
      });
    }

    const totalPnl = totalMarketValue.minus(totalCostBasis);
    const totalPnlPct = totalCostBasis.isZero()
      ? new Decimal(0)
      : totalPnl.div(totalCostBasis).mul(100);

    return {
      portfolioId,
      currency: portfolioCurrency,
      totalMarketValue: totalMarketValue.toFixed(2),
      totalCostBasis: totalCostBasis.toFixed(2),
      pnlAbsolute: totalPnl.toFixed(2),
      pnlPercent: totalPnlPct.toFixed(4),
      positionCount: positionValuations.length,
      valuedAt: new Date().toISOString(),
      positions: positionValuations,
    };
  }

  async getAllocationBreakdown(portfolioId: string): Promise<AllocationBreakdown> {
    const valuation = await this.getPortfolioValuation(portfolioId);
    const total = new Decimal(valuation.totalMarketValue);

    const byClass: Record<string, Decimal> = {};
    const byCurrency: Record<string, Decimal> = {};

    for (const pos of valuation.positions) {
      const mv = new Decimal(pos.marketValue);
      byClass[pos.assetClass] = (byClass[pos.assetClass] ?? new Decimal(0)).plus(mv);
      const cur = pos.priceCurrency ?? pos.costCurrency;
      byCurrency[cur] = (byCurrency[cur] ?? new Decimal(0)).plus(mv);
    }

    const totalNum = total.toNumber();
    const toBreakdown = (map: Record<string, Decimal>) =>
      Object.fromEntries(
        Object.entries(map).map(([k, v]) => [
          k,
          { value: v.toFixed(2), weight: totalNum > 0 ? v.div(total).toNumber() : 0 },
        ]),
      );

    return {
      byClass: toBreakdown(byClass),
      byCurrency: toBreakdown(byCurrency),
    };
  }

  async getPerformanceSummary(portfolioId: string): Promise<PerformanceSummary> {
    const valuation = await this.getPortfolioValuation(portfolioId);

    let topGainer: { ticker: string; pnlPercent: string } | null = null;
    let topLoser: { ticker: string; pnlPercent: string } | null = null;
    let maxPnl = new Decimal(-Infinity);
    let minPnl = new Decimal(Infinity);

    for (const pos of valuation.positions) {
      const pnl = new Decimal(pos.pnlPercent);
      if (pnl.gt(maxPnl)) {
        maxPnl = pnl;
        topGainer = { ticker: pos.ticker, pnlPercent: pos.pnlPercent };
      }
      if (pnl.lt(minPnl)) {
        minPnl = pnl;
        topLoser = { ticker: pos.ticker, pnlPercent: pos.pnlPercent };
      }
    }

    return {
      portfolioId,
      totalMarketValue: valuation.totalMarketValue,
      totalCostBasis: valuation.totalCostBasis,
      pnlAbsolute: valuation.pnlAbsolute,
      pnlPercent: valuation.pnlPercent,
      topGainer,
      topLoser,
      positionCount: valuation.positionCount,
    };
  }

  private emptyValuation(portfolioId: string): PortfolioValuation {
    return {
      portfolioId,
      currency: 'EUR',
      totalMarketValue: '0.00',
      totalCostBasis: '0.00',
      pnlAbsolute: '0.00',
      pnlPercent: '0.0000',
      positionCount: 0,
      valuedAt: new Date().toISOString(),
      positions: [],
    };
  }
}
