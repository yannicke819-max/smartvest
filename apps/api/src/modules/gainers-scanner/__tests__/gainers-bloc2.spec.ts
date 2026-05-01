/**
 * BLOC 2 — Baselines + spread proxy v2 + universe guard.
 * Mis à jour PR4 : nouvelle formule (H-L)/mid, p20 vol floor, caps asset-class.
 */

import {
  CandidateRejectReason,
  SpreadProxySource,
  TrendFilterKind,
} from '../domain/gainers-enums';
import type { GainersScoredCandidate } from '../domain/gainers-candidate.types';
import {
  CandleOHLCV,
  computeSpreadProxy,
  isSpreadTooWide,
  percentile,
  DEFAULT_SPREAD_PROXY_CONFIG,
} from '../bloc2/spread-proxy';
import { GainersBloc2Service, Bloc2Input, DEFAULT_BLOC2_CONFIG } from '../bloc2/gainers-bloc2.service';
import { VolumeBaselineService } from '../bloc2/volume-baseline.service';
import { UniverseGuardService } from '../bloc2/universe-guard.service';

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeAcceptCandidate = (market: 'equity' | 'crypto' = 'equity'): GainersScoredCandidate => ({
  raw: {
    symbol: market === 'crypto' ? 'BTC-USD.CC' : 'AAPL.US',
    market,
    exchange: market === 'crypto' ? 'BINANCE' : 'US',
    close: market === 'crypto' ? 60_000 : 200,
    open: market === 'crypto' ? 59_500 : 198,
    high: market === 'crypto' ? 60_200 : 202,
    low: market === 'crypto' ? 59_400 : 197,
    vol24hUsd: market === 'crypto' ? 5_000_000_000 : 50_000_000,
    medianDailyVolUsd20d: 25_000_000,
    marketCapUsd: market === 'crypto' ? 1_200_000_000_000 : 3_000_000_000_000,
    atrDailyRelative: 0.03,
    changePct1m: 0.02,
    persistenceScore: 0.83,
    persistenceCount: '5/6',
    ema50Daily: market === 'crypto' ? 58_000 : 195,
    ema200Daily: market === 'crypto' ? 50_000 : 180,
  },
  compositeScore: 0.75,
  decision: 'ACCEPT',
  rejectReason: null,
  spreadProxy: null,
  spreadProxySource: null,
  trendFilter: TrendFilterKind.EMA_GOLDEN_CROSS,
  rvolIntraday: null,
});

/** Génère N bougies avec un spread HL pct donné (H-L)/mid = hlPct. */
const makeCandles = (n: number, hlPct = 0.002, vol = 1000): CandleOHLCV[] =>
  Array.from({ length: n }, (_, i) => {
    const mid = 200;
    const half = (mid * hlPct) / 2;
    return { open: mid, high: mid + half, low: mid - half, close: mid, volume: vol + i };
  });

const makeZeroVolCandles = (n: number): CandleOHLCV[] =>
  Array.from({ length: n }, () => ({ open: 200, high: 201, low: 199, close: 200, volume: 0 }));

// ─── Golden value tests (3 séries canoniques — synchro item #9) ──────────────

describe('spread proxy — golden values (synchro item #9)', () => {
  it('equity liquid : AAPL-like H=200.20, L=199.80 → spread ≈ 0.20% < cap 0.40%', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 200, high: 200.20, low: 199.80, close: 200, volume: 5000,
    }));
    const r = computeSpreadProxy(candles, '1h', 'equity');
    // (200.20 - 199.80) / ((200.20 + 199.80) / 2) = 0.40 / 200 = 0.002 = 0.20%
    expect(r.spreadFraction).toBeCloseTo(0.002, 4);
    expect(isSpreadTooWide(r, 'equity')).toBe(false);
  });

  it('equity mid-cap : H=50.60, L=49.40 → spread ≈ 2.4% > cap 0.40% → REJECT', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 50, high: 50.60, low: 49.40, close: 50, volume: 3000,
    }));
    const r = computeSpreadProxy(candles, '1h', 'equity');
    // (1.20) / 50 = 0.024 = 2.4%
    expect(r.spreadFraction).toBeCloseTo(0.024, 3);
    expect(isSpreadTooWide(r, 'equity')).toBe(true);
  });

  it('crypto major (BTC-like) : H=60120, L=59880 → spread ≈ 0.40% < cap 0.60%', () => {
    const candles = Array.from({ length: 20 }, () => ({
      open: 60000, high: 60120, low: 59880, close: 60000, volume: 100,
    }));
    const r = computeSpreadProxy(candles, '1h', 'crypto');
    // (240) / 60000 = 0.004 = 0.40%
    expect(r.spreadFraction).toBeCloseTo(0.004, 4);
    expect(isSpreadTooWide(r, 'crypto')).toBe(false);
  });
});

// ─── spread proxy — formula & volume floor ───────────────────────────────────

describe('spread proxy — formula (H-L)/mid', () => {
  it('formula = (H-L) / ((H+L)/2), NOT (H-L)*0.5/close', () => {
    // With H=202, L=198: mid=200, spread=4/200=0.02; old formula: 4*0.5/200=0.01
    const candles = Array.from({ length: 20 }, () => ({
      open: 200, high: 202, low: 198, close: 200, volume: 1000,
    }));
    const r = computeSpreadProxy(candles, '1h', 'equity');
    expect(r.spreadFraction).toBeCloseTo(0.02, 4); // 2%, not 1%
  });

  it('p20 volume floor filters out low-volume candles', () => {
    // 16 high-vol candles + 4 dead candles (vol=1) in recent window
    const baseCandles = Array.from({ length: 15 }, () => ({
      open: 200, high: 201, low: 199, close: 200, volume: 1000,
    }));
    const deadCandles = Array.from({ length: 5 }, () => ({
      open: 200, high: 201, low: 199, close: 200, volume: 1,
    }));
    const candles = [...baseCandles, ...deadCandles];
    const r = computeSpreadProxy(candles, '1h', 'equity');
    // Dead candles should be filtered out (vol=1 < p20 of mixed vols)
    // Result should still be based on healthy candles
    expect(r.usableCandles).toBeLessThanOrEqual(5);
  });

  it('falls back to STATIC_CAP when < 3 usable candles after p20 filter', () => {
    const candles = makeZeroVolCandles(20);
    const r = computeSpreadProxy(candles, '1h', 'equity');
    expect(r.source).toBe(SpreadProxySource.STATIC_CAP_FALLBACK);
    expect(r.spreadFraction).toBe(DEFAULT_SPREAD_PROXY_CONFIG.spreadCapEquityFraction);
  });

  it('returns 0 median for empty candles array → STATIC_CAP_FALLBACK', () => {
    const r = computeSpreadProxy([], '1h', 'equity');
    expect(r.source).toBe(SpreadProxySource.STATIC_CAP_FALLBACK);
  });

  it('uses HL_1M_MEDIAN source for 1m resolution', () => {
    const candles = makeCandles(20, 0.001);
    const r = computeSpreadProxy(candles, '1m', 'equity');
    expect(r.source).toBe(SpreadProxySource.HL_1M_MEDIAN);
  });

  it('raw spread NOT capped — gate comparison is caller responsibility', () => {
    // 5% HL spread → raw result > 0.40% cap
    const candles = makeCandles(20, 0.05);
    const r = computeSpreadProxy(candles, '1h', 'equity');
    expect(r.spreadFraction).toBeGreaterThan(DEFAULT_SPREAD_PROXY_CONFIG.spreadCapEquityFraction);
  });
});

describe('spread proxy — asset-class-aware caps', () => {
  it('equity cap = 0.40%', () => {
    const atCap = { spreadFraction: 0.004, source: SpreadProxySource.HL_1M_MEDIAN, usableCandles: 5 };
    expect(isSpreadTooWide(atCap, 'equity')).toBe(false);
    const aboveCap = { ...atCap, spreadFraction: 0.0041 };
    expect(isSpreadTooWide(aboveCap, 'equity')).toBe(true);
  });

  it('crypto cap = 0.60%', () => {
    const atCap = { spreadFraction: 0.006, source: SpreadProxySource.HL_1M_MEDIAN, usableCandles: 5 };
    expect(isSpreadTooWide(atCap, 'crypto')).toBe(false);
    const aboveCap = { ...atCap, spreadFraction: 0.0061 };
    expect(isSpreadTooWide(aboveCap, 'crypto')).toBe(true);
  });
});

// ─── percentile helper ────────────────────────────────────────────────────────

describe('percentile()', () => {
  it('p20 of [1,2,3,4,5,...,10] ≈ 2.8', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(vals, 20)).toBeCloseTo(2.8, 1);
  });
  it('returns 0 for empty array', () => {
    expect(percentile([], 20)).toBe(0);
  });
});

// ─── VolumeBaselineService ────────────────────────────────────────────────────

describe('VolumeBaselineService', () => {
  const mockSupabase = { getClient: () => null } as any;
  let svc: VolumeBaselineService;

  beforeEach(() => {
    svc = new VolumeBaselineService(mockSupabase);
    (svc as any).cache.set('AAPL.US::US', 25_000_000);
    (svc as any).cache.set('BTC-USD.CC::BINANCE', 2_000_000_000);
  });

  it('returns baseline from cache', () => {
    expect(svc.getBaseline('AAPL.US', 'US')).toBe(25_000_000);
  });
  it('returns null for unknown symbol', () => {
    expect(svc.getBaseline('UNKNOWN.US', 'US')).toBeNull();
  });
  it('computes RVOL when baseline available', () => {
    expect(svc.computeRvol('AAPL.US', 'US', 50_000_000)).toBeCloseTo(2.0, 2);
  });
  it('returns null RVOL when baseline is null', () => {
    expect(svc.computeRvol('UNKNOWN.US', 'US', 50_000_000)).toBeNull();
  });
});

// ─── UniverseGuardService ─────────────────────────────────────────────────────

describe('UniverseGuardService', () => {
  const mockSupabase = { getClient: () => null } as any;
  let svc: UniverseGuardService;

  beforeEach(() => {
    svc = new UniverseGuardService(mockSupabase);
  });

  it('computes deterministic SHA256 hash from sorted symbols', () => {
    const h1 = svc.computeHash(['AAPL.US', 'MSFT.US', 'NVDA.US']);
    const h2 = svc.computeHash(['NVDA.US', 'AAPL.US', 'MSFT.US']);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('produces different hash for different symbol sets', () => {
    expect(svc.computeHash(['AAPL.US', 'MSFT.US'])).not.toBe(svc.computeHash(['AAPL.US', 'NVDA.US']));
  });
});

// ─── GainersBloc2Service — orchestration ─────────────────────────────────────

describe('GainersBloc2Service', () => {
  let mockBaseline: VolumeBaselineService;
  let svc: GainersBloc2Service;

  beforeEach(() => {
    mockBaseline = { computeRvol: jest.fn().mockReturnValue(2.0), getBaseline: jest.fn() } as any;
    svc = new GainersBloc2Service(mockBaseline);
  });

  const makeInput = (overrides: Partial<Bloc2Input> = {}): Bloc2Input => ({
    candidate: makeAcceptCandidate('equity'),
    candles: makeCandles(20, 0.001),
    resolution: '1h',
    intradayVolUsd: null,
    ...overrides,
  });

  it('passes through REJECT candidates unchanged', () => {
    const reject = { ...makeAcceptCandidate(), decision: 'REJECT' as const, rejectReason: CandidateRejectReason.LIQUIDITY_FLOOR };
    const out = svc.enrich({ candidate: reject, candles: null, resolution: '1h', intradayVolUsd: null });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
  });

  it('enriches ACCEPT candidate with spread proxy (equity < 0.40% → ACCEPT)', () => {
    const out = svc.enrich(makeInput({ candles: makeCandles(20, 0.001) }));
    expect(out.decision).toBe('ACCEPT');
    expect(out.spreadProxy).not.toBeNull();
    expect(out.spreadProxy!).toBeLessThan(DEFAULT_BLOC2_CONFIG.spreadProxy.spreadCapEquityFraction);
  });

  it('REJECTs equity candidate with spread > 0.40% (5% HL)', () => {
    const out = svc.enrich(makeInput({ candles: makeCandles(20, 0.05) }));
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.SPREAD_TOO_WIDE);
  });

  it('REJECTs crypto candidate with spread > 0.60%', () => {
    const wideCandles = Array.from({ length: 20 }, () => ({
      open: 60000, high: 60500, low: 59500, close: 60000, volume: 1000,
    }));
    // (500+500) / 60000 = 0.0167 = 1.67% > 0.60%
    const out = svc.enrich({
      candidate: makeAcceptCandidate('crypto'),
      candles: wideCandles,
      resolution: '1h',
      intradayVolUsd: null,
    });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.SPREAD_TOO_WIDE);
  });

  it('enriches RVOL when intradayVol available', () => {
    const out = svc.enrich(makeInput({ intradayVolUsd: 50_000_000 }));
    expect(out.rvolIntraday).toBe(2.0);
  });

  it('REJECTs on RVOL_INSUFFICIENT when rvolEnabled=true and RVOL < threshold', () => {
    (mockBaseline.computeRvol as jest.Mock).mockReturnValue(0.5);
    const cfg = { ...DEFAULT_BLOC2_CONFIG, rvolEnabled: true, rvolMinThreshold: 1.5 };
    const out = svc.enrich(makeInput({ intradayVolUsd: 5_000_000 }), cfg);
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.RVOL_INSUFFICIENT);
  });

  it('does NOT reject on RVOL when rvolEnabled=false (default)', () => {
    (mockBaseline.computeRvol as jest.Mock).mockReturnValue(0.1);
    const out = svc.enrich(makeInput({ intradayVolUsd: 100_000 }));
    expect(out.decision).toBe('ACCEPT');
  });
});
