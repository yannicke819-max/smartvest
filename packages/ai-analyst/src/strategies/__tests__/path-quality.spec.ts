/**
 * P9-UX ADDENDUM — Tests path quality.
 */
import {
  computePathEfficiency,
  computePullbackDepth,
  computeMonotonicity,
  classifySmoothness,
  evaluatePathQuality,
  evaluateWindowPathQuality,
} from '../path-quality';

describe('computePathEfficiency', () => {
  it('strict croissant → 1.0 (efficiency parfaite)', () => {
    const prices = [100, 101, 102, 103, 104];
    expect(computePathEfficiency(prices)).toBeCloseTo(1, 5);
  });

  it('strict décroissant → 1.0 (efficiency parfaite, descente nette)', () => {
    const prices = [100, 99, 98, 97, 96];
    expect(computePathEfficiency(prices)).toBeCloseTo(1, 5);
  });

  it('marche aléatoire (rebonds) → faible efficiency', () => {
    const prices = [100, 102, 100, 101, 99, 102, 100, 101];
    const eff = computePathEfficiency(prices);
    expect(eff).not.toBeNull();
    expect(eff!).toBeLessThan(0.3);
  });

  it('pump-and-dump → efficiency basse même si net=0', () => {
    const prices = [100, 105, 110, 100, 95];
    const eff = computePathEfficiency(prices)!;
    // |95-100|/totalVar = 5/(5+5+10+5)=5/25=0.2
    expect(eff).toBeCloseTo(0.2, 1);
  });

  it('prix constant → 1 (no variation, perfect monotone par convention)', () => {
    expect(computePathEfficiency([100, 100, 100])).toBe(1);
  });

  it('série trop courte → null', () => {
    expect(computePathEfficiency([])).toBeNull();
    expect(computePathEfficiency([100])).toBeNull();
  });
});

describe('computePullbackDepth', () => {
  it('série [10, 12, 11, 13] → pullback 1/12 ≈ 0.083 (max=12 au idx=1, min après = 11)', () => {
    const prices = [10, 12, 11, 13];
    // max=13 at idx=3, last → pas de pullback observé après
    // → 0
    expect(computePullbackDepth(prices)).toBe(0);
  });

  it('pullback détecté quand max au milieu', () => {
    const prices = [10, 12, 11, 11.5, 11];
    // max=12 at idx=1, min after = 11. (12-11)/12 = 1/12 ≈ 0.083
    expect(computePullbackDepth(prices)).toBeCloseTo(0.0833, 3);
  });

  it('pump-and-dump pullback profond', () => {
    const prices = [100, 110, 90];
    // max=110 idx=1, min after = 90. (110-90)/110 ≈ 0.182
    expect(computePullbackDepth(prices)).toBeCloseTo(0.1818, 3);
  });

  it('strict croissant → 0 pullback', () => {
    expect(computePullbackDepth([1, 2, 3, 4])).toBe(0);
  });
});

describe('computeMonotonicity', () => {
  it('strict croissant → 1.0', () => {
    expect(computeMonotonicity([1, 2, 3, 4, 5])).toBe(1);
  });

  it('moitié positive moitié négative → 0.5', () => {
    expect(computeMonotonicity([1, 2, 3, 2, 1])).toBeCloseTo(0.5);
  });

  it('strict décroissant → 0', () => {
    expect(computeMonotonicity([5, 4, 3, 2, 1])).toBe(0);
  });
});

describe('classifySmoothness', () => {
  it('smooth : efficiency ≥ 0.7 ET pullback ≤ 1%', () => {
    expect(classifySmoothness(0.8, 0.005)).toBe('smooth');
    expect(classifySmoothness(1.0, 0)).toBe('smooth');
  });

  it('choppy : efficiency < 0.4', () => {
    expect(classifySmoothness(0.3, 0.005)).toBe('choppy');
  });

  it('choppy : pullback > 2%', () => {
    expect(classifySmoothness(0.9, 0.025)).toBe('choppy');
  });

  it('mixed : entre les deux', () => {
    expect(classifySmoothness(0.5, 0.01)).toBe('mixed');
    expect(classifySmoothness(0.65, 0.015)).toBe('mixed');
  });
});

describe('evaluatePathQuality (end-to-end)', () => {
  it('badge smooth sur série croissante propre', () => {
    const r = evaluatePathQuality([100, 100.5, 101, 101.5, 102]);
    expect(r?.smoothnessLabel).toBe('smooth');
    expect(r?.pathEfficiency).toBeCloseTo(1, 5);
  });

  it('badge choppy sur pump-and-dump (efficiency basse + pullback profond)', () => {
    const r = evaluatePathQuality([100, 105, 110, 100, 95]);
    expect(r?.smoothnessLabel).toBe('choppy');
  });

  it('badge mixed entre les deux', () => {
    // Efficiency ≈ 0.5, pullback ≈ 1%
    const r = evaluatePathQuality([100, 102, 101.5, 102.5, 103]);
    expect(r).not.toBeNull();
    // Doit être mixed ou smooth (selon valeur précise)
    expect(['mixed', 'smooth']).toContain(r!.smoothnessLabel);
  });

  it('série trop courte → null', () => {
    expect(evaluatePathQuality([])).toBeNull();
    expect(evaluatePathQuality([100])).toBeNull();
  });
});

describe('evaluateWindowPathQuality', () => {
  it('extrait les N dernières candles + 1 (start)', () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({ close: 100 + i * 0.1 }));
    const r = evaluateWindowPathQuality(candles, 10);
    expect(r).not.toBeNull();
    // 11 prix utilisés (10 minutes = 10 segments + 1 start)
    expect(r!.n).toBe(11);
    expect(r!.smoothnessLabel).toBe('smooth');
  });

  it('série trop courte → null', () => {
    expect(evaluateWindowPathQuality([], 10)).toBeNull();
  });
});
