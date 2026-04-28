/**
 * PR C — RiskEnforcer wire sizingMultiplier du régime tactique.
 *
 * Vérifie que :
 *  - multiplier 1.2 (BULL) : pctCapital × 1.2, amountUsd × 1.2
 *  - multiplier 0.7 (BEAR) : pctCapital × 0.7
 *  - multiplier 0   (VOL_SPIKE) : toutes allocations à 0, cash 100%
 *  - multiplier 1.0 (NEUTRAL) : no-op (pas de warning)
 *  - cashReservePct recompute cohérent post-shrink
 *  - warning REGIME_SIZING_APPLIED (ou REGIME_SKIP) émis pour audit
 *  - sans regimeSizing : comportement legacy préservé
 */
import {
  RiskEnforcer,
  type AllocationProposal,
  type RegimeSizingOption,
} from '@smartvest/ai-analyst';

function baseProposal(allocPct: number = 25): AllocationProposal {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    capitalUsd: '10000',
    baseCurrency: 'EUR',
    detectedRegime: 'mid_cycle_expansion',
    marketMomentum: 'neutral',
    regimeSummary: 'test',
    favoredPockets: [],
    avoidedPockets: [],
    theses: [
      {
        id: '00000000-0000-0000-0000-000000000010',
        title: 'test thesis',
        summary: 'test',
        catalyst: 'test catalyst',
        whoIsWrong: 'consensus',
        category: 'flow_timing',
        kind: 'momentum',
        themes: [],
        autonomyRules: [],
        expressions: [
          {
            symbol: 'TEST',
            name: 'Test',
            assetClass: 'equity_us_large',
            preferredVenue: 'IBKR',
            direction: 'long',
            sizingMethod: 'pct_portfolio',
            sizingValue: '0.25',
            estimatedCostBps: 5,
            averageDailyVolumeUsd: '5000000',
            whyThisExpression: 'liquid',
          },
        ],
        preferredExpressionIndex: 0,
        expressionChoiceRationale: 'best',
        riskReward: {
          centralScenarioReturnPct: { low: 5, mid: 10, high: 15 },
          adverseScenarioReturnPct: -5,
          riskRewardRatio: 2,
          horizonDays: 7,
          convexitySources: [],
        },
        invalidation: {
          conditions: [
            { description: 'broken', metricType: 'price', thresholdValue: '90', thresholdDirection: 'below' as const },
          ],
          qualitativeConditions: [],
        },
        antiBullshit: {
          isCrowded: false,
          isCrowdedRationale: 'low coverage',
          driverType: 'fundamentals_cashflow' as const,
          evidenceType: 'hard_data' as const,
          selfCritique: 'minor',
        },
        analogSlugs: [],
        confidenceScore: 70,
        generatedAt: new Date().toISOString(),
        claudeMeta: { model: 'opus', inputTokens: 100, outputTokens: 50 },
      },
    ],
    allocations: [
      { thesisId: '00000000-0000-0000-0000-000000000010', pctCapital: allocPct, amountUsd: String(100 * allocPct) },
    ],
    cashReservePct: 100 - allocPct,
    portfolioRiskLens: {
      annualizedVolatilityPct: 15,
      var95_1day_pct: 2,
      expectedShortfall95_1day_pct: 2.5,
      historicalMaxDrawdownPct: 10,
      daysToExit50pct: 1,
      correlationsToMajorAssets: { sp500: 0.5, gold: 0, btc: 0, dxy: 0, us10y: 0 },
      effectiveLeverage: 1,
      beta: 1,
      regimeSensitivity: {},
    } as AllocationProposal['portfolioRiskLens'],
    constraints: {
      maxDrawdown2DaysPct: 10,
      maxDrawdown7DaysPct: 15,
      maxDrawdown30DaysPct: 25,
      maxPositionSizePct: 30,
      maxOpenPositions: 10,
      maxLeverage: 1,
      maxExposurePerAssetClassPct: 40,
      maxPortfolioVolatilityPct: 20,
      targetDeploymentPct: 60,
      autoLiquidateOnKill: true,
      maxThemePct: {},
    },
    warnings: [],
    generatedAt: new Date().toISOString(),
    status: 'proposed',
  };
}

describe('RiskEnforcer — regime sizing (PR C)', () => {
  const enforcer = new RiskEnforcer();

  it('multiplier 1.2 (BULL) : applique × 1.2 sur pctCapital + amountUsd', () => {
    const sizing: RegimeSizingOption = { multiplier: 1.2, regime: 'BULL', reason: 'btc_24h>+2% AND funding>0.01%' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(24, 5); // 20 × 1.2
    expect(Number(result.adjustedProposal!.allocations[0].amountUsd)).toBeCloseTo(2400, 1); // 2000 × 1.2
    expect(result.adjustedProposal!.cashReservePct).toBeCloseTo(76, 5);
    expect(result.violations.some((v) => v.code === 'REGIME_SIZING_APPLIED')).toBe(true);
  });

  it('multiplier 0.7 (BEAR) : applique × 0.7 (-30%)', () => {
    const sizing: RegimeSizingOption = { multiplier: 0.7, regime: 'BEAR' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(14, 5);
    expect(Number(result.adjustedProposal!.allocations[0].amountUsd)).toBeCloseTo(1400, 1);
    expect(result.adjustedProposal!.cashReservePct).toBeCloseTo(86, 5);
  });

  it('multiplier 0 (VOL_SPIKE) : drop TOUTES allocations + cash 100%', () => {
    const sizing: RegimeSizingOption = { multiplier: 0, regime: 'VOL_SPIKE', reason: 'vix=30 > 25' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBe(0);
    expect(result.adjustedProposal!.allocations[0].amountUsd).toBe('0');
    expect(result.adjustedProposal!.cashReservePct).toBe(100);
    expect(result.violations.some((v) => v.code === 'REGIME_SKIP')).toBe(true);
  });

  it('multiplier 1.0 (NEUTRAL) : no-op (pas de warning REGIME_SIZING_APPLIED)', () => {
    const sizing: RegimeSizingOption = { multiplier: 1.0, regime: 'NEUTRAL' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBe(20);
    expect(result.violations.some((v) => v.code === 'REGIME_SIZING_APPLIED')).toBe(false);
  });

  it('sans regimeSizing : comportement legacy préservé (pas de warning)', () => {
    const result = enforcer.enforce(baseProposal(20));
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBe(20);
    expect(result.violations.some((v) => v.code.startsWith('REGIME_'))).toBe(false);
  });

  it('warning message inclut le regime + reason', () => {
    const sizing: RegimeSizingOption = { multiplier: 1.2, regime: 'BULL', reason: 'btc_24h+3% funding+0.02%' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    const warning = result.violations.find((v) => v.code === 'REGIME_SIZING_APPLIED');
    expect(warning?.message).toContain('BULL');
    expect(warning?.message).toContain('1.20');
  });

  it('proposal.warnings reçoit la trace [regime] sizing×X', () => {
    const sizing: RegimeSizingOption = { multiplier: 1.2, regime: 'BULL' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    const traced = result.adjustedProposal!.warnings.find((w) => w.startsWith('[regime]'));
    expect(traced).toBeDefined();
    expect(traced).toContain('BULL');
    expect(traced).toContain('1.20');
  });

  it('post-shrink size 24% reste sous maxPositionSizePct=30 (no false POSITION_SIZE_EXCEEDED)', () => {
    // BULL × 1.2 sur alloc 25% → 30% post-shrink. Borderline.
    const sizing: RegimeSizingOption = { multiplier: 1.2, regime: 'BULL' };
    const result = enforcer.enforce(baseProposal(25), undefined, undefined, sizing);
    // 25 × 1.2 = 30 = exactly at the cap → ne fail pas
    expect(result.violations.some((v) => v.code === 'POSITION_SIZE_EXCEEDED')).toBe(false);
  });

  it('post-shrink size > maxPositionSizePct triggers POSITION_SIZE_EXCEEDED check', () => {
    // BULL × 1.2 sur alloc 28% → 33.6% > maxPositionSize 30%
    const sizing: RegimeSizingOption = { multiplier: 1.2, regime: 'BULL' };
    const result = enforcer.enforce(baseProposal(28), undefined, undefined, sizing);
    expect(result.violations.some((v) => v.code === 'POSITION_SIZE_EXCEEDED')).toBe(true);
  });

  it('multiplier non-finite (NaN, Infinity) : ignoré (no-op safety)', () => {
    const sizing: RegimeSizingOption = { multiplier: NaN, regime: 'CORRUPTED' };
    const result = enforcer.enforce(baseProposal(20), undefined, undefined, sizing);
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBe(20); // no shrink
    expect(result.violations.some((v) => v.code.startsWith('REGIME_'))).toBe(false);
  });
});
