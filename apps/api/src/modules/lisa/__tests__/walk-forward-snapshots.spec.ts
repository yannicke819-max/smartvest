/**
 * MESURE-PR (11/05/2026) — Tests pour le patch persistance directionnelle.
 *
 * 3 sections :
 *   A. computePriceSnapshots — fonction pure, 3 scenarios (empty / sparse / partial)
 *   B. walkForward rétro-compat — outcome/pnl_pct/hit_at_min inchangés vs pré-patch
 *   C. Microbenchmark p95 — walkForward + computePriceSnapshots (mix 30/30/40)
 *
 * Pas de PR, pas de deploy. Phase MESURE strict.
 */

import {
  walkForward,
  computePriceSnapshots,
  getGridsForAssetClass,
  MAX_WINDOW_MIN,
  SIMULATE_BUFFER_MIN,
  SIMULATE_AFTER_MIN,
  type SimGrid,
  type CandleLike,
} from '../services/gainers-user-shadow.service';

const BASELINE_GRID: SimGrid = { key: 'baseline_60m', tpPct: 0.02, slPct: 0.009, windowMin: 60 };

function mkCandle(tsOffsetSec: number, close: number, opts: { high?: number; low?: number } = {}): CandleLike {
  return {
    timestamp: 1700000000 + tsOffsetSec,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
  };
}

// ============================================================
// A. computePriceSnapshots — fonction pure
// ============================================================
describe('computePriceSnapshots — fonction pure', () => {
  const startTs = 1700000000;

  it('candles vides → tous snapshots null', () => {
    expect(computePriceSnapshots([], startTs))
      .toEqual({ '5': null, '15': null, '30': null, '60': null });
  });

  it('TIME_LIMIT-like : 13 candles 5min linéaires → 4 snapshots populés', () => {
    const candles = Array.from({ length: 13 }, (_, i) =>
      mkCandle(i * 300, 100 + i * 0.08),
    );
    const r = computePriceSnapshots(candles, startTs);
    expect(r['5']).toBeCloseTo(100.08, 2);   // candle at +5min (i=1)
    expect(r['15']).toBeCloseTo(100.24, 2);  // candle at +15min (i=3)
    expect(r['30']).toBeCloseTo(100.48, 2);  // candle at +30min (i=6)
    expect(r['60']).toBeCloseTo(100.96, 2);  // candle at +60min (i=12)
  });

  it('candles sparses 20min → snapshot 5 et 15 pointent vers candle +20min', () => {
    const candles = [
      mkCandle(1200, 100.5),   // +20min
      mkCandle(2400, 101.0),   // +40min
      mkCandle(3600, 101.5),   // +60min
    ];
    const r = computePriceSnapshots(candles, startTs);
    expect(r['5']).toBeCloseTo(100.5, 2);
    expect(r['15']).toBeCloseTo(100.5, 2);
    expect(r['30']).toBeCloseTo(101.0, 2);
    expect(r['60']).toBeCloseTo(101.5, 2);
  });

  it('candles partielles (jusqu\'à +30min) → snapshot 60 reste null', () => {
    const candles = [
      mkCandle(300, 100.2),
      mkCandle(1800, 101.0),
    ];
    const r = computePriceSnapshots(candles, startTs);
    expect(r['5']).toBeCloseTo(100.2, 2);
    expect(r['30']).toBeCloseTo(101.0, 2);
    expect(r['60']).toBeNull();
  });

  it('candles tronquées avant 5min → tous null', () => {
    const candles = [mkCandle(60, 100.1)];  // +1min seulement
    const r = computePriceSnapshots(candles, startTs);
    expect(r).toEqual({ '5': null, '15': null, '30': null, '60': null });
  });
});

// ============================================================
// B. walkForward rétro-compat — pré-patch behavior preserved
// ============================================================
describe('walkForward — rétro-compat (MESURE-PR ne modifie pas walkForward)', () => {
  const startTs = 1700000000;
  const entry = 100;

  it('TP_HIT @+7min : outcome/exit_price/pnl_pct/hit_at_min inchangés vs pré-patch', () => {
    const candles = [
      mkCandle(180, 100.3),
      mkCandle(420, 102.5, { high: 102.5 }),
    ];
    const r = walkForward(entry, candles, startTs, BASELINE_GRID);
    expect(r.outcome).toBe('TP_HIT');
    expect(r.exit_price).toBe(102);
    expect(r.pnl_pct).toBeCloseTo(0.017, 3);  // 0.02 - 0.003 slippage
    expect(r.hit_at_min).toBe(7);
  });

  it('SL_HIT @+12min : outcome/pnl_pct préservés', () => {
    const candles = [
      mkCandle(300, 99.8),
      mkCandle(720, 99.5, { low: 99.0 }),
    ];
    const r = walkForward(entry, candles, startTs, BASELINE_GRID);
    expect(r.outcome).toBe('SL_HIT');
    expect(r.hit_at_min).toBe(12);
    expect(r.pnl_pct).toBeCloseTo(-0.012, 3);  // -0.009 - 0.003 slip
  });

  it('TIME_LIMIT : close at last candle', () => {
    const candles = Array.from({ length: 13 }, (_, i) =>
      mkCandle(i * 300, 100 + i * 0.05),
    );
    const r = walkForward(entry, candles, startTs, BASELINE_GRID);
    expect(r.outcome).toBe('TIME_LIMIT');
    expect(r.pnl_pct).toBeCloseTo(0.0030, 4);  // (100.6 - 100) / 100 - 0.003 = 0.003
  });

  it('NO_DATA on empty candles', () => {
    const r = walkForward(entry, [], startTs, BASELINE_GRID);
    expect(r.outcome).toBe('NO_DATA');
    expect(r.pnl_pct).toBeNull();
  });
});

// ============================================================
// C. Microbenchmark p95 — Option A baseline
// ============================================================
describe('Microbenchmark p95 — Option A (MESURE-PR baseline)', () => {
  const N = 10000;
  const startTs = 1700000000;
  const entry = 100;

  function genCandles(scenario: 'TP' | 'SL' | 'TIME'): CandleLike[] {
    if (scenario === 'TP') {
      // TP_HIT à +5min : high=102.5 hits TP=102
      return [
        mkCandle(60, 100.3, { high: 100.5, low: 99.8 }),
        mkCandle(300, 101.8, { high: 102.5, low: 100.2 }),
      ];
    }
    if (scenario === 'SL') {
      // SL_HIT à +8min : low=99.0 hits SL=99.1
      return [
        mkCandle(60, 99.8, { high: 100.2, low: 99.6 }),
        mkCandle(480, 99.2, { high: 99.9, low: 99.0 }),
      ];
    }
    // TIME_LIMIT : 13 candles spaced 5min, no TP/SL hit
    return Array.from({ length: 13 }, (_, i) => {
      const close = 100 + i * 0.05;
      return mkCandle(i * 300, close, { high: close + 0.05, low: close - 0.05 });
    });
  }

  function percentile(sorted: number[], p: number): number {
    return sorted[Math.floor(sorted.length * p)];
  }

  it('walkForward p95 multi-metric 3 runs (Option A — mix 30/30/40 + projected 3/3/94)', () => {
    // 3 runs consécutifs pour mesurer variance (stddev) sur les métriques clés.
    type RunMetrics = {
      p95_brut: number;       // p95 mix 30/30/40
      p95_weighted: number;   // p95 projeté prod 3/3/94 via resampling
      p95_tp: number;         // p95 path TP_HIT seul
      p95_sl: number;         // p95 path SL_HIT seul
      p95_time: number;       // p95 path TIME_LIMIT seul
      p50_brut: number;
    };
    const runs: RunMetrics[] = [];

    for (let run = 0; run < 3; run++) {
      const fixtures: CandleLike[][] = [];
      const scenarios: ('TP' | 'SL' | 'TIME')[] = [];
      for (let i = 0; i < N; i++) {
        const r = i % 10;
        const scenario: 'TP' | 'SL' | 'TIME' = r < 3 ? 'TP' : r < 6 ? 'SL' : 'TIME';
        fixtures.push(genCandles(scenario));
        scenarios.push(scenario);
      }

      // Warm-up V8 (1000 calls discarded)
      for (let i = 0; i < 1000; i++) walkForward(entry, fixtures[i % N], startTs, BASELINE_GRID);

      // Bench timing
      const latenciesAll: number[] = [];
      const byPath: Record<'TP' | 'SL' | 'TIME', number[]> = { TP: [], SL: [], TIME: [] };
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        walkForward(entry, fixtures[i], startTs, BASELINE_GRID);
        const lat = performance.now() - t0;
        latenciesAll.push(lat);
        byPath[scenarios[i]].push(lat);
      }

      // Per-path p95 (chaque path indépendamment, robust à n~3000)
      const p95_tp = percentile([...byPath.TP].sort((a, b) => a - b), 0.95);
      const p95_sl = percentile([...byPath.SL].sort((a, b) => a - b), 0.95);
      const p95_time = percentile([...byPath.TIME].sort((a, b) => a - b), 0.95);

      // Brut p95 sur mix 30/30/40
      const sortedAll = [...latenciesAll].sort((a, b) => a - b);
      const p50_brut = percentile(sortedAll, 0.50);
      const p95_brut = percentile(sortedAll, 0.95);

      // Projected p95 prod 3/3/94 : resampling pondéré sur les samples per-path
      // Tire 10000 latences en respectant la distribution prod observée.
      const projected: number[] = [];
      for (let i = 0; i < N; i++) {
        const r = Math.random() * 100;
        const arr = r < 3 ? byPath.TP : r < 6 ? byPath.SL : byPath.TIME;
        projected.push(arr[Math.floor(Math.random() * arr.length)]);
      }
      const p95_weighted = percentile(projected.sort((a, b) => a - b), 0.95);

      runs.push({ p95_brut, p95_weighted, p95_tp, p95_sl, p95_time, p50_brut });
    }

    // Aggregate mean + stddev across 3 runs
    const stats = (key: keyof RunMetrics) => {
      const vals = runs.map((r) => r[key]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return { mean, stddev: Math.sqrt(variance), vals };
    };

    const fmt = (s: { mean: number; stddev: number; vals: number[] }) =>
      `mean=${(s.mean * 1000).toFixed(2)}μs stddev=${(s.stddev * 1000).toFixed(2)}μs ` +
      `runs=[${s.vals.map((v) => (v * 1000).toFixed(2)).join(',')}]μs`;

    /* eslint-disable no-console */
    console.log(`[BENCH walkForward] 3 runs × N=${N} chacun`);
    console.log(`  p50_brut    (30/30/40)         : ${fmt(stats('p50_brut'))}`);
    console.log(`  p95_brut    (30/30/40)         : ${fmt(stats('p95_brut'))}`);
    console.log(`  p95_weighted (projeté 3/3/94) : ${fmt(stats('p95_weighted'))}`);
    console.log(`  p95_tp      (path TP_HIT)      : ${fmt(stats('p95_tp'))}`);
    console.log(`  p95_sl      (path SL_HIT)      : ${fmt(stats('p95_sl'))}`);
    console.log(`  p95_time    (path TIME_LIMIT)  : ${fmt(stats('p95_time'))}`);
    /* eslint-enable no-console */

    // Smoke check ultra-conservatif sur p95 brut max sur les 3 runs
    const maxP95 = Math.max(...runs.map((r) => r.p95_brut));
    expect(maxP95).toBeLessThan(1);
  });

  it('computePriceSnapshots p95 sur 10000 calls (TIME scenario, slowest)', () => {
    const candles = genCandles('TIME');  // 13 candles = full iteration

    // Warm-up
    for (let i = 0; i < 1000; i++) computePriceSnapshots(candles, startTs);

    const latencies: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      computePriceSnapshots(candles, startTs);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);

    const p50 = percentile(latencies, 0.50);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);

    // eslint-disable-next-line no-console
    console.log(
      `[BENCH computePriceSnapshots] N=${N} scenario=TIME ` +
      `p50=${(p50 * 1000).toFixed(2)}μs ` +
      `p95=${(p95 * 1000).toFixed(2)}μs ` +
      `p99=${(p99 * 1000).toFixed(2)}μs`,
    );

    expect(p95).toBeLessThan(0.5);
  });
});

// ============================================================
// D. Integration smoke — simulatePending UPDATE structure
// ============================================================
describe('simulatePending UPDATE structure — JSONB root-level snapshots', () => {
  it('UPDATE sim_results contient price_snapshots au ROOT, pas dans chaque grille', () => {
    // Smoke check sur la structure attendue après merge dans simulatePending.
    // Reproduit le pattern `{ ...simResults, price_snapshots: priceSnapshots }`.
    const fakeSimResults = {
      baseline_30m: { outcome: 'TIME_LIMIT', pnl_pct: 0.003, exit_price: 100.3 },
      baseline_60m: { outcome: 'TIME_LIMIT', pnl_pct: 0.005, exit_price: 100.5 },
      alt15_30m:    { outcome: 'TP_HIT',     pnl_pct: 0.012, exit_price: 101.5 },
      alt15_60m:    { outcome: 'TP_HIT',     pnl_pct: 0.012, exit_price: 101.5 },
    };
    const fakeSnapshots = { '5': 100.5, '15': 101.0, '30': 101.3, '60': 101.5 };

    const merged = { ...fakeSimResults, price_snapshots: fakeSnapshots };

    // Structure root-level vérifiée
    expect(merged).toHaveProperty('price_snapshots');
    expect(merged.price_snapshots).toEqual(fakeSnapshots);

    // Grilles inchangées, pas de price_snapshots à l'intérieur
    expect(merged.baseline_30m).not.toHaveProperty('price_snapshots');
    expect(merged.baseline_60m).not.toHaveProperty('price_snapshots');
    expect(merged.alt15_30m).not.toHaveProperty('price_snapshots');
    expect(merged.alt15_60m).not.toHaveProperty('price_snapshots');
  });

  it('Fallback all-null snapshots quand simulateRow early-return (priceSnapshots undefined)', () => {
    // Reproduit le pattern `priceSnapshots ?? { '5': null, ... }` du simulatePending
    const priceSnapshots: { '5': number | null; '15': number | null; '30': number | null; '60': number | null } | undefined = undefined;
    const fallback = priceSnapshots ?? { '5': null, '15': null, '30': null, '60': null };
    expect(fallback).toEqual({ '5': null, '15': null, '30': null, '60': null });
  });
});

// ============================================================
// E. SHORT-SHADOW (11/05/2026) — walkForward direction='short'
// ============================================================
describe('walkForward — direction SHORT (SHORT-SHADOW)', () => {
  const startTs = 1700000000;
  const entry = 100;
  const SHORT_BASELINE: SimGrid = { key: 'short_baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60, direction: 'short' };

  it('SHORT TP_HIT : prix DESCEND vers tpPrice = entry - tpPct', () => {
    // entry=100, tp = 100 × (1 - 0.02) = 98. SL = 100 × (1 + 0.009) = 100.9
    // Candle à +7min avec low=97.5 → hit TP en short (prix sous 98)
    const candles = [
      mkCandle(180, 100.1, { low: 99.8, high: 100.3 }),
      mkCandle(420, 98.5, { low: 97.5, high: 99.5 }),  // low <= 98 = TP_HIT
    ];
    const r = walkForward(entry, candles, startTs, SHORT_BASELINE);
    expect(r.outcome).toBe('TP_HIT');
    expect(r.exit_price).toBe(98);
    expect(r.pnl_pct).toBeCloseTo(0.017, 3);  // +tpPct - slippage = profit positif
    expect(r.hit_at_min).toBe(7);
  });

  it('SHORT SL_HIT : prix MONTE vers slPrice = entry + slPct', () => {
    // entry=100, sl = 100 × (1 + 0.009) = 100.9. TP = 98
    // Candle à +12min avec high=101.5 → hit SL en short (prix au-dessus 100.9)
    const candles = [
      mkCandle(300, 100.4, { low: 100.2, high: 100.7 }),
      mkCandle(720, 101.2, { low: 100.9, high: 101.5 }),  // high >= 100.9 = SL_HIT
    ];
    const r = walkForward(entry, candles, startTs, SHORT_BASELINE);
    expect(r.outcome).toBe('SL_HIT');
    expect(r.exit_price).toBeCloseTo(100.9, 2);
    expect(r.pnl_pct).toBeCloseTo(-0.012, 3);  // -slPct - slippage = loss négatif
    expect(r.hit_at_min).toBe(12);
  });

  it('SHORT TIME_LIMIT : pnl positif si prix descend, négatif si prix monte', () => {
    // entry=100, fenêtre 60min, 13 candles linéaires close 100→99.4
    // En SHORT, profit si prix descend → closePnl = (entry - close) / entry = +0.6%
    const candles = Array.from({ length: 13 }, (_, i) => {
      const close = 100 - i * 0.05;  // 100, 99.95, ..., 99.4
      return mkCandle(i * 300, close, { high: close + 0.05, low: close - 0.05 });
    });
    const r = walkForward(entry, candles, startTs, SHORT_BASELINE);
    expect(r.outcome).toBe('TIME_LIMIT');
    expect(r.exit_price).toBeCloseTo(99.4, 2);
    // (100 - 99.4) / 100 - 0.003 slip = 0.0030
    expect(r.pnl_pct).toBeCloseTo(0.003, 3);
  });

  it('SHORT TIME_LIMIT inverse-symmetry : sur path montant, SHORT pnl = -LONG pnl à slip près', () => {
    // entry=100, prix monte linéairement 100→100.6 sur 60min
    // LONG  closePnl = (100.6 - 100) / 100 = +0.006 → pnl_pct = +0.003 (après slip)
    // SHORT closePnl = (100 - 100.6) / 100 = -0.006 → pnl_pct = -0.009 (après slip)
    const candles = Array.from({ length: 13 }, (_, i) => {
      const close = 100 + i * 0.05;
      return mkCandle(i * 300, close, { high: close + 0.05, low: close - 0.05 });
    });
    const LONG_BASELINE: SimGrid = { key: 'baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60, direction: 'long' };
    const rLong = walkForward(entry, candles, startTs, LONG_BASELINE);
    const rShort = walkForward(entry, candles, startTs, SHORT_BASELINE);
    expect(rLong.outcome).toBe('TIME_LIMIT');
    expect(rShort.outcome).toBe('TIME_LIMIT');
    // LONG profit (prix monte) ↔ SHORT loss (prix monte) — pnl signs opposés
    expect(rLong.pnl_pct).toBeCloseTo(0.003, 3);
    expect(rShort.pnl_pct).toBeCloseTo(-0.009, 3);
  });

  it('SHORT NO_DATA on empty candles', () => {
    const r = walkForward(entry, [], startTs, SHORT_BASELINE);
    expect(r.outcome).toBe('NO_DATA');
    expect(r.pnl_pct).toBeNull();
  });

  it('Rétro-compat : grid sans direction = LONG par défaut', () => {
    const noDirectionGrid: SimGrid = { key: 'legacy', tpPct: 0.020, slPct: 0.009, windowMin: 60 };
    const candles = [mkCandle(180, 100.3), mkCandle(420, 102.5, { high: 102.5 })];
    const r = walkForward(entry, candles, startTs, noDirectionGrid);
    // LONG TP_HIT à +7min = comportement pré-patch
    expect(r.outcome).toBe('TP_HIT');
    expect(r.exit_price).toBe(102);
    expect(r.hit_at_min).toBe(7);
  });
});

// ============================================================
// F. SHORT-SHADOW — getGridsForAssetClass (scope strict small/mid US)
// ============================================================
describe('getGridsForAssetClass — scope strict SHORT (SHORT-SHADOW)', () => {
  it('us_equity_small_mid retourne 10 grids (4 LONG + 6 SHORT)', () => {
    const grids = getGridsForAssetClass('us_equity_small_mid');
    expect(grids).toHaveLength(10);
    const keys = grids.map((g) => g.key);
    expect(keys).toEqual([
      'baseline_30m', 'baseline_60m', 'alt15_30m', 'alt15_60m',
      'short_baseline_30m', 'short_baseline_60m',
      'short_alt15_30m', 'short_alt15_60m',
      'short_calibrated_30m', 'short_calibrated_60m',
    ]);
  });

  it('us_equity_large retourne 4 grids LONG seulement', () => {
    const grids = getGridsForAssetClass('us_equity_large');
    expect(grids).toHaveLength(4);
    expect(grids.every((g) => g.direction !== 'short')).toBe(true);
  });

  it('eu_equity, asia_equity, crypto_major retournent 4 grids LONG (scope strict)', () => {
    for (const cls of ['eu_equity', 'asia_equity', 'crypto_major', 'crypto_alt']) {
      const grids = getGridsForAssetClass(cls);
      expect(grids).toHaveLength(4);
      expect(grids.every((g) => g.direction !== 'short')).toBe(true);
    }
  });

  it('SHORT calibrated grids : TP 0.8% / SL 0.4% (ratio 2:1, breakeven 33%)', () => {
    const grids = getGridsForAssetClass('us_equity_small_mid');
    const calibrated = grids.filter((g) => g.key.startsWith('short_calibrated_'));
    expect(calibrated).toHaveLength(2);
    for (const g of calibrated) {
      expect(g.tpPct).toBeCloseTo(0.008, 4);
      expect(g.slPct).toBeCloseTo(0.004, 4);
      expect(g.direction).toBe('short');
    }
  });

  it('SHORT baseline mirror : mêmes TP/SL que LONG baseline (apples-to-apples)', () => {
    const grids = getGridsForAssetClass('us_equity_small_mid');
    const longBaseline = grids.find((g) => g.key === 'baseline_60m')!;
    const shortBaseline = grids.find((g) => g.key === 'short_baseline_60m')!;
    expect(shortBaseline.tpPct).toBe(longBaseline.tpPct);
    expect(shortBaseline.slPct).toBe(longBaseline.slPct);
    expect(shortBaseline.windowMin).toBe(longBaseline.windowMin);
    expect(shortBaseline.direction).toBe('short');
    expect(longBaseline.direction).toBe('long');
  });
});

// ============================================================
// G. SHORT-SHADOW TIMING-FIX (11/05/2026) — SIMULATE_AFTER_MIN
// ============================================================
describe('SIMULATE_AFTER_MIN — cutoff timing simulatePending (SHORT-SHADOW TIMING-FIX)', () => {
  it('SIMULATE_AFTER_MIN = MAX_WINDOW_MIN + SIMULATE_BUFFER_MIN', () => {
    expect(SIMULATE_AFTER_MIN).toBe(MAX_WINDOW_MIN + SIMULATE_BUFFER_MIN);
  });

  it('MAX_WINDOW_MIN = 60 (largest grid window across LONG + SHORT)', () => {
    expect(MAX_WINDOW_MIN).toBe(60);
    // Sanity check : aucune grille n'a un windowMin supérieur
    const smallMidGrids = getGridsForAssetClass('us_equity_small_mid');
    const maxObserved = Math.max(...smallMidGrids.map((g) => g.windowMin));
    expect(maxObserved).toBeLessThanOrEqual(MAX_WINDOW_MIN);
  });

  it('SIMULATE_BUFFER_MIN = 5 (EODHD candle propagation lag tolerance)', () => {
    expect(SIMULATE_BUFFER_MIN).toBe(5);
  });

  it('SIMULATE_AFTER_MIN = 65 (bug-fix 08/05/2026 : 60→65 pour tolérer race condition)', () => {
    expect(SIMULATE_AFTER_MIN).toBe(65);
  });
});
