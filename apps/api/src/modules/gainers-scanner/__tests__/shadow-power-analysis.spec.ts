/**
 * ADR-005 Step 9 — power analysis tests.
 */

import { proportionTest, wilsonInterval95, requiredSampleSize } from '../shadow/power-analysis';

describe('proportionTest()', () => {
  it('returns INSUFFICIENT_SAMPLES if n < 30', () => {
    const r = proportionTest({ n: 20, wins: 10 });
    expect(r.recommendation).toBe('INSUFFICIENT_SAMPLES');
  });

  it('detects significant non-random win rate at n=500 with high success', () => {
    // 60% wins on 500 trades → very significant vs H₀=0.5
    const r = proportionTest({ n: 500, wins: 300 });
    expect(r.winRate).toBeCloseTo(0.6, 4);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.recommendation).toBe('EARLY_STOP_REJECT_NULL');
  });

  it('detects no effect at n=800 with random ~50% win rate', () => {
    // 50.1% wins on 800 trades → p-value > 0.5 (not significantly different from 0.5)
    const r = proportionTest({ n: 800, wins: 401 });
    expect(r.recommendation).toBe('EARLY_STOP_NO_EFFECT');
  });

  it('returns CONTINUE for moderate sample with weak effect', () => {
    // 52% wins on 100 trades → not enough power yet
    const r = proportionTest({ n: 100, wins: 52 });
    expect(r.recommendation).toBe('CONTINUE');
  });

  it('z-stat is positive for win-rate > 0.5', () => {
    const r = proportionTest({ n: 100, wins: 60 });
    expect(r.zStat).toBeGreaterThan(0);
  });

  it('z-stat is negative for win-rate < 0.5', () => {
    const r = proportionTest({ n: 100, wins: 40 });
    expect(r.zStat).toBeLessThan(0);
  });

  it('handles edge cases n=0', () => {
    const r = proportionTest({ n: 0, wins: 0 });
    expect(r.recommendation).toBe('INSUFFICIENT_SAMPLES');
    expect(r.winRate).toBe(0);
  });
});

describe('wilsonInterval95()', () => {
  it('returns [0,0] for n=0', () => {
    expect(wilsonInterval95(0, 0)).toEqual([0, 0]);
  });

  it('produces valid CI containing observed proportion', () => {
    const [lo, hi] = wilsonInterval95(0.6, 100);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it('CI tightens with larger n', () => {
    const [lo10, hi10] = wilsonInterval95(0.5, 10);
    const [lo1000, hi1000] = wilsonInterval95(0.5, 1000);
    expect(hi10 - lo10).toBeGreaterThan(hi1000 - lo1000);
  });

  it('clamps within [0, 1]', () => {
    const [lo, hi] = wilsonInterval95(0.99, 50);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

describe('requiredSampleSize()', () => {
  it('detect Δ = 5pp (0.55 vs 0.50) → ~1050 trades for power=0.90', () => {
    // Formule one-sample : n = (z_α/2 + z_β)² × p(1-p) / δ²
    // = (1.96 + 1.282)² × 0.25 / 0.05² = 10.51 × 0.25 / 0.0025 ≈ 1052
    const n = requiredSampleSize(0.05);
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(1100);
  });

  it('detect Δ = 10pp (0.60 vs 0.50) → ~263 trades for power=0.90', () => {
    // n = (3.242)² × 0.25 / 0.01 ≈ 263
    const n = requiredSampleSize(0.10);
    expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(280);
  });

  it('detect Δ = 20pp (0.70 vs 0.50) → ~66 trades for power=0.90', () => {
    // n = (3.242)² × 0.25 / 0.04 ≈ 66
    const n = requiredSampleSize(0.20);
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(80);
  });

  it('returns Infinity for delta=0', () => {
    expect(requiredSampleSize(0)).toBe(Infinity);
  });
});
