import {
  computeLogReturns,
  computePearsonCorrelation,
  assessCorrelationRisk,
  parseCorrelationGuardConfig,
  DEFAULT_CORRELATION_GUARD_CONFIG,
} from '../correlation-guard.helper';

describe('computeLogReturns', () => {
  it('série constante → returns ≈ 0', () => {
    const r = computeLogReturns([100, 100, 100, 100]);
    expect(r.length).toBe(3);
    for (const v of r) expect(Math.abs(v)).toBeLessThan(1e-9);
  });
  it('croissance exponentielle 2× → returns constants ≈ ln(2)', () => {
    const r = computeLogReturns([1, 2, 4, 8]);
    for (const v of r) expect(v).toBeCloseTo(Math.log(2), 6);
  });
  it('série de 1 élément → array vide', () => {
    expect(computeLogReturns([100])).toEqual([]);
  });
  it('skip valeurs invalides (0, négatif, NaN)', () => {
    const r = computeLogReturns([100, 0, 100, NaN, 100]);
    expect(r).toEqual([]);
  });
});

describe('computePearsonCorrelation', () => {
  it('series identiques → corr = 1', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const r = computePearsonCorrelation(a, a);
    expect(r).toBeCloseTo(1, 5);
  });
  it('series anti-corrélées → corr = -1', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const b = a.map((v) => -v);
    expect(computePearsonCorrelation(a, b)).toBeCloseTo(-1, 5);
  });
  it('series indépendantes → corr proche 0', () => {
    // Series déterministe mais "random-like"
    const a = [1, -1, 2, -2, 1, -1, 2, -2, 1, -1, 2];
    const b = [1, 2, -1, -2, 2, 1, -2, -1, 2, 1, -2];
    const r = computePearsonCorrelation(a, b);
    expect(Math.abs(r!)).toBeLessThan(0.3);
  });
  it('tailles différentes → null', () => {
    expect(computePearsonCorrelation([1, 2, 3], [1, 2])).toBeNull();
  });
  it('< 10 observations → null', () => {
    expect(computePearsonCorrelation([1, 2, 3], [1, 2, 3])).toBeNull();
  });
  it('variance nulle → null (corr indéfinie)', () => {
    const flat = Array(15).fill(5);
    const linear = Array.from({ length: 15 }, (_, i) => i);
    expect(computePearsonCorrelation(flat, linear)).toBeNull();
  });
  it('corr clampée dans [-1, +1]', () => {
    // Arithmétique flottante peut donner 1.0000000001
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const r = computePearsonCorrelation(a, a);
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(-1);
  });
});

describe('assessCorrelationRisk', () => {
  // Génère une série prix avec random walk déterministe
  const makePrices = (seed: number, n: number, drift = 0.001, vol = 0.02): number[] => {
    const out: number[] = [100];
    let s = seed;
    for (let i = 1; i < n; i++) {
      s = (s * 9301 + 49297) % 233280;
      const noise = ((s / 233280) - 0.5) * 2 * vol;
      out.push(out[i - 1] * (1 + drift + noise));
    }
    return out;
  };

  it('aucun open → autorise', () => {
    const r = assessCorrelationRisk([100, 101, 102], []);
    expect(r.reject).toBe(false);
    expect(r.reason).toContain('no_open_positions');
  });

  it('candidat avec historique insuffisant → autorise (skip safe)', () => {
    const r = assessCorrelationRisk([100, 101], [
      { symbol: 'AAPL', prices: makePrices(1, 31) },
    ]);
    expect(r.reject).toBe(false);
    expect(r.reason).toContain('candidate_insufficient_history');
  });

  it('toutes positions corrélées 1.0 (cas SOL/ETH/BTC/BNB du 24/05) → REJECT', () => {
    const candidate = makePrices(42, 31);
    // Positions ouvertes = même série + bruit minime (haute correlation)
    const opens = [
      { symbol: 'SOLUSDT', prices: candidate.map((p) => p * 1.001) },
      { symbol: 'ETHUSDT', prices: candidate.map((p) => p * 0.999) },
      { symbol: 'XRPUSDT', prices: candidate.map((p) => p * 1.002) },
      { symbol: 'BTCUSDT', prices: candidate.map((p) => p * 0.998) },
    ];
    const r = assessCorrelationRisk(candidate, opens);
    expect(r.reject).toBe(true);
    expect(r.avgCorr!).toBeGreaterThan(0.95);
    expect(r.maxCorr!).toBeGreaterThan(0.95);
    expect(r.perPosition).toHaveLength(4);
    expect(r.reason).toContain('above_threshold');
  });

  it('positions décorrélées → autorise', () => {
    const candidate = makePrices(42, 31);
    const opens = [
      { symbol: 'INDEPENDENT1', prices: makePrices(7, 31, 0.002, 0.03) },
      { symbol: 'INDEPENDENT2', prices: makePrices(13, 31, -0.001, 0.025) },
    ];
    const r = assessCorrelationRisk(candidate, opens);
    expect(r.reject).toBe(false);
    expect(r.avgCorr!).toBeLessThan(0.7);
  });

  it('mix : 1 corrélée + 1 indépendante → moyenne peut être OK ou KO selon seuil', () => {
    const candidate = makePrices(42, 31);
    const opens = [
      { symbol: 'CORR', prices: candidate.map((p) => p * 1.001) }, // ~1.0
      { symbol: 'INDEP', prices: makePrices(99, 31) },              // ~0
    ];
    const r = assessCorrelationRisk(candidate, opens);
    // avg(|~1.0|, |~0|) = ~0.5 < threshold 0.7 → autorise
    expect(r.reject).toBe(false);
    expect(r.avgCorr!).toBeGreaterThan(0);
    expect(r.avgCorr!).toBeLessThan(0.7);
  });

  it('threshold custom 0.30 (très strict) → reject même partial coupling', () => {
    const candidate = makePrices(42, 31);
    const opens = [
      { symbol: 'CORR', prices: candidate.map((p) => p * 1.001) }, // ~1.0
      { symbol: 'INDEP', prices: makePrices(99, 31) },              // ~0
    ];
    const r = assessCorrelationRisk(candidate, opens, { threshold: 0.30, minObservations: 10 });
    expect(r.reject).toBe(true);
  });

  it('opens sans assez d\'historique → ignorées, autorise', () => {
    const candidate = makePrices(42, 31);
    const opens = [
      { symbol: 'NEW1', prices: [100, 101] },
      { symbol: 'NEW2', prices: [100, 100, 101] },
    ];
    const r = assessCorrelationRisk(candidate, opens);
    expect(r.reject).toBe(false);
    expect(r.reason).toContain('no_valid_correlations_computable');
  });

  it('corr négative absolue compte aussi (anti-cascade reverse)', () => {
    const candidate = makePrices(42, 31);
    // Position ouverte anti-corrélée → si crypto crash, hedge crash aussi
    const reversedReturns = candidate.map((p) => 200 / p);
    const opens = [{ symbol: 'INVERSE_ETF', prices: reversedReturns }];
    const r = assessCorrelationRisk(candidate, opens, { threshold: 0.70, minObservations: 10 });
    expect(r.perPosition[0].corr).not.toBeNull();
    // |corr| pris en compte, donc une forte anti-corr → reject aussi
    expect(Math.abs(r.perPosition[0].corr!)).toBeGreaterThan(0.9);
    expect(r.reject).toBe(true);
  });
});

describe('parseCorrelationGuardConfig', () => {
  it('env vide → defaults', () => {
    const cfg = parseCorrelationGuardConfig({});
    expect(cfg.threshold).toBe(DEFAULT_CORRELATION_GUARD_CONFIG.threshold);
    expect(cfg.minObservations).toBe(DEFAULT_CORRELATION_GUARD_CONFIG.minObservations);
  });
  it('threshold custom valid', () => {
    const cfg = parseCorrelationGuardConfig({ CORRELATION_GUARD_THRESHOLD: '0.5' });
    expect(cfg.threshold).toBe(0.5);
  });
  it('threshold hors range → default', () => {
    expect(parseCorrelationGuardConfig({ CORRELATION_GUARD_THRESHOLD: '1.5' }).threshold).toBe(0.70);
    expect(parseCorrelationGuardConfig({ CORRELATION_GUARD_THRESHOLD: '0' }).threshold).toBe(0.70);
  });
  it('minObs custom valid', () => {
    expect(parseCorrelationGuardConfig({ CORRELATION_GUARD_MIN_OBS: '20' }).minObservations).toBe(20);
  });
  it('NaN inputs → defaults', () => {
    const cfg = parseCorrelationGuardConfig({
      CORRELATION_GUARD_THRESHOLD: 'abc',
      CORRELATION_GUARD_MIN_OBS: 'xyz',
    });
    expect(cfg.threshold).toBe(0.70);
    expect(cfg.minObservations).toBe(10);
  });
});
