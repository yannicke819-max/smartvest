/**
 * PATCH 5 — Stop ATR par type de thèse + sizing compensatoire.
 *
 * Tests purs sur `computeAtrStopByKind` (helper sans I/O exporté depuis
 * @smartvest/ai-analyst). Vérifie :
 *   - mean_reversion donne 2× plus de respiration que momentum
 *   - clamp [1%, 7%] respecté aux bornes
 *   - sizing compensatoire conserve risk$ par trade constant
 *   - default 'momentum' si kind undefined (rétrocompat avant prod data)
 */

import {
  ATR_STOP_MULTIPLIER_BY_KIND,
  computeAtrStopByKind,
  ThesisKind,
} from '@smartvest/ai-analyst';

describe('computeAtrStopByKind — multipliers par thesis.kind', () => {
  it('gives mean_reversion ~2x more room than momentum on the same ATR', () => {
    const atr14Pct = 2.0; // 2% ATR

    const momStop = computeAtrStopByKind(atr14Pct, 'momentum');
    const mrStop = computeAtrStopByKind(atr14Pct, 'mean_reversion');

    expect(momStop.stopPct).toBeCloseTo(2.0, 5); // 1.0 × 2 = 2%
    expect(mrStop.stopPct).toBeCloseTo(4.0, 5); // 2.0 × 2 = 4%
    expect(mrStop.stopPct / momStop.stopPct).toBeCloseTo(2.0, 5);
  });

  it('exposes the kind multiplier on the result for audit/debug', () => {
    expect(computeAtrStopByKind(2.0, 'momentum').kindMultiplier).toBe(1.0);
    expect(computeAtrStopByKind(2.0, 'mean_reversion').kindMultiplier).toBe(2.0);
    expect(computeAtrStopByKind(2.0, 'breakout').kindMultiplier).toBe(1.2);
    expect(computeAtrStopByKind(2.0, 'event').kindMultiplier).toBe(1.5);
    expect(computeAtrStopByKind(2.0, 'macro_hedge').kindMultiplier).toBe(2.2);
  });

  it('matches the ATR_STOP_MULTIPLIER_BY_KIND lookup table', () => {
    const kinds: ThesisKind[] = [
      'momentum',
      'mean_reversion',
      'breakout',
      'event',
      'macro_hedge',
    ];
    for (const k of kinds) {
      const r = computeAtrStopByKind(3.0, k);
      // ATR 3% × mult, clamp [1, 7]. Tous les produits restent dans le clamp ici
      // sauf macro_hedge (6.6, dans bounds).
      const expected = Math.max(1.0, Math.min(7.0, ATR_STOP_MULTIPLIER_BY_KIND[k] * 3.0));
      expect(r.stopPct).toBeCloseTo(expected, 5);
    }
  });

  it('defaults to 1.5x (legacy) when kind is undefined', () => {
    const r = computeAtrStopByKind(2.0, undefined);
    expect(r.kindMultiplier).toBe(1.5);
    expect(r.stopPct).toBeCloseTo(3.0, 5); // 1.5 × 2 = 3%
  });
});

describe('computeAtrStopByKind — clamp [1%, 7%]', () => {
  it('clamps to floor 1% on tiny ATR (mean_reversion 0.3% ATR → 0.6%, floored to 1%)', () => {
    const r = computeAtrStopByKind(0.3, 'mean_reversion');
    expect(r.stopPct).toBe(1.0);
  });

  it('clamps to ceiling 7% on large ATR (macro_hedge 4% ATR × 2.2 = 8.8%, capped 7%)', () => {
    const r = computeAtrStopByKind(4.0, 'macro_hedge');
    expect(r.stopPct).toBe(7.0);
  });

  it('extends the historical 5% ceiling to 7% (mean_reversion 3.5% ATR × 2 = 7%)', () => {
    const r = computeAtrStopByKind(3.5, 'mean_reversion');
    expect(r.stopPct).toBe(7.0);
    // Sanity : > 5% (l'ancien clamp aurait coupé à 5%)
    expect(r.stopPct).toBeGreaterThan(5.0);
  });

  it('clamps momentum extreme high ATR to 7% as well (momentum 8% ATR × 1 = 8%, capped 7%)', () => {
    const r = computeAtrStopByKind(8.0, 'momentum');
    expect(r.stopPct).toBe(7.0);
  });
});

describe('computeAtrStopByKind — sizing compensatoire', () => {
  it('returns null sizing when capital is not provided', () => {
    const r = computeAtrStopByKind(2.0, 'momentum');
    expect(r.recommendedSizeUsd).toBeNull();
  });

  it('returns null sizing when capital is 0 or negative', () => {
    expect(computeAtrStopByKind(2.0, 'momentum', 0).recommendedSizeUsd).toBeNull();
    expect(computeAtrStopByKind(2.0, 'momentum', -100).recommendedSizeUsd).toBeNull();
  });

  it('keeps risk$ per trade CONSTANT across kinds (mean_reversion gets smaller size)', () => {
    const capital = 100_000;
    const atr14Pct = 2.0;
    const riskPct = 0.5; // 0.5% du capital par trade = $500 cible

    const mom = computeAtrStopByKind(atr14Pct, 'momentum', capital, riskPct);
    const mr = computeAtrStopByKind(atr14Pct, 'mean_reversion', capital, riskPct);

    // Stop momentum 2%, taille 25k → risk = 25k × 2% = $500
    // Stop mean_rev 4%, taille 12.5k → risk = 12.5k × 4% = $500
    expect(mom.recommendedSizeUsd).toBeCloseTo(25_000, 1);
    expect(mr.recommendedSizeUsd).toBeCloseTo(12_500, 1);

    const riskMom = mom.recommendedSizeUsd! * (mom.stopPct / 100);
    const riskMr = mr.recommendedSizeUsd! * (mr.stopPct / 100);
    expect(riskMom).toBeCloseTo(500, 1);
    expect(riskMr).toBeCloseTo(500, 1);
    expect(riskMom).toBeCloseTo(riskMr, 1); // invariant : même risk$
  });

  it('respects custom riskPerTradePct (1% double la taille recommandée)', () => {
    const capital = 100_000;
    const r05 = computeAtrStopByKind(2.0, 'momentum', capital, 0.5);
    const r10 = computeAtrStopByKind(2.0, 'momentum', capital, 1.0);
    expect(r10.recommendedSizeUsd! / r05.recommendedSizeUsd!).toBeCloseTo(2.0, 5);
  });

  it('uses default 0.5% riskPerTradePct when not provided', () => {
    const r = computeAtrStopByKind(2.0, 'momentum', 100_000);
    // capital × (0.5 / 2.0) = 100k × 0.25 = 25k
    expect(r.recommendedSizeUsd).toBeCloseTo(25_000, 1);
  });
});
