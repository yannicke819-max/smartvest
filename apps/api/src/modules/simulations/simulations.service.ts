import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ValuationService } from '../valuation/valuation.service';
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface RebalanceTarget {
  assetClass: string;
  targetWeight: number; // 0-1
}

export interface RebalanceTrade {
  assetId: string;
  ticker: string;
  assetClass: string;
  currentValue: string;
  targetValue: string;
  delta: string; // positive = buy, negative = sell
  deltaPercent: string;
  currentWeight: number;
  targetWeight: number;
}

export interface RebalancePreview {
  portfolioId: string;
  totalValue: string;
  currency: string;
  currentAllocation: Record<string, number>;
  targetAllocation: Record<string, number>;
  trades: RebalanceTrade[];
  estimatedCost: string;
  simulatedAt: string;
  scenarioRunId: string | null;
}

export interface ContributionPreview {
  portfolioId: string;
  contributionAmount: string;
  currency: string;
  totalValueBefore: string;
  totalValueAfter: string;
  suggestedBuys: Array<{
    assetId: string;
    ticker: string;
    assetClass: string;
    suggestedAmount: string;
    currentWeight: number;
    targetWeight: number;
  }>;
  simulatedAt: string;
  scenarioRunId: string | null;
}

const DEFAULT_TARGETS: Record<string, Record<string, number>> = {
  prudent:    { bond: 0.60, etf: 0.25, cash: 0.10, equity: 0.05 },
  equilibre:  { etf: 0.50, bond: 0.30, equity: 0.15, cash: 0.05 },
  dynamique:  { etf: 0.60, equity: 0.25, bond: 0.10, cash: 0.05 },
  offensif:   { etf: 0.55, equity: 0.35, crypto: 0.07, cash: 0.03 },
  sur_mesure: { etf: 0.50, equity: 0.30, bond: 0.15, cash: 0.05 },
};

@Injectable()
export class SimulationsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly valuation: ValuationService,
  ) {}

  async previewRebalance(
    portfolioId: string,
    targets?: RebalanceTarget[],
  ): Promise<RebalancePreview> {
    const val = await this.valuation.getPortfolioValuation(portfolioId);
    const totalValue = new Decimal(val.totalMarketValue);

    // Determine target allocation
    let targetAllocation: Record<string, number>;
    if (targets && targets.length > 0) {
      targetAllocation = Object.fromEntries(targets.map((t) => [t.assetClass, t.targetWeight]));
    } else {
      const riskProfile = await this.getPortfolioRiskProfile(portfolioId);
      targetAllocation = DEFAULT_TARGETS[riskProfile] ?? DEFAULT_TARGETS['equilibre'];
    }

    // Current allocation by class
    const currentByClass: Record<string, Decimal> = {};
    for (const pos of val.positions) {
      const mv = new Decimal(pos.marketValue);
      currentByClass[pos.assetClass] = (currentByClass[pos.assetClass] ?? new Decimal(0)).plus(mv);
    }

    const currentAllocation: Record<string, number> = {};
    for (const [cls, mv] of Object.entries(currentByClass)) {
      currentAllocation[cls] = totalValue.isZero() ? 0 : mv.div(totalValue).toNumber();
    }

    // Aggregate positions by class for trade suggestions
    const classByAsset: Record<string, { assetId: string; ticker: string; value: Decimal }[]> = {};
    for (const pos of val.positions) {
      if (!classByAsset[pos.assetClass]) classByAsset[pos.assetClass] = [];
      const existing = classByAsset[pos.assetClass].find((x) => x.assetId === pos.assetId);
      if (existing) {
        existing.value = existing.value.plus(new Decimal(pos.marketValue));
      } else {
        classByAsset[pos.assetClass].push({
          assetId: pos.assetId,
          ticker: pos.ticker,
          value: new Decimal(pos.marketValue),
        });
      }
    }

    const trades: RebalanceTrade[] = [];
    const allClasses = new Set([
      ...Object.keys(currentByClass),
      ...Object.keys(targetAllocation),
    ]);

    for (const cls of allClasses) {
      const targetWeight = targetAllocation[cls] ?? 0;
      const currentValue = currentByClass[cls] ?? new Decimal(0);
      const targetValue = totalValue.mul(targetWeight);
      const delta = targetValue.minus(currentValue);

      const assetGroup = classByAsset[cls];
      const representativeAsset = assetGroup?.[0];

      if (!representativeAsset && delta.lte(0)) continue;

      trades.push({
        assetId: representativeAsset?.assetId ?? '',
        ticker: representativeAsset?.ticker ?? cls,
        assetClass: cls,
        currentValue: currentValue.toFixed(2),
        targetValue: targetValue.toFixed(2),
        delta: delta.toFixed(2),
        deltaPercent: totalValue.isZero()
          ? '0'
          : delta.div(totalValue).mul(100).toFixed(2),
        currentWeight: currentAllocation[cls] ?? 0,
        targetWeight,
      });
    }

    const scenarioRunId = await this.storeScenarioRun(portfolioId, 'rebalance', {
      targetAllocation,
      totalValue: val.totalMarketValue,
    });

    return {
      portfolioId,
      totalValue: val.totalMarketValue,
      currency: val.currency,
      currentAllocation,
      targetAllocation,
      trades: trades.sort((a, b) => Math.abs(parseFloat(b.delta)) - Math.abs(parseFloat(a.delta))),
      estimatedCost: '0.00', // cost-engine integration in Phase 4
      simulatedAt: new Date().toISOString(),
      scenarioRunId,
    };
  }

  async previewContribution(
    portfolioId: string,
    amount: string,
    currency: string,
  ): Promise<ContributionPreview> {
    const val = await this.valuation.getPortfolioValuation(portfolioId);
    const totalValueBefore = new Decimal(val.totalMarketValue);
    const contribution = new Decimal(amount);
    const totalValueAfter = totalValueBefore.plus(contribution);

    const riskProfile = await this.getPortfolioRiskProfile(portfolioId);
    const targetAllocation = DEFAULT_TARGETS[riskProfile] ?? DEFAULT_TARGETS['equilibre'];

    // Current weights
    const currentByClass: Record<string, Decimal> = {};
    for (const pos of val.positions) {
      const mv = new Decimal(pos.marketValue);
      currentByClass[pos.assetClass] = (currentByClass[pos.assetClass] ?? new Decimal(0)).plus(mv);
    }

    // Best representatives per class
    const representativeByClass: Record<string, { assetId: string; ticker: string }> = {};
    for (const pos of val.positions) {
      if (!representativeByClass[pos.assetClass]) {
        representativeByClass[pos.assetClass] = { assetId: pos.assetId, ticker: pos.ticker };
      }
    }

    const suggestedBuys: ContributionPreview['suggestedBuys'] = [];
    for (const [cls, targetWeight] of Object.entries(targetAllocation)) {
      const currentValue = currentByClass[cls] ?? new Decimal(0);
      const currentWeight = totalValueBefore.isZero()
        ? 0
        : currentValue.div(totalValueBefore).toNumber();

      const gap = targetWeight - currentWeight;
      if (gap <= 0) continue;

      const suggestedAmount = contribution.mul(gap / Object.values(targetAllocation).reduce((s, w) => s + Math.max(0, w - (currentByClass[cls] ? currentByClass[cls].div(totalValueBefore).toNumber() : 0)), 0) || 1);

      const rep = representativeByClass[cls];
      if (!rep) continue;

      suggestedBuys.push({
        assetId: rep.assetId,
        ticker: rep.ticker,
        assetClass: cls,
        suggestedAmount: suggestedAmount.toFixed(2),
        currentWeight,
        targetWeight,
      });
    }

    // Normalize suggested amounts to sum to contribution
    const totalSuggested = suggestedBuys.reduce(
      (s, b) => s.plus(new Decimal(b.suggestedAmount)),
      new Decimal(0),
    );
    if (!totalSuggested.isZero()) {
      for (const b of suggestedBuys) {
        b.suggestedAmount = new Decimal(b.suggestedAmount)
          .div(totalSuggested)
          .mul(contribution)
          .toFixed(2);
      }
    }

    const scenarioRunId = await this.storeScenarioRun(portfolioId, 'contribution', {
      amount,
      currency,
      totalValueBefore: val.totalMarketValue,
    });

    return {
      portfolioId,
      contributionAmount: contribution.toFixed(2),
      currency,
      totalValueBefore: totalValueBefore.toFixed(2),
      totalValueAfter: totalValueAfter.toFixed(2),
      suggestedBuys: suggestedBuys.sort(
        (a, b) => parseFloat(b.suggestedAmount) - parseFloat(a.suggestedAmount),
      ),
      simulatedAt: new Date().toISOString(),
      scenarioRunId,
    };
  }

  private async getPortfolioRiskProfile(portfolioId: string): Promise<string> {
    if (!this.supabase.isReady()) return 'equilibre';
    const { data } = await this.supabase
      .getClient()
      .from('portfolios')
      .select('risk_profile_id')
      .eq('id', portfolioId)
      .single();
    return (data?.risk_profile_id as string) ?? 'equilibre';
  }

  private async storeScenarioRun(
    portfolioId: string,
    kind: string,
    params: Record<string, unknown>,
  ): Promise<string | null> {
    if (!this.supabase.isReady()) return null;
    const { data } = await this.supabase
      .getClient()
      .from('scenario_runs')
      .insert({
        portfolio_id: portfolioId,
        kind,
        parameters: params,
        result: {},
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    return (data?.id as string) ?? null;
  }
}
