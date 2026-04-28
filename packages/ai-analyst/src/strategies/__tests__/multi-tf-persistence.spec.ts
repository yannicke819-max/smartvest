/**
 * P8-MULTI-TIMEFRAME-PERSISTENCE — Tests pure helper.
 */
import {
  computeTfChangePct,
  buildPersistenceVector,
  computePersistenceScore,
  evaluatePersistence,
  extractPricesFromOneMinSeries,
  extractPricesFromFiveMinSeries,
  summarizeByTf,
  type PersistenceResult,
} from '../multi-tf-persistence';

describe('computeTfChangePct', () => {
  it('computes positive variation correctly', () => {
    expect(computeTfChangePct(105, 100)).toBeCloseTo(5);
  });

  it('computes negative variation correctly', () => {
    expect(computeTfChangePct(95, 100)).toBeCloseTo(-5);
  });

  it('returns null when past price is null', () => {
    expect(computeTfChangePct(100, null)).toBeNull();
    expect(computeTfChangePct(100, undefined)).toBeNull();
  });

  it('returns null on invalid current price', () => {
    expect(computeTfChangePct(NaN, 100)).toBeNull();
    expect(computeTfChangePct(0, 100)).toBeNull();
    expect(computeTfChangePct(-10, 100)).toBeNull();
  });

  it('returns null on invalid past price', () => {
    expect(computeTfChangePct(100, NaN)).toBeNull();
    expect(computeTfChangePct(100, 0)).toBeNull();
    expect(computeTfChangePct(100, -5)).toBeNull();
  });
});

describe('computePersistenceScore', () => {
  it('all 6 TFs positive → 6/6, score=1.0', () => {
    const vec = {
      tf1m: 0.5, tf5m: 1.0, tf10m: 1.5, tf15m: 2.0, tf30m: 2.5, tf1h: 3.0,
    };
    const r = computePersistenceScore(vec);
    expect(r.positiveCount).toBe(6);
    expect(r.availableCount).toBe(6);
    expect(r.persistenceCount).toBe('6/6');
    expect(r.persistenceScore).toBe(1);
  });

  it('4 of 6 positive → 4/6, score≈0.67', () => {
    const vec = {
      tf1m: 0.5, tf5m: 1.0, tf10m: -0.5, tf15m: 0.2, tf30m: -1.0, tf1h: 0.3,
    };
    const r = computePersistenceScore(vec);
    expect(r.positiveCount).toBe(4);
    expect(r.availableCount).toBe(6);
    expect(r.persistenceCount).toBe('4/6');
    expect(r.persistenceScore).toBeCloseTo(0.6667, 3);
  });

  it('2 of 6 positive → 2/6, score≈0.33', () => {
    const vec = {
      tf1m: 0.5, tf5m: -1.0, tf10m: -0.5, tf15m: -0.2, tf30m: -1.0, tf1h: 0.3,
    };
    const r = computePersistenceScore(vec);
    expect(r.persistenceCount).toBe('2/6');
    expect(r.persistenceScore).toBeCloseTo(0.3333, 3);
  });

  it('0 of 6 positive → 0/6, score=0', () => {
    const vec = {
      tf1m: -0.5, tf5m: -1.0, tf10m: -0.5, tf15m: -0.2, tf30m: -1.0, tf1h: -0.3,
    };
    const r = computePersistenceScore(vec);
    expect(r.persistenceScore).toBe(0);
  });

  it('TF null exclus du denominator (5 dispos)', () => {
    const vec = {
      tf1m: null, tf5m: 1.0, tf10m: 1.5, tf15m: -0.2, tf30m: 2.5, tf1h: 3.0,
    };
    const r = computePersistenceScore(vec);
    expect(r.availableCount).toBe(5);
    expect(r.positiveCount).toBe(4);
    expect(r.persistenceCount).toBe('4/5');
    expect(r.persistenceScore).toBe(0.8);
  });

  it('Tous TFs null → score NaN, count 0/6', () => {
    const vec = {
      tf1m: null, tf5m: null, tf10m: null, tf15m: null, tf30m: null, tf1h: null,
    };
    const r = computePersistenceScore(vec);
    expect(r.availableCount).toBe(0);
    expect(r.persistenceScore).toBeNaN();
    expect(r.persistenceCount).toBe('0/6');
  });

  it('TF égal à 0 = neutre (compté en dispo, pas en positif)', () => {
    const vec = {
      tf1m: 0, tf5m: 1.0, tf10m: 1.5, tf15m: 0, tf30m: 0, tf1h: 0,
    };
    const r = computePersistenceScore(vec);
    expect(r.positiveCount).toBe(2);
    expect(r.availableCount).toBe(6);
    expect(r.persistenceScore).toBeCloseTo(0.3333, 3);
  });
});

describe('buildPersistenceVector', () => {
  it('exemple NVDA TF1m=4.2 TF5m=2.1 ...', () => {
    const v = buildPersistenceVector(102, {
      '1m': 100,
      '5m': 99,
      '10m': 100.5,
      '15m': 101.5,
      '30m': 103,
      '1h': 99.5,
    });
    expect(v.tf1m).toBeCloseTo(2);
    expect(v.tf5m).toBeCloseTo(3.0303, 2);
    expect(v.tf10m).toBeCloseTo(1.4925, 2);
    expect(v.tf15m).toBeCloseTo(0.4926, 2);
    expect(v.tf30m).toBeCloseTo(-0.9709, 2);
    expect(v.tf1h).toBeCloseTo(2.5126, 2);
  });
});

describe('evaluatePersistence (end-to-end)', () => {
  it('NVDA pump multi-TF score=5/6', () => {
    const r = evaluatePersistence(102, {
      '1m': 100,
      '5m': 99,
      '10m': 100.5,
      '15m': 101.5,
      '30m': 103, // tf30m négatif
      '1h': 99.5,
    });
    expect(r.persistenceCount).toBe('5/6');
    expect(r.persistenceScore).toBeCloseTo(0.8333, 3);
  });
});

describe('extractPricesFromOneMinSeries', () => {
  it('60 candles → tous les TFs présents', () => {
    const candles = Array.from({ length: 61 }, (_, i) => ({
      open: 100 + i * 0.1,
    }));
    const prices = extractPricesFromOneMinSeries(candles);
    expect(prices['1m']).toBeCloseTo(candles[59].open);
    expect(prices['5m']).toBeCloseTo(candles[55].open);
    expect(prices['10m']).toBeCloseTo(candles[50].open);
    expect(prices['15m']).toBeCloseTo(candles[45].open);
    expect(prices['30m']).toBeCloseTo(candles[30].open);
    expect(prices['1h']).toBeCloseTo(candles[0].open);
  });

  it('série courte 30 candles → 1h null', () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({ open: 100 + i }));
    const prices = extractPricesFromOneMinSeries(candles);
    expect(prices['1h']).toBeNull();
    expect(prices['1m']).not.toBeNull();
  });

  it('open invalide → null', () => {
    const candles = Array.from({ length: 5 }, () => ({ open: NaN }));
    const prices = extractPricesFromOneMinSeries(candles);
    expect(prices['1m']).toBeNull();
  });
});

describe('extractPricesFromFiveMinSeries', () => {
  it('1m toujours null (résolution insuffisante)', () => {
    const candles = Array.from({ length: 13 }, (_, i) => ({ open: 100 + i }));
    const prices = extractPricesFromFiveMinSeries(candles);
    expect(prices['1m']).toBeNull();
    expect(prices['5m']).toBeCloseTo(candles[11].open);
    expect(prices['10m']).toBeCloseTo(candles[10].open);
    expect(prices['15m']).toBeCloseTo(candles[9].open);
    expect(prices['30m']).toBeCloseTo(candles[6].open);
    expect(prices['1h']).toBeCloseTo(candles[0].open);
  });

  it('série trop courte → 1h null mais 5m/10m OK', () => {
    const candles = Array.from({ length: 4 }, (_, i) => ({ open: 100 + i }));
    const prices = extractPricesFromFiveMinSeries(candles);
    expect(prices['1h']).toBeNull();
    expect(prices['30m']).toBeNull();
    expect(prices['5m']).not.toBeNull();
    expect(prices['10m']).not.toBeNull();
  });
});

describe('summarizeByTf', () => {
  it('counts positive TFs across results', () => {
    const r1: PersistenceResult = {
      tf1m: 1, tf5m: 1, tf10m: -1, tf15m: 1, tf30m: -1, tf1h: 1,
      positiveCount: 4, availableCount: 6, persistenceCount: '4/6', persistenceScore: 0.667,
    };
    const r2: PersistenceResult = {
      tf1m: 1, tf5m: 1, tf10m: 1, tf15m: -1, tf30m: -1, tf1h: -1,
      positiveCount: 3, availableCount: 6, persistenceCount: '3/6', persistenceScore: 0.5,
    };
    const summary = summarizeByTf([r1, r2]);
    expect(summary.oneMinute).toBe(2);
    expect(summary.fiveMinutes).toBe(2);
    expect(summary.tenMinutes).toBe(1);
    expect(summary.fifteenMinutes).toBe(1);
    expect(summary.thirtyMinutes).toBe(0);
    expect(summary.oneHour).toBe(1);
  });

  it('null treated as not-positive', () => {
    const r: PersistenceResult = {
      tf1m: null, tf5m: 1, tf10m: null, tf15m: 1, tf30m: null, tf1h: null,
      positiveCount: 2, availableCount: 2, persistenceCount: '2/2', persistenceScore: 1,
    };
    const s = summarizeByTf([r]);
    expect(s.oneMinute).toBe(0);
    expect(s.fiveMinutes).toBe(1);
    expect(s.tenMinutes).toBe(0);
  });

  it('property: persistenceScore monotone with positiveCount', () => {
    const r1 = computePersistenceScore({
      tf1m: -1, tf5m: -1, tf10m: -1, tf15m: -1, tf30m: -1, tf1h: -1,
    });
    const r2 = computePersistenceScore({
      tf1m: 1, tf5m: 1, tf10m: 1, tf15m: -1, tf30m: -1, tf1h: -1,
    });
    const r3 = computePersistenceScore({
      tf1m: 1, tf5m: 1, tf10m: 1, tf15m: 1, tf30m: 1, tf1h: 1,
    });
    expect(r1.persistenceScore).toBeLessThan(r2.persistenceScore);
    expect(r2.persistenceScore).toBeLessThan(r3.persistenceScore);
  });
});
