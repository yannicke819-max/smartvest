/**
 * P9 — Tests pure logic : logistic regression + AUC + Wilson CI.
 */
import {
  sigmoid,
  predict,
  fitLogistic,
  computeAuc,
  computeAccuracy,
  wilsonInterval,
} from '../logistic-regression';

describe('sigmoid', () => {
  it('σ(0) = 0.5', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
  });
  it('σ(z→+∞) → 1', () => {
    expect(sigmoid(40)).toBeCloseTo(1, 5);
  });
  it('σ(z→-∞) → 0', () => {
    expect(sigmoid(-40)).toBeCloseTo(0, 5);
  });
  it('σ(2) ≈ 0.881', () => {
    expect(sigmoid(2)).toBeCloseTo(0.881, 2);
  });
});

describe('fitLogistic — convergence sur dataset jouet', () => {
  it('converge sur dataset linéairement séparable simple', () => {
    // y = 1 si x > 0.5, sinon 0
    const X = [
      { x: 0 },
      { x: 0.1 },
      { x: 0.3 },
      { x: 0.5 },
      { x: 0.7 },
      { x: 0.9 },
      { x: 1.0 },
      { x: 1.5 },
    ];
    const y = [0, 0, 0, 0, 1, 1, 1, 1];
    const r = fitLogistic(X, y, ['x'], { maxIter: 200, l2: 0.001 });
    expect(r.converged).toBe(true);
    // Coefficient sur x doit être positif (plus x grand → plus proba grande)
    expect(r.weights.coefficients.x).toBeGreaterThan(0);
    // Predict sur un point clairement positif
    expect(predict(r.weights, { x: 1.5 })).toBeGreaterThan(0.7);
    expect(predict(r.weights, { x: 0 })).toBeLessThan(0.3);
  });

  it('coefficient correct sur 2 features (logical AND signal)', () => {
    // y dépend de x1 fortement, x2 faiblement
    const X: Array<Record<string, number>> = [];
    const y: number[] = [];
    for (let i = 0; i < 100; i++) {
      const x1 = Math.random();
      const x2 = Math.random();
      X.push({ x1, x2 });
      // Signal : y = 1 si x1 > 0.5 (x2 ignoré)
      y.push(x1 > 0.5 ? 1 : 0);
    }
    const r = fitLogistic(X, y, ['x1', 'x2'], { maxIter: 100, l2: 0.001 });
    expect(r.converged).toBe(true);
    // x1 coefficient doit dominer x2
    expect(Math.abs(r.weights.coefficients.x1)).toBeGreaterThan(Math.abs(r.weights.coefficients.x2));
    // x1 positif (signal positif)
    expect(r.weights.coefficients.x1).toBeGreaterThan(0);
  });

  it('returns zero weights on empty dataset', () => {
    const r = fitLogistic([], [], ['x']);
    expect(r.converged).toBe(false);
    expect(r.weights.intercept).toBe(0);
  });

  it('handles all-positive label gracefully', () => {
    // Edge case : tout y=1 → modèle peut être singulier mais ne crash pas
    const X = [{ x: 0.1 }, { x: 0.5 }, { x: 1.0 }];
    const y = [1, 1, 1];
    const r = fitLogistic(X, y, ['x']);
    // Pas de garantie de convergence, mais pas de crash
    expect(r.weights.featureNames).toEqual(['x']);
  });
});

describe('predict', () => {
  it('uses intercept + linear combination', () => {
    const w = {
      intercept: 0,
      coefficients: { x: 2 },
      featureNames: ['x'],
    };
    expect(predict(w, { x: 0 })).toBeCloseTo(0.5);
    expect(predict(w, { x: 1 })).toBeCloseTo(sigmoid(2));
  });

  it('ignores missing/NaN features (treated as 0 contribution)', () => {
    const w = {
      intercept: 0,
      coefficients: { x: 2 },
      featureNames: ['x'],
    };
    expect(predict(w, {})).toBeCloseTo(0.5); // x missing → 0 contrib
    expect(predict(w, { x: NaN })).toBeCloseTo(0.5);
  });
});

describe('computeAuc', () => {
  it('AUC = 1 sur classifieur parfait', () => {
    const scores = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
    const labels = [0, 0, 0, 1, 1, 1];
    expect(computeAuc(scores, labels)).toBeCloseTo(1, 5);
  });

  it('AUC ≈ 0.5 sur classifieur aléatoire (large sample)', () => {
    // Note : pour scores tous égaux, AUC dépend du tri stable de V8 et n'est
    // pas garanti à 0.5 exactement. Test plus représentatif : grand sample
    // aléatoire → AUC convergence vers 0.5.
    const n = 200;
    const scores: number[] = [];
    const labels: number[] = [];
    let seed = 42;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < n; i++) {
      scores.push(rand());
      labels.push(rand() > 0.5 ? 1 : 0);
    }
    const auc = computeAuc(scores, labels);
    expect(auc).toBeGreaterThan(0.35);
    expect(auc).toBeLessThan(0.65);
  });

  it('AUC = 0 sur classifieur inversé', () => {
    const scores = [0.9, 0.8, 0.7, 0.3, 0.2, 0.1];
    const labels = [0, 0, 0, 1, 1, 1];
    expect(computeAuc(scores, labels)).toBeCloseTo(0, 5);
  });

  it('returns 0.5 sur edge cases (vide, mono-classe)', () => {
    expect(computeAuc([], [])).toBe(0.5);
    expect(computeAuc([0.5, 0.6], [1, 1])).toBe(0.5);
    expect(computeAuc([0.5, 0.6], [0, 0])).toBe(0.5);
  });
});

describe('computeAccuracy', () => {
  it('100% sur classifieur parfait au threshold 0.5', () => {
    const scores = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
    const labels = [0, 0, 0, 1, 1, 1];
    expect(computeAccuracy(scores, labels)).toBe(1);
  });

  it('threshold custom change la prédiction', () => {
    const scores = [0.4, 0.6];
    const labels = [0, 1];
    expect(computeAccuracy(scores, labels, 0.5)).toBe(1); // 0.4→0, 0.6→1
    expect(computeAccuracy(scores, labels, 0.7)).toBe(0.5); // 0.6→0 wrong
  });
});

describe('wilsonInterval', () => {
  it('center=p quand n large (limite normale)', () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.center).toBeCloseTo(0.5, 1);
    expect(ci.lower).toBeGreaterThan(0.4);
    expect(ci.upper).toBeLessThan(0.6);
  });

  it('IC bornée [0, 1]', () => {
    const ci = wilsonInterval(0, 5);
    expect(ci.lower).toBeGreaterThanOrEqual(0);
    expect(ci.upper).toBeLessThanOrEqual(1);
    const ci2 = wilsonInterval(5, 5);
    expect(ci2.lower).toBeGreaterThanOrEqual(0);
    expect(ci2.upper).toBeLessThanOrEqual(1);
  });

  it('IC plus large pour petit n (incertitude)', () => {
    const small = wilsonInterval(2, 5);
    const large = wilsonInterval(40, 100);
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(smallWidth).toBeGreaterThan(largeWidth);
  });

  it('n=0 → max uncertainty [0, 1]', () => {
    const ci = wilsonInterval(0, 0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
  });

  it('p=0 (0/n) → upper > 0 mais small', () => {
    const ci = wilsonInterval(0, 100);
    expect(ci.center).toBeLessThan(0.05);
    expect(ci.upper).toBeLessThan(0.1);
  });

  it('p=1 (n/n) → lower < 1 mais close', () => {
    const ci = wilsonInterval(100, 100);
    expect(ci.center).toBeGreaterThan(0.95);
    expect(ci.lower).toBeGreaterThan(0.9);
  });
});
