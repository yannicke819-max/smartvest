/**
 * ADR-007 PR #207a — KellySizingService tests.
 *
 * Référence ADR-007 §3.3 : winRate=55%, R/R=1.67 → full Kelly = 28%, half = 14%.
 *
 * Note : avec wilson_lower_95% sur n=30 et p=0.55 → CI lower ≈ 0.376
 * f* = (1.67 × 0.376 - 0.624) / 1.67 = 0.0033 / 1.67 ≈ 0.0020
 * → half-Kelly ≈ 0.001 (très petit !)
 *
 * Avec n=200 et p=0.55 → CI lower ≈ 0.480
 * f* = (1.67 × 0.480 - 0.520) / 1.67 = 0.282 / 1.67 ≈ 0.169
 * → half-Kelly = 0.084
 *
 * Avec n=10000 (asymptote) → wilson lower ≈ 0.5402
 * f* = (1.67 × 0.5402 - 0.4598) / 1.67 = 0.442 / 1.67 ≈ 0.265
 * → half-Kelly = 0.133 ≈ 14% ✓ (matche ADR-007 §3.3 sur asymptote)
 */

import { KellySizingService } from '../kelly/kelly-sizing.service';

describe('KellySizingService', () => {
  const svc = new KellySizingService();

  it('returns null fraction if sample < 30', () => {
    const r = svc.compute({ winRate: 0.6, sampleSize: 20, payoffRatio: 1.5 });
    expect(r.fractionSuggested).toBeNull();
    expect(r.inputs.sampleSize).toBe(20);
  });

  it('returns null fraction if payoffRatio ≤ 0', () => {
    const r = svc.compute({ winRate: 0.6, sampleSize: 100, payoffRatio: 0 });
    expect(r.fractionSuggested).toBeNull();
  });

  it('returns 0 if edge negative (winRate too low for payoff)', () => {
    // winRate=0.5, payoff=1 → wilson_lower(0.5, 100) ≈ 0.404
    // f* = (1 × 0.404 - 0.596) / 1 = -0.192 → 0
    const r = svc.compute({ winRate: 0.5, sampleSize: 100, payoffRatio: 1.0 });
    expect(r.fullKelly).toBeLessThan(0);
    expect(r.fractionSuggested).toBe(0);
  });

  it('asymptotic case n=10000 winRate=0.55 R/R=1.67 → half-Kelly ≈ 13%', () => {
    const r = svc.compute({ winRate: 0.55, sampleSize: 10000, payoffRatio: 1.67 });
    expect(r.fractionSuggested).not.toBeNull();
    // Wilson lower ≈ 0.540 sur n=10000
    // full Kelly ≈ 0.265, half ≈ 0.133
    expect(r.fractionSuggested!).toBeGreaterThan(0.12);
    expect(r.fractionSuggested!).toBeLessThan(0.15);
  });

  it('full Kelly mode (no half) gives ~2× the half-Kelly result (avant clamp)', () => {
    const half = svc.compute({ winRate: 0.55, sampleSize: 10000, payoffRatio: 1.67, applyHalfKelly: true });
    const full = svc.compute({ winRate: 0.55, sampleSize: 10000, payoffRatio: 1.67, applyHalfKelly: false });
    // Avant le clamp à 0.25 : full ≈ 2 × half. full ≈ 0.265 → clamped à 0.25.
    expect(full.fractionSuggested!).toBe(0.25); // clampé au cap
    expect(full.inputs.clampedFromFullKelly).toBe(true);
    expect(half.fractionSuggested!).toBeGreaterThan(0);
    expect(half.fractionSuggested!).toBeLessThan(0.15);
  });

  it('clamps to 0.25 cap on extreme edge (rare but tested)', () => {
    // Très favorable : winRate=0.80, R/R=3.0, n=10000 → full = très grand → cap 0.25
    const r = svc.compute({ winRate: 0.80, sampleSize: 10000, payoffRatio: 3.0 });
    expect(r.fractionSuggested).toBe(0.25);
    expect(r.inputs.clampedFromFullKelly).toBe(true);
  });

  it('uses wilson lower bound (conservateur vs raw winRate)', () => {
    // Avec n=30 et p=0.65 → wilson lower ≈ 0.467 (vs raw 0.65)
    const r = svc.compute({ winRate: 0.65, sampleSize: 30, payoffRatio: 1.5 });
    expect(r.winRateLowerWilson).toBeLessThan(0.65);
    expect(r.winRateLowerWilson).toBeGreaterThan(0.4);
  });

  it('persists inputs in result for audit', () => {
    const r = svc.compute({ winRate: 0.6, sampleSize: 100, payoffRatio: 1.5 });
    expect(r.inputs.winRate).toBe(0.6);
    expect(r.inputs.sampleSize).toBe(100);
    expect(r.inputs.payoffRatio).toBe(1.5);
    expect(r.inputs.halfKellyApplied).toBe(true);
  });

  it('toPositionSizeUsd returns 0 if fraction null or equity ≤ 0', () => {
    expect(svc.toPositionSizeUsd(null, 10_000)).toBe(0);
    expect(svc.toPositionSizeUsd(0.1, 0)).toBe(0);
    expect(svc.toPositionSizeUsd(0.1, -100)).toBe(0);
  });

  it('toPositionSizeUsd computes correctly', () => {
    expect(svc.toPositionSizeUsd(0.1, 10_000)).toBe(1000);
    expect(svc.toPositionSizeUsd(0.05, 50_000)).toBe(2500);
  });

  it('boundary: sampleSize exactly 30 (minimum threshold)', () => {
    const r = svc.compute({ winRate: 0.6, sampleSize: 30, payoffRatio: 1.5 });
    expect(r.fractionSuggested).not.toBeNull();
    expect(r.inputs.sampleSize).toBe(30);
  });
});
