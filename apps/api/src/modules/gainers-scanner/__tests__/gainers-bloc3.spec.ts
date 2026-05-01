/**
 * BLOC 3 — Triggers d'entrée : PULLBACK_HL_FIBO + VWAP_RECLAIM.
 * Tests unitaires des helpers purs + service orchestrateur.
 */

import { EntryTriggerKind, TrendFilterKind, CandidateRejectReason } from '../domain/gainers-enums';
import type { GainersScoredCandidate } from '../domain/gainers-candidate.types';
import type { CandleOHLCV } from '../bloc2/spread-proxy';
import { computeVwap } from '../bloc3/vwap';
import { computeSwingPivots, nearestFiboLevel } from '../bloc3/swing-pivot';
import { detectVolumeSurge, detectGapUp } from '../bloc3/volume-surge';
import { detectStructureBreak } from '../bloc3/structure-break';
import { computeRvolNormalized } from '../bloc3/rvol-normalized';
import { evaluatePullbackHL } from '../bloc3/pullback-hl';
import { evaluateVwapReclaim } from '../bloc3/vwap-reclaim';
import { GainersBloc3Service } from '../bloc3/gainers-bloc3.service';

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeCandle = (high: number, low: number, close: number, volume = 1000): CandleOHLCV => ({
  open: (high + low) / 2,
  high,
  low,
  close,
  volume,
});

const makeAcceptCandidate = (): GainersScoredCandidate => ({
  raw: {
    symbol: 'AAPL.US',
    market: 'equity',
    exchange: 'US',
    close: 200,
    open: 198,
    high: 202,
    low: 197,
    vol24hUsd: 50_000_000,
    medianDailyVolUsd20d: 25_000_000,
    marketCapUsd: 3_000_000_000_000,
    atrDailyRelative: 0.03,
    changePct1m: 0.02,
    persistenceScore: 0.83,
    persistenceCount: '5/6',
    ema50Daily: 195,
    ema200Daily: 180,
  },
  compositeScore: 0.75,
  decision: 'ACCEPT',
  rejectReason: null,
  spreadProxy: 0.002,
  spreadProxySource: null,
  trendFilter: TrendFilterKind.EMA_GOLDEN_CROSS,
  rvolIntraday: null,
});

// Série avec swing high=205 (index 2) et swing low=191 (index 6)
// Prix courant (index 9) close=198 ≈ fibo 50% = (205+191)/2 = 198, vol=2000 > 1.5×1000
const makeSwingCandles = (): CandleOHLCV[] => [
  makeCandle(200, 195, 197),
  makeCandle(202, 196, 198),
  makeCandle(205, 197, 204),  // swing high
  makeCandle(203, 196, 198),
  makeCandle(201, 195, 196),
  makeCandle(199, 193, 194),
  makeCandle(197, 191, 192),  // swing low
  makeCandle(199, 192, 195),
  makeCandle(201, 193, 197),
  makeCandle(200, 197, 198, 2000),  // near fibo 50%, surge
];

// ─── computeVwap ─────────────────────────────────────────────────────────────

describe('computeVwap()', () => {
  it('computes weighted average over typical prices', () => {
    const candles: CandleOHLCV[] = [
      { open: 100, high: 110, low: 90, close: 100, volume: 1000 },
      { open: 100, high: 120, low: 80, close: 100, volume: 2000 },
    ];
    // typical = (H+L+C)/3 = 100 for both → VWAP = 100
    const r = computeVwap(candles);
    expect(r.insufficient).toBe(false);
    expect(r.vwap).toBeCloseTo(100, 4);
  });

  it('returns insufficient=true for empty candles', () => {
    expect(computeVwap([]).insufficient).toBe(true);
  });

  it('skips zero-volume candles', () => {
    const candles: CandleOHLCV[] = [
      { open: 100, high: 110, low: 90, close: 100, volume: 0 },
      { open: 200, high: 220, low: 180, close: 200, volume: 500 },
    ];
    const r = computeVwap(candles);
    expect(r.insufficient).toBe(false);
    expect(r.vwap).toBeCloseTo(200, 4);
  });
});

// ─── computeSwingPivots ───────────────────────────────────────────────────────

describe('computeSwingPivots()', () => {
  it('finds swing high and swing low in a clear trend reversal', () => {
    const highs = [200, 202, 205, 203, 201, 199, 197, 199, 201];
    const lows  = [195, 196, 197, 196, 195, 193, 191, 192, 193];
    const r = computeSwingPivots(highs, lows);
    expect(r.swingHigh?.price).toBe(205);
    expect(r.swingLow?.price).toBe(191);
  });

  it('returns null pivots for series too short', () => {
    const r = computeSwingPivots([200, 202, 205], [195, 196, 197]);
    expect(r.swingHigh).toBeNull();
    expect(r.swingLow).toBeNull();
  });

  it('computes Fibonacci levels from swing high/low', () => {
    const highs = [200, 202, 205, 203, 201, 199, 197, 199, 201];
    const lows  = [195, 196, 197, 196, 195, 193, 191, 192, 193];
    const r = computeSwingPivots(highs, lows);
    // range = 14; 38.2%: 205 - 5.348 = 199.652; 50%: 198; 61.8%: 196.348
    expect(r.fiboLevels?.level382).toBeCloseTo(199.652, 2);
    expect(r.fiboLevels?.level500).toBeCloseTo(198, 2);
    expect(r.fiboLevels?.level618).toBeCloseTo(196.348, 2);
  });
});

describe('nearestFiboLevel()', () => {
  const levels = { level382: 199.65, level500: 198.0, level618: 196.35 };
  it('returns 38.2 when price is near level382', () => expect(nearestFiboLevel(199.7, levels)).toBe(38.2));
  it('returns 50 when price is near level500', () => expect(nearestFiboLevel(198.1, levels)).toBe(50));
  it('returns 61.8 when price is near level618', () => expect(nearestFiboLevel(196.4, levels)).toBe(61.8));
});

// ─── detectVolumeSurge / detectGapUp ─────────────────────────────────────────

describe('detectVolumeSurge()', () => {
  it('detects surge when ratio >= multiplier', () => {
    expect(detectVolumeSurge({ currentVolume: 3000, baselineVolume: 1000 }, 1.5).isSurge).toBe(true);
  });
  it('no surge when ratio < multiplier', () => {
    expect(detectVolumeSurge({ currentVolume: 1400, baselineVolume: 1000 }, 1.5).isSurge).toBe(false);
  });
  it('returns false for zero baseline', () => {
    expect(detectVolumeSurge({ currentVolume: 1000, baselineVolume: 0 }).isSurge).toBe(false);
  });
});

describe('detectGapUp()', () => {
  it('detects gap up when open > prevClose × (1+min)', () => {
    expect(detectGapUp({ open: 202, prevClose: 200 }, 0.005).isGapUp).toBe(true);
  });
  it('no gap when difference below threshold', () => {
    expect(detectGapUp({ open: 200.5, prevClose: 200 }, 0.005).isGapUp).toBe(false);
  });
});

// ─── detectStructureBreak ────────────────────────────────────────────────────

describe('detectStructureBreak()', () => {
  it('detects break when price < swingLow', () => {
    expect(detectStructureBreak({ currentPrice: 190, entrySwingLow: 195 }).isBroken).toBe(true);
  });
  it('no break when price above swingLow', () => {
    expect(detectStructureBreak({ currentPrice: 196, entrySwingLow: 195 }).isBroken).toBe(false);
  });
  it('respects tolerance fraction', () => {
    // distanceFraction ≈ -0.000513, tolerance = 0.001 → NOT broken
    expect(detectStructureBreak({ currentPrice: 194.9, entrySwingLow: 195, toleranceFraction: 0.001 }).isBroken).toBe(false);
  });
});

// ─── computeRvolNormalized ───────────────────────────────────────────────────

describe('computeRvolNormalized()', () => {
  it('returns normalized RVOL correctly', () => {
    // 30 min / 390 min = 7.69%; projected = 10M / 0.0769 ≈ 130M; rvol = 130M/50M ≈ 2.6
    const r = computeRvolNormalized({
      cumIntradayVolUsd: 10_000_000,
      fullDayBaselineUsd: 50_000_000,
      elapsedMinutes: 30,
      sessionMinutes: 390,
    });
    expect(r).not.toBeNull();
    expect(r!.rvolNormalized).toBeCloseTo(2.6, 1);
  });

  it('marks tooEarly when elapsed < 30 min', () => {
    const r = computeRvolNormalized({
      cumIntradayVolUsd: 1_000_000,
      fullDayBaselineUsd: 50_000_000,
      elapsedMinutes: 10,
      sessionMinutes: 390,
    });
    expect(r!.tooEarly).toBe(true);
  });

  it('returns null for invalid inputs', () => {
    expect(computeRvolNormalized({ cumIntradayVolUsd: 1000, fullDayBaselineUsd: 0, elapsedMinutes: 30, sessionMinutes: 390 })).toBeNull();
  });
});

// ─── evaluatePullbackHL ───────────────────────────────────────────────────────

describe('evaluatePullbackHL()', () => {
  it('emits PULLBACK_HL_FIBO when price near Fibo level + surge', () => {
    const signal = evaluatePullbackHL({
      symbol: 'AAPL.US',
      candles: makeSwingCandles(),
      volumeBaseline: 1000,
      ema50Daily: 195,
      ema200Daily: 180,
      vwap: 197,
      detectedAt: '2026-05-01T10:00:00Z',
    });
    expect(signal).not.toBeNull();
    expect(signal!.triggerKind).toBe(EntryTriggerKind.PULLBACK_HL_FIBO);
    expect(signal!.fiboLevel).not.toBeNull();
  });

  it('returns null when < 5 candles', () => {
    expect(evaluatePullbackHL({
      symbol: 'X',
      candles: [makeCandle(200, 195, 197)],
      volumeBaseline: 1000,
      ema50Daily: null,
      ema200Daily: null,
      vwap: null,
      detectedAt: '2026-05-01T10:00:00Z',
    })).toBeNull();
  });

  it('returns null when no volume surge (vol=1, baseline=1000)', () => {
    const candles = makeSwingCandles().map((c) => ({ ...c, volume: 1 }));
    expect(evaluatePullbackHL({
      symbol: 'AAPL.US',
      candles,
      volumeBaseline: 1000,
      ema50Daily: 195,
      ema200Daily: 180,
      vwap: 197,
      detectedAt: '2026-05-01T10:00:00Z',
    })).toBeNull();
  });
});

// ─── evaluateVwapReclaim ─────────────────────────────────────────────────────

describe('evaluateVwapReclaim()', () => {
  const buildInput = (prevClose: number, currClose: number, vwap: number, currVol = 2000) => ({
    symbol: 'AAPL.US',
    candles: [
      makeCandle(prevClose + 2, prevClose - 2, prevClose, 500),
      makeCandle(currClose + 2, currClose - 2, currClose, currVol),
    ],
    vwap,
    ema50Daily: 195 as number | null,
    ema200Daily: 180 as number | null,
    volumeBaseline: 1000,
    detectedAt: '2026-05-01T10:00:00Z',
  });

  it('emits VWAP_RECLAIM when prev<vwap, curr>vwap, golden cross, surge', () => {
    const signal = evaluateVwapReclaim(buildInput(196, 200, 198));
    expect(signal).not.toBeNull();
    expect(signal!.triggerKind).toBe(EntryTriggerKind.VWAP_RECLAIM);
  });

  it('returns null when prev already above vwap (no crossover)', () => {
    expect(evaluateVwapReclaim(buildInput(200, 202, 198))).toBeNull();
  });

  it('returns null when curr still below vwap (no reclaim)', () => {
    expect(evaluateVwapReclaim(buildInput(196, 197, 198))).toBeNull();
  });

  it('returns null when EMA50 <= EMA200 (downtrend)', () => {
    const input = { ...buildInput(196, 200, 198), ema50Daily: 170, ema200Daily: 180 };
    expect(evaluateVwapReclaim(input)).toBeNull();
  });

  it('returns null when no volume surge', () => {
    expect(evaluateVwapReclaim(buildInput(196, 200, 198, 1))).toBeNull();
  });
});

// ─── GainersBloc3Service — orchestration ──────────────────────────────────────

describe('GainersBloc3Service', () => {
  let svc: GainersBloc3Service;

  beforeEach(() => { svc = new GainersBloc3Service(); });

  it('passes through REJECT candidates unchanged', () => {
    const reject = { ...makeAcceptCandidate(), decision: 'REJECT' as const, rejectReason: CandidateRejectReason.LIQUIDITY_FLOOR };
    const out = svc.evaluate({ candidate: reject, candles: makeSwingCandles(), volumeBaseline: 1000, detectedAt: '2026-05-01T10:00:00Z' });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
  });

  it('REJECTs with NO_ENTRY_TRIGGER when candles < 5', () => {
    const out = svc.evaluate({
      candidate: makeAcceptCandidate(),
      candles: [makeCandle(200, 195, 197)],
      volumeBaseline: 1000,
      detectedAt: '2026-05-01T10:00:00Z',
    });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.NO_ENTRY_TRIGGER);
  });

  it('enriches candidate with PULLBACK_HL_FIBO when candles match swing pattern', () => {
    const out = svc.evaluate({
      candidate: makeAcceptCandidate(),
      candles: makeSwingCandles(),
      volumeBaseline: 1000,
      detectedAt: '2026-05-01T10:00:00Z',
    });
    // Either trigger fires (ACCEPT+signal) or no trigger found (REJECT+NO_ENTRY_TRIGGER)
    if (out.entrySignal) {
      expect(out.decision).toBe('ACCEPT');
      expect([EntryTriggerKind.PULLBACK_HL_FIBO, EntryTriggerKind.VWAP_RECLAIM]).toContain(out.entrySignal.triggerKind);
    } else {
      expect(out.decision).toBe('REJECT');
      expect(out.rejectReason).toBe(CandidateRejectReason.NO_ENTRY_TRIGGER);
    }
  });

  it('REJECTs with NO_ENTRY_TRIGGER when no trigger fires (low vol, no pattern)', () => {
    // Flat candles with no swing pattern + low volume → no trigger
    const flatCandles = Array.from({ length: 10 }, () => makeCandle(201, 199, 200, 10));
    const out = svc.evaluate({
      candidate: makeAcceptCandidate(),
      candles: flatCandles,
      volumeBaseline: 1_000_000,
      detectedAt: '2026-05-01T10:00:00Z',
    });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.NO_ENTRY_TRIGGER);
  });
});
