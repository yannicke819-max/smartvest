import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../supabase/supabase.service';
import { ValuationService } from '../valuation/valuation.service';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface PortfolioHistoryPoint {
  date: string;
  marketValue: string;
  costBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
}

export interface PerformanceMetrics {
  portfolioId: string;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  totalReturnPct: string;         // cumulative (vs starting value)
  annualizedReturnPct: string | null;
  volatility: string | null;      // annualized stddev of daily returns
  maxDrawdownPct: string;         // worst peak-to-trough decline
  currentDrawdownPct: string;
  dayCount: number;
  positiveDays: number;
  negativeDays: number;
}

export interface BenchmarkComparison {
  portfolioId: string;
  benchmarkId: string | null;
  benchmarkTicker: string | null;
  benchmarkName: string | null;
  portfolioReturnPct: string;
  benchmarkReturnPct: string | null;
  excessReturnPct: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  series: Array<{ date: string; portfolio: string; benchmark: string | null }>;
}

const TRADING_DAYS_YEAR = 252;

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly valuation: ValuationService,
  ) {}

  /** Snapshot the current portfolio state into portfolio_history_snapshots for today. */
  async takeSnapshot(portfolioId: string): Promise<{ date: string; saved: boolean }> {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.supabase.isReady()) return { date: today, saved: false };

    const val = await this.valuation.getPortfolioValuation(portfolioId);
    const allocationByClass: Record<string, number> = {};
    const total = new Decimal(val.totalMarketValue);
    for (const p of val.positions) {
      const mv = new Decimal(p.marketValue);
      const cls = p.assetClass;
      allocationByClass[cls] = (allocationByClass[cls] ?? 0) + (total.isZero() ? 0 : mv.div(total).toNumber());
    }

    const { error } = await this.supabase.getClient().from('portfolio_history_snapshots').upsert({
      portfolio_id: portfolioId,
      as_of_date: today,
      currency: val.currency,
      total_market_value: val.totalMarketValue,
      total_cost_basis: val.totalCostBasis,
      cash_balance: '0',
      pnl_absolute: val.pnlAbsolute,
      pnl_percent: val.pnlPercent,
      position_count: val.positionCount,
      allocation_snapshot: allocationByClass,
    }, { onConflict: 'portfolio_id,as_of_date' });

    if (error) { this.logger.warn(`snapshot failed: ${error.message}`); return { date: today, saved: false }; }
    return { date: today, saved: true };
  }

  async getHistory(portfolioId: string, fromDate?: string, toDate?: string): Promise<PortfolioHistoryPoint[]> {
    if (!this.supabase.isReady()) return [];
    let q = this.supabase
      .getClient()
      .from('portfolio_history_snapshots')
      .select('as_of_date, total_market_value, total_cost_basis, pnl_absolute, pnl_percent')
      .eq('portfolio_id', portfolioId)
      .order('as_of_date', { ascending: true });
    if (fromDate) q = q.gte('as_of_date', fromDate);
    if (toDate) q = q.lte('as_of_date', toDate);

    const { data } = await q;
    return (data ?? []).map((d) => ({
      date: d.as_of_date as string,
      marketValue: String(d.total_market_value),
      costBasis: String(d.total_cost_basis),
      pnlAbsolute: String(d.pnl_absolute),
      pnlPercent: String(d.pnl_percent),
    }));
  }

  async computeMetrics(portfolioId: string): Promise<PerformanceMetrics> {
    const history = await this.getHistory(portfolioId);
    const val = await this.valuation.getPortfolioValuation(portfolioId);

    if (history.length < 2) {
      return {
        portfolioId,
        currency: val.currency,
        periodStart: history[0]?.date ?? null,
        periodEnd: history[history.length - 1]?.date ?? null,
        totalReturnPct: '0.00',
        annualizedReturnPct: null,
        volatility: null,
        maxDrawdownPct: '0.00',
        currentDrawdownPct: '0.00',
        dayCount: history.length,
        positiveDays: 0,
        negativeDays: 0,
      };
    }

    const values = history.map((h) => new Decimal(h.marketValue));
    const startValue = values[0];
    const endValue = values[values.length - 1];

    const totalReturn = startValue.isZero()
      ? new Decimal(0)
      : endValue.minus(startValue).div(startValue).mul(100);

    // Daily returns
    const returns: Decimal[] = [];
    let positive = 0;
    let negative = 0;
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      if (prev.isZero()) continue;
      const r = values[i].minus(prev).div(prev);
      returns.push(r);
      if (r.gt(0)) positive++;
      else if (r.lt(0)) negative++;
    }

    // Annualized volatility
    let volatility: string | null = null;
    if (returns.length >= 2) {
      const meanR = returns.reduce((s, r) => s.plus(r), new Decimal(0)).div(returns.length);
      const variance = returns
        .reduce((s, r) => s.plus(r.minus(meanR).pow(2)), new Decimal(0))
        .div(returns.length - 1);
      const stddev = variance.sqrt();
      volatility = stddev.mul(Math.sqrt(TRADING_DAYS_YEAR)).mul(100).toFixed(4);
    }

    // Annualized return
    const dayCount = history.length;
    const yearsElapsed = new Decimal(dayCount).div(TRADING_DAYS_YEAR);
    let annualizedReturn: string | null = null;
    if (yearsElapsed.gt(0.1) && !startValue.isZero()) {
      // (1 + totalReturn/100)^(1/years) - 1
      const ratio = endValue.div(startValue).toNumber();
      if (ratio > 0) {
        const annualized = Math.pow(ratio, 1 / yearsElapsed.toNumber()) - 1;
        annualizedReturn = (annualized * 100).toFixed(4);
      }
    }

    // Max drawdown
    let peak = values[0];
    let maxDrawdown = new Decimal(0);
    for (const v of values) {
      if (v.gt(peak)) peak = v;
      const drawdown = peak.isZero() ? new Decimal(0) : peak.minus(v).div(peak);
      if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
    }
    const currentPeak = values.reduce((m, v) => (v.gt(m) ? v : m), values[0]);
    const currentDrawdown = currentPeak.isZero()
      ? new Decimal(0)
      : currentPeak.minus(endValue).div(currentPeak);

    return {
      portfolioId,
      currency: val.currency,
      periodStart: history[0].date,
      periodEnd: history[history.length - 1].date,
      totalReturnPct: totalReturn.toFixed(4),
      annualizedReturnPct: annualizedReturn,
      volatility,
      maxDrawdownPct: maxDrawdown.mul(100).toFixed(4),
      currentDrawdownPct: currentDrawdown.mul(100).toFixed(4),
      dayCount,
      positiveDays: positive,
      negativeDays: negative,
    };
  }

  async compareToBenchmark(portfolioId: string): Promise<BenchmarkComparison> {
    if (!this.supabase.isReady()) return this.emptyBenchmark(portfolioId);
    const client = this.supabase.getClient();

    const { data: portfolio } = await client
      .from('portfolios')
      .select('benchmark_id')
      .eq('id', portfolioId)
      .single();

    const benchmarkId = (portfolio?.benchmark_id as string) ?? null;
    if (!benchmarkId) return this.emptyBenchmark(portfolioId);

    const { data: benchmark } = await client
      .from('benchmarks')
      .select('ticker, name')
      .eq('id', benchmarkId)
      .single();

    const history = await this.getHistory(portfolioId);
    if (history.length < 2) {
      return {
        portfolioId,
        benchmarkId,
        benchmarkTicker: (benchmark?.ticker as string) ?? null,
        benchmarkName: (benchmark?.name as string) ?? null,
        portfolioReturnPct: '0.00',
        benchmarkReturnPct: null,
        excessReturnPct: null,
        periodStart: history[0]?.date ?? null,
        periodEnd: history[history.length - 1]?.date ?? null,
        series: [],
      };
    }

    const startDate = history[0].date;
    const endDate = history[history.length - 1].date;

    const { data: bench } = await client
      .from('benchmark_series')
      .select('as_of_date, close')
      .eq('benchmark_id', benchmarkId)
      .gte('as_of_date', startDate)
      .lte('as_of_date', endDate)
      .order('as_of_date', { ascending: true });

    const benchByDate: Record<string, Decimal> = {};
    for (const b of bench ?? []) {
      benchByDate[b.as_of_date as string] = new Decimal(String(b.close));
    }

    const benchDates = Object.keys(benchByDate).sort();
    const benchStart = benchDates.length > 0 ? benchByDate[benchDates[0]] : null;
    const benchEnd = benchDates.length > 0 ? benchByDate[benchDates[benchDates.length - 1]] : null;

    const portfolioStart = new Decimal(history[0].marketValue);
    const portfolioEnd = new Decimal(history[history.length - 1].marketValue);
    const portfolioReturn = portfolioStart.isZero()
      ? new Decimal(0)
      : portfolioEnd.minus(portfolioStart).div(portfolioStart).mul(100);

    const benchmarkReturn = benchStart && benchEnd && !benchStart.isZero()
      ? benchEnd.minus(benchStart).div(benchStart).mul(100)
      : null;

    // Series: normalize both to 100 at start for a clean comparison
    const series = history.map((h) => {
      const portfolioNorm = portfolioStart.isZero()
        ? new Decimal(100)
        : new Decimal(h.marketValue).div(portfolioStart).mul(100);
      const benchValue = benchByDate[h.date];
      const benchmarkNorm = benchValue && benchStart && !benchStart.isZero()
        ? benchValue.div(benchStart).mul(100).toFixed(4)
        : null;
      return {
        date: h.date,
        portfolio: portfolioNorm.toFixed(4),
        benchmark: benchmarkNorm,
      };
    });

    return {
      portfolioId,
      benchmarkId,
      benchmarkTicker: (benchmark?.ticker as string) ?? null,
      benchmarkName: (benchmark?.name as string) ?? null,
      portfolioReturnPct: portfolioReturn.toFixed(4),
      benchmarkReturnPct: benchmarkReturn ? benchmarkReturn.toFixed(4) : null,
      excessReturnPct: benchmarkReturn ? portfolioReturn.minus(benchmarkReturn).toFixed(4) : null,
      periodStart: startDate,
      periodEnd: endDate,
      series,
    };
  }

  private emptyBenchmark(portfolioId: string): BenchmarkComparison {
    return {
      portfolioId,
      benchmarkId: null,
      benchmarkTicker: null,
      benchmarkName: null,
      portfolioReturnPct: '0.00',
      benchmarkReturnPct: null,
      excessReturnPct: null,
      periodStart: null,
      periodEnd: null,
      series: [],
    };
  }
}
