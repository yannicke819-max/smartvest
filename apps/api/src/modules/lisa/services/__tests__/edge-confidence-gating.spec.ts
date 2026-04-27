/**
 * PATCH 6 — Edge confidence N-gating dans le sizer.
 *
 * Vérifie que :
 *  - bucketStatsFromTrades dérive le bon multiplicateur depuis N
 *  - RiskEnforcer.enforce shrink toutes les allocations quand multiplier<1
 *  - cashReservePct + amountUsd recomputés cohérents après shrink
 *  - requireConfirmedEdge=true rejette le cycle sur 'none'/'weak'
 *  - requireConfirmedEdge=false (défaut) shrink seulement, ne rejette pas
 */

import { RiskEnforcer, type EdgeStats } from '@smartvest/ai-analyst';
import type { AllocationProposal } from '@smartvest/ai-analyst';
import { bucketStatsFromTrades } from '../lisa-performance-analytics.service';

// ────────────────────────────────────────────────────────────────────
// Helper : proposal minimale qui passe tous les autres checks.
// ────────────────────────────────────────────────────────────────────
function makeProposal(allocPct: number): AllocationProposal {
  const thesisId = '00000000-0000-0000-0000-000000000001';
  const proposalId = '00000000-0000-0000-0000-000000000099';
  return {
    id: proposalId,
    capitalUsd: '10000',
    baseCurrency: 'EUR',
    detectedRegime: 'geopolitical_stress' as AllocationProposal['detectedRegime'],
    marketMomentum: 'neutral',
    regimeSummary: 'test',
    favoredPockets: [],
    avoidedPockets: [],
    theses: [
      {
        id: thesisId,
        title: 'test',
        summary: 'test thesis',
        catalyst: 'test catalyst',
        whoIsWrong: 'consensus',
        category: 'flow_timing',
        expressions: [
          {
            symbol: 'TEST',
            name: 'Test',
            assetClass: 'equity_us_large',
            preferredVenue: 'IBKR',
            direction: 'long',
            sizingMethod: 'pct_portfolio',
            sizingValue: String(allocPct),
            estimatedCostBps: 5,
            averageDailyVolumeUsd: '10000000',
            whyThisExpression: 'test',
          },
        ],
        preferredExpressionIndex: 0,
        expressionChoiceRationale: 'only one',
        riskReward: {
          centralScenarioReturnPct: { low: 0, mid: 5, high: 10 },
          adverseScenarioReturnPct: -5,
          riskRewardRatio: 2,
          horizonDays: 30,
          convexitySources: [],
        },
        invalidation: {
          conditions: [
            {
              description: 'price below entry',
              metricType: 'price',
              thresholdValue: '90',
              thresholdDirection: 'below',
            },
          ],
          qualitativeConditions: [],
        },
        antiBullshit: {
          isCrowded: false,
          isCrowdedRationale: 'not crowded',
          driverType: 'mixed',
          evidenceType: 'hard_data',
          selfCritique: 'fine',
        },
        analogSlugs: [],
        confidenceScore: 70,
      } as unknown as AllocationProposal['theses'][number],
    ],
    allocations: [
      {
        thesisId,
        pctCapital: allocPct,
        amountUsd: String(10000 * (allocPct / 100)),
      },
    ],
    cashReservePct: 100 - allocPct,
    portfolioRiskLens: {} as AllocationProposal['portfolioRiskLens'],
    constraints: {
      maxDrawdown2DaysPct: 10,
      maxDrawdown7DaysPct: 15,
      maxDrawdown30DaysPct: 25,
      maxPositionSizePct: 25,
      maxOpenPositions: 10,
      maxLeverage: 1.5,
      maxExposurePerAssetClassPct: 40,
      maxPortfolioVolatilityPct: 50,
      targetDeploymentPct: 60,
      autoLiquidateOnKill: true,
    } as AllocationProposal['constraints'],
    warnings: [],
    generatedAt: new Date().toISOString(),
    status: 'proposed',
  };
}

// ────────────────────────────────────────────────────────────────────

describe('bucketStatsFromTrades — confidence buckets par N', () => {
  it('returns confidence=none + multiplier=0.3 for N<10', () => {
    const trades = Array.from({ length: 8 }, () => ({ returnPct: -0.5 }));
    const stats = bucketStatsFromTrades(trades);
    expect(stats.n).toBe(8);
    expect(stats.confidence).toBe('none');
    expect(stats.sizingMultiplier).toBe(0.3);
  });

  it('returns confidence=weak + multiplier=0.6 for 10<=N<20', () => {
    const trades = Array.from({ length: 15 }, () => ({ returnPct: 0.2 }));
    const stats = bucketStatsFromTrades(trades);
    expect(stats.confidence).toBe('weak');
    expect(stats.sizingMultiplier).toBe(0.6);
  });

  it('returns confidence=moderate + multiplier=0.85 for 20<=N<30', () => {
    const trades = Array.from({ length: 25 }, () => ({ returnPct: 0.3 }));
    const stats = bucketStatsFromTrades(trades);
    expect(stats.confidence).toBe('moderate');
    expect(stats.sizingMultiplier).toBe(0.85);
  });

  it('returns confidence=confirmed + multiplier=1.0 for N>=30', () => {
    const trades = Array.from({ length: 30 }, () => ({ returnPct: 0.4 }));
    const stats = bucketStatsFromTrades(trades);
    expect(stats.confidence).toBe('confirmed');
    expect(stats.sizingMultiplier).toBe(1.0);
  });

  it('computes win rate + avg return correctly', () => {
    const trades = [
      { returnPct: 1.0 },
      { returnPct: -2.0 },
      { returnPct: 3.0 },
      { returnPct: -1.0 },
    ];
    const stats = bucketStatsFromTrades(trades);
    expect(stats.winRate).toBeCloseTo(0.5, 5); // 2/4
    expect(stats.avgReturn).toBeCloseTo(0.25, 5); // (1-2+3-1)/4
  });

  it('returns N=0, multiplier=0.3 (fail-safe) for empty bucket', () => {
    const stats = bucketStatsFromTrades([]);
    expect(stats.n).toBe(0);
    expect(stats.confidence).toBe('none');
    expect(stats.sizingMultiplier).toBe(0.3);
  });
});

describe('RiskEnforcer — edge confidence N-gating (shrink path)', () => {
  it('shrinks size to 30% on unconfirmed edge (N<10)', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 8,
      winRate: 0.38,
      avgReturn: -0.2,
      confidence: 'none',
      sizingMultiplier: 0.3,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, { stats: edgeStats });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(3.0, 5);
    expect(Number(result.adjustedProposal!.allocations[0].amountUsd)).toBeCloseTo(300, 1);
    expect(result.adjustedProposal!.cashReservePct).toBeCloseTo(97.0, 5);
  });

  it('shrinks to 60% on weak edge (10<=N<20)', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 15,
      winRate: 0.5,
      avgReturn: 0.1,
      confidence: 'weak',
      sizingMultiplier: 0.6,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, { stats: edgeStats });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(6.0, 5);
  });

  it('does NOT shrink on confirmed edge (multiplier=1.0)', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 50,
      winRate: 0.7,
      avgReturn: 0.8,
      confidence: 'confirmed',
      sizingMultiplier: 1.0,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, { stats: edgeStats });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(10.0, 5);
  });

  it('appends a warning describing the shrink applied', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 8,
      winRate: 0.38,
      avgReturn: -0.2,
      confidence: 'none',
      sizingMultiplier: 0.3,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, { stats: edgeStats });

    expect(result.adjustedProposal).not.toBeNull();
    const warnings = result.adjustedProposal!.warnings;
    expect(warnings.some((w) => /Edge N-gating/.test(w))).toBe(true);
    expect(warnings.some((w) => /N=8/.test(w))).toBe(true);
    expect(warnings.some((w) => /confidence=none/.test(w))).toBe(true);
  });

  it('skips gating when no edgeGate is provided (legacy callers)', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);

    const result = enforcer.enforce(proposal);

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(10.0, 5);
    expect(result.adjustedProposal!.warnings.some((w) => /Edge N-gating/.test(w))).toBe(false);
  });

  it('does NOT pre-bypass the maxPositionSizePct check (shrink applied THEN check runs)', () => {
    // Position 30% >max 25% mais shrink ×0.3 = 9% → respect du cap
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(30);
    const edgeStats: EdgeStats = {
      n: 8,
      winRate: 0.4,
      avgReturn: -0.1,
      confidence: 'none',
      sizingMultiplier: 0.3,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, { stats: edgeStats });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(9.0, 5);
    expect(result.violations.some((v) => v.code === 'POSITION_SIZE_EXCEEDED')).toBe(false);
  });
});

describe('RiskEnforcer — requireConfirmedEdge=true (strict mode)', () => {
  it('rejects on weak edge (N=15) when requireConfirmedEdge=true', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 15,
      winRate: 0.45,
      avgReturn: 0.0,
      confidence: 'weak',
      sizingMultiplier: 0.6,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, {
      stats: edgeStats,
      requireConfirmedEdge: true,
    });

    expect(result.adjustedProposal).toBeNull();
    expect(result.violations.some((v) => v.code === 'EDGE_NOT_CONFIRMED' && v.severity === 'critical')).toBe(true);
  });

  it('rejects on no edge (N=0) when requireConfirmedEdge=true', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 0,
      winRate: 0,
      avgReturn: 0,
      confidence: 'none',
      sizingMultiplier: 0.3,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, {
      stats: edgeStats,
      requireConfirmedEdge: true,
    });

    expect(result.adjustedProposal).toBeNull();
    expect(result.violations.some((v) => v.code === 'EDGE_NOT_CONFIRMED')).toBe(true);
  });

  it('does NOT reject on moderate edge (N=25) even when requireConfirmedEdge=true', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 25,
      winRate: 0.6,
      avgReturn: 0.4,
      confidence: 'moderate',
      sizingMultiplier: 0.85,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, {
      stats: edgeStats,
      requireConfirmedEdge: true,
    });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.violations.some((v) => v.code === 'EDGE_NOT_CONFIRMED')).toBe(false);
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(8.5, 5);
  });

  it('does NOT reject on confirmed edge (N=50) when requireConfirmedEdge=true', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 50,
      winRate: 0.65,
      avgReturn: 0.5,
      confidence: 'confirmed',
      sizingMultiplier: 1.0,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, {
      stats: edgeStats,
      requireConfirmedEdge: true,
    });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.violations.some((v) => v.code === 'EDGE_NOT_CONFIRMED')).toBe(false);
  });

  it('shrinks (NOT rejects) on weak edge when requireConfirmedEdge is false', () => {
    const enforcer = new RiskEnforcer();
    const proposal = makeProposal(10);
    const edgeStats: EdgeStats = {
      n: 8,
      winRate: 0.38,
      avgReturn: -0.2,
      confidence: 'none',
      sizingMultiplier: 0.3,
    };

    const result = enforcer.enforce(proposal, undefined, undefined, {
      stats: edgeStats,
      requireConfirmedEdge: false,
    });

    expect(result.adjustedProposal).not.toBeNull();
    expect(result.adjustedProposal!.allocations[0].pctCapital).toBeCloseTo(3.0, 5);
    expect(result.violations.some((v) => v.code === 'EDGE_NOT_CONFIRMED')).toBe(false);
  });
});
