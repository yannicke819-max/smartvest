/**
 * P3-B — Tests métriques pures.
 */
import { computeMetrics, computeVerdict, VERDICT_THRESHOLDS } from '../metrics';
import type { BacktestTrade } from '../engine';

function trade(pnlPct: number, exitKind: BacktestTrade['exitKind'], holding = 5): BacktestTrade {
  return {
    ticker: 'X',
    entryDate: 0,
    entryPrice: 100,
    exitDate: holding,
    exitPrice: 100 * (1 + pnlPct / 100),
    exitKind,
    holdingBars: holding,
    pnlPct,
    confidence: 0.5,
    indicators: { rsi14: 25, drawdown20Pct: -16, volSpikeRatio: 2 },
  };
}

describe('computeMetrics', () => {
  it('handles empty trade list (zero everything)', () => {
    const m = computeMetrics([]);
    expect(m.total).toBe(0);
    expect(m.expectancyPct).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.sharpeSimple).toBe(0);
  });

  it('computes basic averages on small set', () => {
    const trades = [trade(5, 'TP1'), trade(-4, 'SL'), trade(10, 'TP2')];
    const m = computeMetrics(trades);
    expect(m.total).toBe(3);
    expect(m.totalPnlPct).toBeCloseTo(11, 1);
    expect(m.avgPnlPct).toBeCloseTo(3.67, 1);
    expect(m.expectancyPct).toBeCloseTo(3.67, 1);
    expect(m.medianPnlPct).toBe(5);
    expect(m.winRate).toBeCloseTo(0.67, 1);
  });

  it('computes hit rates per exit kind', () => {
    const trades = [
      trade(5, 'TP1'),
      trade(5, 'TP1'),
      trade(10, 'TP2'),
      trade(-4, 'SL'),
    ];
    const m = computeMetrics(trades);
    expect(m.hitCounts.TP1).toBe(2);
    expect(m.hitCounts.TP2).toBe(1);
    expect(m.hitCounts.SL).toBe(1);
    expect(m.hitRates.TP1).toBe(0.5);
    expect(m.hitRates.TP2).toBe(0.25);
    expect(m.hitRates.SL).toBe(0.25);
  });

  it('buckets pnls correctly', () => {
    const trades = [
      trade(-12, 'SL'),  // lt_-10
      trade(-7, 'SL'),   // -10..-5
      trade(-2, 'SL'),   // -5..0
      trade(3, 'TIMEOUT'), // 0..5
      trade(7, 'TP1'),   // 5..10
      trade(12, 'TP2'),  // 10..15
      trade(20, 'TP3'),  // gt_15
    ];
    const m = computeMetrics(trades);
    expect(m.pnlBuckets['lt_-10pct']).toBe(1);
    expect(m.pnlBuckets['_-10_to_-5pct']).toBe(1);
    expect(m.pnlBuckets['_-5_to_0pct']).toBe(1);
    expect(m.pnlBuckets['_0_to_5pct']).toBe(1);
    expect(m.pnlBuckets['_5_to_10pct']).toBe(1);
    expect(m.pnlBuckets['_10_to_15pct']).toBe(1);
    expect(m.pnlBuckets['gt_15pct']).toBe(1);
  });

  it('computes max drawdown on cumulative pnl sequence', () => {
    // Séquence : +5, +5, -10, -5, +10
    // Cumul : 5, 10, 0, -5, 5
    // Peak à 10, plus bas après peak à -5 → drawdown 15
    const trades = [
      trade(5, 'TP1'),
      trade(5, 'TP1'),
      trade(-10, 'SL'),
      trade(-5, 'SL'),
      trade(10, 'TP2'),
    ];
    const m = computeMetrics(trades);
    expect(m.maxDrawdownPct).toBeCloseTo(15, 1);
  });

  it('returns sharpe=0 if all pnls equal (stddev=0)', () => {
    const trades = [trade(5, 'TP1'), trade(5, 'TP1'), trade(5, 'TP1')];
    const m = computeMetrics(trades);
    expect(m.sharpeSimple).toBe(0);
  });
});

describe('computeVerdict', () => {
  it('returns GO when tp1+ ≥ 55% AND expectancy > 0', () => {
    // 60% TP1 + 0% TP2 + 0% TP3 = 60%, expectancy positive
    const trades = [
      ...new Array(6).fill(0).map(() => trade(5, 'TP1' as const)),
      ...new Array(4).fill(0).map(() => trade(-4, 'SL' as const)),
    ];
    const m = computeMetrics(trades);
    const v = computeVerdict(m);
    expect(v.decision).toBe('GO');
  });

  it('returns NO_GO when tp1+ < 55%', () => {
    // 40% TP1, 60% SL → expectancy négative
    const trades = [
      ...new Array(4).fill(0).map(() => trade(5, 'TP1' as const)),
      ...new Array(6).fill(0).map(() => trade(-4, 'SL' as const)),
    ];
    const m = computeMetrics(trades);
    const v = computeVerdict(m);
    expect(v.decision).toBe('NO_GO');
    expect(v.reasons.some((r) => r.includes('hit-rate'))).toBe(true);
  });

  it('returns NO_GO when expectancy ≤ 0 even if tp1+ ≥ 55%', () => {
    // 55% TP1 mais SLs très grandes → expectancy négative
    // 5.5 trades TP1 (×+1%) + 4.5 trades SL (×-2%) = ~0.55-0.9 = -0.35
    const trades = [
      ...new Array(6).fill(0).map(() => trade(1, 'TP1' as const)),
      ...new Array(5).fill(0).map(() => trade(-2, 'SL' as const)),
    ];
    const m = computeMetrics(trades);
    const v = computeVerdict(m);
    expect(v.decision).toBe('NO_GO');
  });

  it('reports thresholds in verdict for traceability', () => {
    const v = computeVerdict(computeMetrics([]));
    expect(v.thresholds.minTp1HitRate).toBe(VERDICT_THRESHOLDS.minTp1HitRate);
    expect(v.thresholds.minExpectancyPct).toBe(VERDICT_THRESHOLDS.minExpectancyPct);
  });
});
