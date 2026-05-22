/**
 * PR #283 — Tests pure logic walkForward + normalizeAndSortCandles.
 *
 * Bug observé prod 07/05/2026 : 100% NO_DATA sur 1304 rows / 24h. Cause :
 * EODHD retournait les candles DESC (most-recent-first), walkForward
 * itérait avec un break sur cutoffTs → break immédiat → lastBeforeCutoff
 * stays null → NO_DATA. PR #283 force le tri ASC + détecte ms vs s.
 */
import {
  walkForward,
  normalizeAndSortCandles,
  type SimGrid,
  type CandleLike,
} from '../services/gainers-user-shadow.service';

const baselineGrid60: SimGrid = { key: 'baseline_60m', tpPct: 0.02, slPct: 0.009, windowMin: 60 };
const baselineGrid30: SimGrid = { key: 'baseline_30m', tpPct: 0.02, slPct: 0.009, windowMin: 30 };

// Helper : crée une candle 5m (timestamp en seconds)
function candle(tsSec: number, open: number, high: number, low: number, close: number): CandleLike {
  return { timestamp: tsSec, high, low, close, open } as CandleLike;
}

describe('normalizeAndSortCandles', () => {
  it('keeps seconds timestamps unchanged when sorted ASC', () => {
    const input = [
      candle(1700000000, 100, 101, 99, 100.5),
      candle(1700000300, 100.5, 102, 100, 101),
      candle(1700000600, 101, 103, 100.5, 102),
    ];
    const out = normalizeAndSortCandles(input);
    expect(out.map((c) => c.timestamp)).toEqual([1700000000, 1700000300, 1700000600]);
    expect(out[0].close).toBe(100.5);
  });

  it('sorts DESC input to ASC', () => {
    const input = [
      candle(1700000600, 101, 103, 100.5, 102),
      candle(1700000300, 100.5, 102, 100, 101),
      candle(1700000000, 100, 101, 99, 100.5),
    ];
    const out = normalizeAndSortCandles(input);
    expect(out.map((c) => c.timestamp)).toEqual([1700000000, 1700000300, 1700000600]);
  });

  it('detects ms timestamps (>1e12) and converts to seconds', () => {
    const input = [
      candle(1700000600000, 101, 103, 100.5, 102),
      candle(1700000300000, 100.5, 102, 100, 101),
      candle(1700000000000, 100, 101, 99, 100.5),
    ];
    const out = normalizeAndSortCandles(input);
    expect(out.map((c) => c.timestamp)).toEqual([1700000000, 1700000300, 1700000600]);
  });

  it('handles empty input', () => {
    expect(normalizeAndSortCandles([])).toEqual([]);
  });

  it('does not mutate input array', () => {
    const input = [
      candle(1700000600, 0, 0, 0, 0),
      candle(1700000000, 0, 0, 0, 0),
    ];
    const before = [...input];
    normalizeAndSortCandles(input);
    expect(input).toEqual(before);
  });
});

describe('walkForward', () => {
  // Entry $100, TP $102 (+2%), SL $99.10 (-0.9%), window 60min
  const startTs = 1700000000;
  const entry = 100;

  it('returns NO_DATA on empty candles', () => {
    const out = walkForward(entry, [], startTs, baselineGrid60);
    expect(out.outcome).toBe('NO_DATA');
    expect(out.exit_price).toBeNull();
    expect(out.exit_at).toBeNull();
    expect(out.pnl_pct).toBeNull();
  });

  it('detects TP_HIT on first qualifying candle (high >= tp)', () => {
    const candles = [
      candle(startTs + 300, 100, 100.5, 99.5, 100.2),     // T+5min, no hit
      candle(startTs + 600, 100.2, 102.5, 100, 102.1),    // T+10min, TP hit (high 102.5 ≥ 102)
      candle(startTs + 900, 102, 103, 101.5, 102.5),      // T+15min, ignored (already returned)
    ];
    const out = walkForward(entry, candles, startTs, baselineGrid60);
    expect(out.outcome).toBe('TP_HIT');
    expect(out.exit_price).toBeCloseTo(102, 4);
    expect(out.hit_at_min).toBe(10);
    // pnl_pct = tpPct - slippage_total = 0.02 - 0.0030 = 0.017
    expect(out.pnl_pct).toBeCloseTo(0.017, 4);
  });

  it('detects SL_HIT on first qualifying candle (low <= sl)', () => {
    const candles = [
      candle(startTs + 300, 100, 100.2, 99.8, 100),       // T+5min, no hit
      candle(startTs + 600, 100, 100.5, 99.0, 99.2),      // T+10min, SL hit (low 99.0 ≤ 99.10)
    ];
    const out = walkForward(entry, candles, startTs, baselineGrid60);
    expect(out.outcome).toBe('SL_HIT');
    expect(out.exit_price).toBeCloseTo(99.10, 4);
    expect(out.hit_at_min).toBe(10);
    // pnl_pct = -slPct - slippage_total = -0.009 - 0.0030 = -0.012
    expect(out.pnl_pct).toBeCloseTo(-0.012, 4);
  });

  it('SL takes precedence over TP when both could trigger same candle (conservative tie-break)', () => {
    const candles = [
      // Wide range candle : low 98 (would hit SL 99.10) AND high 103 (would hit TP 102)
      candle(startTs + 300, 100, 103, 98, 100),
    ];
    const out = walkForward(entry, candles, startTs, baselineGrid60);
    expect(out.outcome).toBe('SL_HIT');
  });

  it('returns TIME_LIMIT with last candle close when neither TP nor SL hit before cutoff', () => {
    const candles = [
      candle(startTs + 300, 100, 100.5, 99.5, 100.2),
      candle(startTs + 1800, 100.2, 101, 99.5, 100.8),    // T+30min, mid-range
      candle(startTs + 3600, 100.8, 101.5, 99.5, 101.2),  // T+60min, exactly at cutoff
    ];
    const out = walkForward(entry, candles, startTs, baselineGrid60);
    expect(out.outcome).toBe('TIME_LIMIT');
    expect(out.exit_price).toBeCloseTo(101.2, 4);
    expect(out.hit_at_min).toBe(60);
    // pnl_pct = (101.2 - 100) / 100 - 0.0030 = 0.012 - 0.003 = 0.009
    expect(out.pnl_pct).toBeCloseTo(0.009, 4);
  });

  it('respects windowMin cutoff (baseline_30m breaks at +30min, ignores +45min TP)', () => {
    const candles = [
      candle(startTs + 600, 100, 100.5, 99.5, 100.2),     // T+10min
      candle(startTs + 1500, 100.2, 100.8, 99.8, 100.5),  // T+25min, no hit
      candle(startTs + 2700, 100.5, 102.5, 100.2, 102.2), // T+45min, would be TP but past 30m cutoff
    ];
    const out = walkForward(entry, candles, startTs, baselineGrid30);
    // baseline_30m cutoffTs = startTs + 1800. T+2700 > 1800 → break.
    // Last before cutoff = T+1500, close 100.5 → TIME_LIMIT
    expect(out.outcome).toBe('TIME_LIMIT');
    expect(out.exit_price).toBeCloseTo(100.5, 4);
    expect(out.hit_at_min).toBe(25);
  });

  it('regression : DESC-ordered input alone would give NO_DATA — proving why normalize is mandatory', () => {
    const candlesDesc = [
      candle(startTs + 3600, 100.8, 101.5, 99.5, 101.2),
      candle(startTs + 1800, 100.2, 101, 99.5, 100.8),
      candle(startTs + 300, 100, 100.5, 99.5, 100.2),
    ];
    // Sans tri (input direct DESC) : break à la première itération
    // car candlesDesc[0].timestamp (3600) > cutoffTs (3600) ? Non, ts EQUAL → pas break
    // Mais T+3600 > startTs+1800 (cutoff baseline_30m) → break. Dernière itération.
    const outDirect = walkForward(entry, candlesDesc, startTs, baselineGrid30);
    expect(outDirect.outcome).toBe('NO_DATA');  // confirme le bug

    // Avec normalize : tri ASC → walkForward fonctionne normalement.
    // Candles ASC : [+300s, +1800s, +3600s]. cutoffTs (baseline_30m) = startTs + 1800.
    // T+1800 inclusif (≤ cutoff), T+3600 break. lastBeforeCutoff = T+1800 (= 30min).
    const sorted = normalizeAndSortCandles(candlesDesc);
    const outSorted = walkForward(entry, sorted, startTs, baselineGrid30);
    expect(outSorted.outcome).toBe('TIME_LIMIT');
    expect(outSorted.hit_at_min).toBe(30);
  });
});

describe('walkForward — variante trailing-TP (let winners run, MESURE)', () => {
  const SLIP = 0.003; // 30bps round-trip
  const ENTRY = 100;
  const T0 = 1700000000;
  const trailGrid: SimGrid = {
    key: 'trail_gb15_60m', tpPct: 0.02, slPct: 0.009, windowMin: 60,
    direction: 'long', givebackPct: 0.015,
  };

  it('laisse courir au-delà du TP fixe et sort sur repli 1.5% depuis le pic', () => {
    // active à +2% (c1 high 103), pic monte à 105 (c2), repli sur c3 → sortie à 105×0.985=103.425
    const candles = [
      candle(T0 + 60, 100, 103, 100, 102),   // active (peak→103)
      candle(T0 + 120, 102, 105, 104, 104.5), // peak→105
      candle(T0 + 180, 104.5, 104.5, 103, 103.2), // low 103 <= 105×0.985=103.425 → exit
    ];
    const r = walkForward(ENTRY, candles, T0, trailGrid);
    expect(r.outcome).toBe('TP_HIT');
    expect(r.exit_price).toBeCloseTo(103.425, 3);
    expect(r.pnl_pct).toBeCloseTo((103.425 - 100) / 100 - SLIP, 4); // ≈ +3.125%
  });

  it('bat le TP fixe sur le même chemin haussier (baseline sort à +2%, trailing à +3.1%)', () => {
    const candles = [
      candle(T0 + 60, 100, 103, 100, 102),
      candle(T0 + 120, 102, 105, 104, 104.5),
      candle(T0 + 180, 104.5, 104.5, 103, 103.2),
    ];
    const fixed = walkForward(ENTRY, candles, T0, baselineGrid60); // TP 2%
    const trail = walkForward(ENTRY, candles, T0, trailGrid);
    expect(fixed.pnl_pct).toBeCloseTo(0.02 - SLIP, 4);     // +1.7%
    expect((trail.pnl_pct as number)).toBeGreaterThan(fixed.pnl_pct as number);
  });

  it('plancher SL respecté (repli profond) → SL_HIT à -slPct', () => {
    const candles = [candle(T0 + 60, 100, 100.5, 99, 99.2)]; // low 99 <= 100×0.991=99.1
    const r = walkForward(ENTRY, candles, T0, trailGrid);
    expect(r.outcome).toBe('SL_HIT');
    expect(r.pnl_pct).toBeCloseTo(-0.009 - SLIP, 4); // -1.2%
  });

  it('pas de look-ahead : bougie spike-puis-crash → SL_HIT (pas de gain trailing fantôme)', () => {
    // c1 high 106 (activerait) MAIS low 98 < SL 99.1 → SL_HIT prioritaire, activation n a pas lieu
    const candles = [candle(T0 + 60, 100, 106, 98, 99)];
    const r = walkForward(ENTRY, candles, T0, trailGrid);
    expect(r.outcome).toBe('SL_HIT');
  });

  it('jamais activé (reste sous +2%) → TIME_LIMIT sur close', () => {
    const candles = [
      candle(T0 + 60, 100, 101, 99.5, 100.5),
      candle(T0 + 120, 100.5, 101.2, 100, 100.8),
    ];
    const r = walkForward(ENTRY, candles, T0, trailGrid);
    expect(r.outcome).toBe('TIME_LIMIT');
    expect(r.pnl_pct).toBeCloseTo((100.8 - 100) / 100 - SLIP, 4);
  });
});
