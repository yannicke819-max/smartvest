/**
 * PR #280 — Tests bootstrap CI 95% + verdict gate.
 */
import { bootstrapMeanCI, verdictFromCI } from '../bootstrap-ci';

describe('bootstrapMeanCI', () => {
  it('returns sample value when n=1', () => {
    const result = bootstrapMeanCI([0.5]);
    expect(result.mean).toBe(0.5);
    expect(result.ciLow).toBe(0.5);
    expect(result.ciHigh).toBe(0.5);
    expect(result.n).toBe(1);
  });

  it('returns zeros when sample is empty', () => {
    const result = bootstrapMeanCI([]);
    expect(result.n).toBe(0);
    expect(result.iterations).toBe(0);
  });

  it('captures the true mean within CI on a normal-ish sample', () => {
    // sample drawn from N(0.01, 0.01) — like average daily return on small notional
    const samples = [0.012, 0.008, 0.015, 0.005, 0.020, -0.002, 0.011, 0.009, 0.013, 0.007];
    const result = bootstrapMeanCI(samples, { iterations: 2000, seed: 42 });
    expect(result.mean).toBeCloseTo(0.0098, 3);
    // CI doit contenir la vraie moyenne (forcément, c'est la moyenne du sample)
    expect(result.ciLow).toBeLessThanOrEqual(result.mean);
    expect(result.ciHigh).toBeGreaterThanOrEqual(result.mean);
    // Largeur du CI raisonnable (pas dégénéré)
    expect(result.ciHigh - result.ciLow).toBeGreaterThan(0);
    expect(result.ciHigh - result.ciLow).toBeLessThan(0.025);
  });

  it('produces deterministic CI with same seed', () => {
    const samples = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 0.01);
    const a = bootstrapMeanCI(samples, { iterations: 500, seed: 7 });
    const b = bootstrapMeanCI(samples, { iterations: 500, seed: 7 });
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
  });

  it('CI contains 0 for symmetric data centered at 0', () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) samples.push(((i % 2) === 0 ? 1 : -1) * 0.01);
    const result = bootstrapMeanCI(samples, { iterations: 1000, seed: 1 });
    expect(result.mean).toBeCloseTo(0, 3);
    expect(result.ciLow).toBeLessThanOrEqual(0);
    expect(result.ciHigh).toBeGreaterThanOrEqual(0);
  });
});

describe('verdictFromCI', () => {
  it('returns INSUFFICIENT_DATA when n < threshold', () => {
    const verdict = verdictFromCI({ mean: 0.01, ciLow: 0.005, ciHigh: 0.015, n: 50, iterations: 1000 });
    expect(verdict).toBe('INSUFFICIENT_DATA');
  });

  it('returns GATE_TOO_STRICT when CI fully positive and n sufficient', () => {
    const verdict = verdictFromCI(
      { mean: 0.008, ciLow: 0.002, ciHigh: 0.014, n: 150, iterations: 1000 },
      { minN: 100 },
    );
    expect(verdict).toBe('GATE_TOO_STRICT');
  });

  it('returns GATE_HEALTHY when CI fully negative and n sufficient', () => {
    const verdict = verdictFromCI(
      { mean: -0.005, ciLow: -0.012, ciHigh: -0.001, n: 200, iterations: 1000 },
      { minN: 100 },
    );
    expect(verdict).toBe('GATE_HEALTHY');
  });

  it('returns INCONCLUSIVE when CI spans zero', () => {
    const verdict = verdictFromCI(
      { mean: 0.001, ciLow: -0.005, ciHigh: 0.007, n: 250, iterations: 1000 },
      { minN: 100 },
    );
    expect(verdict).toBe('INCONCLUSIVE');
  });

  it('respects custom minN threshold', () => {
    const result = { mean: 0.01, ciLow: 0.005, ciHigh: 0.015, n: 30, iterations: 1000 };
    expect(verdictFromCI(result, { minN: 100 })).toBe('INSUFFICIENT_DATA');
    expect(verdictFromCI(result, { minN: 20 })).toBe('GATE_TOO_STRICT');
  });
});
