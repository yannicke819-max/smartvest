/**
 * BLOC 2 — Baselines + spread proxy + universe guard.
 * Tests unitaires pour les fonctions pures et le service orchestrateur.
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
  DEFAULT_SPREAD_PROXY_CONFIG,
} from '../bloc2/spread-proxy';
import { GainersBloc2Service, Bloc2Input, DEFAULT_BLOC2_CONFIG } from '../bloc2/gainers-bloc2.service';
import { VolumeBaselineService } from '../bloc2/volume-baseline.service';
import { UniverseGuardService } from '../bloc2/universe-guard.service';

// ─── fixtures ────────────────────────────────────────────────────────────────

const makeAcceptCandidate = (overrides: Partial<GainersScoredCandidate> = {}): GainersScoredCandidate => ({
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
  spreadProxy: null,
  spreadProxySource: null,
  trendFilter: TrendFilterKind.EMA_GOLDEN_CROSS,
  rvolIntraday: null,
  ...overrides,
});

const makeCandles = (n: number, hlPct = 0.002): CandleOHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    open: 200,
    high: 200 * (1 + hlPct),
    low: 200 * (1 - hlPct),
    close: 200,
    volume: 1000 + i,
  }));

const makeZeroVolCandles = (n: number): CandleOHLCV[] =>
  Array.from({ length: n }, () => ({ open: 200, high: 201, low: 199, close: 200, volume: 0 }));

// ─── spread proxy — pure function ────────────────────────────────────────────

describe('spread proxy — computeSpreadProxy', () => {
  it('computes HL_1M_MEDIAN = median((H-L)*0.5/close) over candles with vol > 0', () => {
    const candles = makeCandles(5, 0.002);
    const r = computeSpreadProxy(candles, '1m', DEFAULT_SPREAD_PROXY_CONFIG);
    expect(r.source).toBe(SpreadProxySource.HL_1M_MEDIAN);
    expect(r.spreadFraction).toBeCloseTo(0.002, 4);
    expect(r.usableCandles).toBe(5);
  });

  it('computes HL_5M_MEDIAN when resolution is 5m', () => {
    const candles = makeCandles(5, 0.0015);
    const r = computeSpreadProxy(candles, '5m', DEFAULT_SPREAD_PROXY_CONFIG);
    expect(r.source).toBe(SpreadProxySource.HL_5M_MEDIAN);
  });

  it('falls back to STATIC_CAP_FALLBACK when < 3 candles have vol > 0', () => {
    const candles = [...makeZeroVolCandles(4), ...makeCandles(2, 0.001)];
    const r = computeSpreadProxy(candles, '1m', DEFAULT_SPREAD_PROXY_CONFIG);
    expect(r.source).toBe(SpreadProxySource.STATIC_CAP_FALLBACK);
    expect(r.spreadFraction).toBe(DEFAULT_SPREAD_PROXY_CONFIG.spreadCapFraction);
  });

  it('returns raw median (not capped) — gate comparison is caller responsibility', () => {
    const candles = makeCandles(5, 0.05);
    const r = computeSpreadProxy(candles, '1m', DEFAULT_SPREAD_PROXY_CONFIG);
    // HL=5% → half-spread ≈ 5% → well above the 0.30% cap → isSpreadTooWide should fire
    expect(r.spreadFraction).toBeGreaterThan(DEFAULT_SPREAD_PROXY_CONFIG.spreadCapFraction);
  });

  it('excludes zero-volume candles from median', () => {
    const candles = [
      ...makeZeroVolCandles(2),
      ...makeCandles(3, 0.001),
    ];
    const r = computeSpreadProxy(candles, '1m', DEFAULT_SPREAD_PROXY_CONFIG);
    expect(r.usableCandles).toBe(3);
  });
});

describe('spread proxy — isSpreadTooWide', () => {
  it('returns true when spread > cap', () => {
    const r = { spreadFraction: 0.0035, source: SpreadProxySource.HL_1M_MEDIAN, usableCandles: 5 };
    expect(isSpreadTooWide(r, 0.003)).toBe(true);
  });
  it('returns false when spread <= cap', () => {
    const r = { spreadFraction: 0.003, source: SpreadProxySource.HL_1M_MEDIAN, usableCandles: 5 };
    expect(isSpreadTooWide(r, 0.003)).toBe(false);
  });
});

// ─── VolumeBaselineService — unit ────────────────────────────────────────────

describe('VolumeBaselineService', () => {
  const mockSupabase = { getClient: () => null } as any;
  let svc: VolumeBaselineService;

  beforeEach(() => {
    svc = new VolumeBaselineService(mockSupabase);
    // Inject cache directly for unit tests (no DB)
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
    const rvol = svc.computeRvol('AAPL.US', 'US', 50_000_000);
    expect(rvol).toBeCloseTo(2.0, 2);
  });

  it('returns null RVOL when baseline is null', () => {
    expect(svc.computeRvol('UNKNOWN.US', 'US', 50_000_000)).toBeNull();
  });
});

// ─── UniverseGuardService — unit ─────────────────────────────────────────────

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
    const h1 = svc.computeHash(['AAPL.US', 'MSFT.US']);
    const h2 = svc.computeHash(['AAPL.US', 'NVDA.US']);
    expect(h1).not.toBe(h2);
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

  it('passes through REJECT candidates unchanged', () => {
    const reject = makeAcceptCandidate({ decision: 'REJECT', rejectReason: CandidateRejectReason.LIQUIDITY_FLOOR });
    const out = svc.enrich({ candidate: reject, candles1m: null, candles5m: null, intradayVolUsd: null });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
  });

  it('enriches ACCEPT candidate with spread proxy from 1m candles', () => {
    const candles = makeCandles(5, 0.001);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: candles, candles5m: null, intradayVolUsd: null });
    expect(out.decision).toBe('ACCEPT');
    expect(out.spreadProxy).not.toBeNull();
    expect(out.spreadProxySource).toBe(SpreadProxySource.HL_1M_MEDIAN);
  });

  it('falls back to 5m candles when 1m not available', () => {
    const candles5m = makeCandles(5, 0.001);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: null, candles5m: candles5m, intradayVolUsd: null });
    expect(out.spreadProxySource).toBe(SpreadProxySource.HL_5M_MEDIAN);
  });

  it('REJECTs candidate with spread > 0.30% (default cap)', () => {
    // makeCandles with 5% HL produces spread ~5%, well above 0.30% cap
    const wideCandles = makeCandles(5, 0.05);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: wideCandles, candles5m: null, intradayVolUsd: null });
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.SPREAD_TOO_WIDE);
  });

  it('enriches RVOL when intradayVol available', () => {
    const candles = makeCandles(5, 0.001);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: candles, candles5m: null, intradayVolUsd: 50_000_000 });
    expect(out.rvolIntraday).toBe(2.0);
  });

  it('REJECTs on RVOL_INSUFFICIENT when rvolEnabled and RVOL < threshold', () => {
    (mockBaseline.computeRvol as jest.Mock).mockReturnValue(0.5);
    const cfg = { ...DEFAULT_BLOC2_CONFIG, rvolEnabled: true, rvolMinThreshold: 1.5 };
    const candles = makeCandles(5, 0.001);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: candles, candles5m: null, intradayVolUsd: 5_000_000 }, cfg);
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.RVOL_INSUFFICIENT);
  });

  it('does NOT reject on RVOL when rvolEnabled=false (default)', () => {
    (mockBaseline.computeRvol as jest.Mock).mockReturnValue(0.1);
    const candles = makeCandles(5, 0.001);
    const out = svc.enrich({ candidate: makeAcceptCandidate(), candles1m: candles, candles5m: null, intradayVolUsd: 100_000 });
    expect(out.decision).toBe('ACCEPT');
  });
});
