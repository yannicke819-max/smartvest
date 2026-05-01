/**
 * BLOC 1 — Scoring + prefilter gates + trend filter + composite scorer.
 * Couvre les 4 seuils V1 officiels (ADR-005 §1bis).
 */

import {
  CandidateRejectReason,
  TrendFilterKind,
} from '../domain/gainers-enums';
import type { GainersCandidateRaw } from '../domain/gainers-candidate.types';
import {
  DEFAULT_BLOC1_CONFIG,
  checkLiquidityFloor,
  checkMarketCapMin,
  checkPersistence,
  checkVolatilityClamp,
  runAllPrefilterGates,
} from '../bloc1/prefilter-gates';
import {
  DEFAULT_TREND_FILTER_CONFIG,
  evaluateTrendFilter,
} from '../bloc1/trend-filter';
import {
  DEFAULT_COMPOSITE_SCORER_CONFIG,
  computeCompositeScore,
} from '../bloc1/composite-scorer';
import { GainersBloc1Service } from '../bloc1/gainers-bloc1.service';

const baseEquity = (overrides: Partial<GainersCandidateRaw> = {}): GainersCandidateRaw => ({
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
  ...overrides,
});

const baseCrypto = (overrides: Partial<GainersCandidateRaw> = {}): GainersCandidateRaw => ({
  symbol: 'BTC-USD.CC',
  market: 'crypto',
  exchange: 'BINANCE',
  close: 60_000,
  open: 59_500,
  high: 60_200,
  low: 59_400,
  vol24hUsd: 5_000_000_000,
  medianDailyVolUsd20d: null,
  marketCapUsd: 1_200_000_000_000,
  atrDailyRelative: 0.04,
  changePct1m: 0.015,
  persistenceScore: 0.83,
  persistenceCount: '5/6',
  ema50Daily: 58_000,
  ema200Daily: 50_000,
  ...overrides,
});

describe('GainersBloc1 — prefilter gates', () => {
  describe('liquidity floor', () => {
    it('rejects equity candidate below $10M median daily vol', () => {
      const r = checkLiquidityFloor(baseEquity({ medianDailyVolUsd20d: 9_999_999 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
    });
    it('rejects crypto candidate below $50M 24h vol', () => {
      const r = checkLiquidityFloor(baseCrypto({ vol24hUsd: 49_999_999 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
    });
    it('accepts equity candidate at exactly $10M', () => {
      const r = checkLiquidityFloor(baseEquity({ medianDailyVolUsd20d: 10_000_000 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(true);
    });
    it('rejects equity candidate with null medianDailyVol baseline', () => {
      const r = checkLiquidityFloor(baseEquity({ medianDailyVolUsd20d: null }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.observed).toBeNull();
    });
  });

  describe('market cap minimum', () => {
    it('rejects equity below $300M', () => {
      const r = checkMarketCapMin(baseEquity({ marketCapUsd: 299_999_999 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.MARKET_CAP_MIN);
    });
    it('rejects crypto below $500M', () => {
      const r = checkMarketCapMin(baseCrypto({ marketCapUsd: 499_999_999 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.MARKET_CAP_MIN);
    });
    it('accepts equity at exactly $300M', () => {
      const r = checkMarketCapMin(baseEquity({ marketCapUsd: 300_000_000 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(true);
    });
    it('rejects when marketCapUsd is null', () => {
      const r = checkMarketCapMin(baseEquity({ marketCapUsd: null }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
    });
  });

  describe('volatility clamp', () => {
    it('rejects candidate with ATR(14)/close > 0.15', () => {
      const r = checkVolatilityClamp(baseEquity({ atrDailyRelative: 0.151 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.VOLATILITY_CLAMP);
    });
    it('accepts candidate with ATR(14)/close = 0.15', () => {
      const r = checkVolatilityClamp(baseEquity({ atrDailyRelative: 0.15 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(true);
    });
    it('rejects when atrDailyRelative is null', () => {
      const r = checkVolatilityClamp(baseEquity({ atrDailyRelative: null }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
    });
  });

  describe('persistence gate', () => {
    it('rejects candidate with persistenceScore below default 0.67', () => {
      const r = checkPersistence(baseEquity({ persistenceScore: 0.66 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.PERSISTENCE_BELOW_THRESHOLD);
    });
    it('accepts candidate with score >= threshold', () => {
      const r = checkPersistence(baseEquity({ persistenceScore: 0.67 }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(true);
    });
    it('rejects when persistenceScore is null', () => {
      const r = checkPersistence(baseEquity({ persistenceScore: null }), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(false);
    });
  });

  describe('runAllPrefilterGates', () => {
    it('returns first failed reason in order liquidity → mcap → vol → persistence', () => {
      const r = runAllPrefilterGates(
        baseEquity({ medianDailyVolUsd20d: 1, marketCapUsd: 1, atrDailyRelative: 0.99, persistenceScore: 0 }),
        DEFAULT_BLOC1_CONFIG,
      );
      expect(r.pass).toBe(false);
      expect(r.firstFailedReason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
    });
    it('passes a healthy candidate', () => {
      const r = runAllPrefilterGates(baseEquity(), DEFAULT_BLOC1_CONFIG);
      expect(r.pass).toBe(true);
      expect(r.firstFailedReason).toBeNull();
    });
  });
});

describe('GainersBloc1 — trend filter', () => {
  it('returns EMA_GOLDEN_CROSS pass when EMA50 > EMA200', () => {
    const r = evaluateTrendFilter(baseEquity({ ema50Daily: 100, ema200Daily: 90 }), DEFAULT_TREND_FILTER_CONFIG);
    expect(r.pass).toBe(true);
    expect(r.kind).toBe(TrendFilterKind.EMA_GOLDEN_CROSS);
  });
  it('returns TREND_FILTER_FAIL when EMA50 < EMA200', () => {
    const r = evaluateTrendFilter(baseEquity({ ema50Daily: 90, ema200Daily: 100 }), DEFAULT_TREND_FILTER_CONFIG);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe(CandidateRejectReason.TREND_FILTER_FAIL);
  });
  it('returns TREND_FILTER_FAIL when EMAs equal (strict greater required)', () => {
    const r = evaluateTrendFilter(baseEquity({ ema50Daily: 100, ema200Daily: 100 }), DEFAULT_TREND_FILTER_CONFIG);
    expect(r.pass).toBe(false);
  });
  it('rejects when either EMA is null', () => {
    const r1 = evaluateTrendFilter(baseEquity({ ema50Daily: null }), DEFAULT_TREND_FILTER_CONFIG);
    const r2 = evaluateTrendFilter(baseEquity({ ema200Daily: null }), DEFAULT_TREND_FILTER_CONFIG);
    expect(r1.pass).toBe(false);
    expect(r2.pass).toBe(false);
  });
  it('returns NONE pass when filter disabled', () => {
    const r = evaluateTrendFilter(baseEquity({ ema50Daily: 90, ema200Daily: 100 }), { enabled: false });
    expect(r.pass).toBe(true);
    expect(r.kind).toBe(TrendFilterKind.NONE);
  });
});

describe('GainersBloc1 — composite scorer', () => {
  it('returns score in [0, 1] for healthy candidate', () => {
    const s = computeCompositeScore(baseEquity(), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(0);
    expect(s!).toBeLessThanOrEqual(1);
  });
  it('returns null when persistenceScore is null', () => {
    const s = computeCompositeScore(baseEquity({ persistenceScore: null }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(s).toBeNull();
  });
  it('returns null when atrDailyRelative is null', () => {
    const s = computeCompositeScore(baseEquity({ atrDailyRelative: null }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(s).toBeNull();
  });
  it('higher persistence ⇒ higher composite score (ceteris paribus)', () => {
    const low = computeCompositeScore(baseEquity({ persistenceScore: 0.7 }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    const high = computeCompositeScore(baseEquity({ persistenceScore: 1.0 }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(high!).toBeGreaterThan(low!);
  });
  it('lower volatility ⇒ higher composite score (ceteris paribus)', () => {
    const high = computeCompositeScore(baseEquity({ atrDailyRelative: 0.01 }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    const low = computeCompositeScore(baseEquity({ atrDailyRelative: 0.14 }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(high!).toBeGreaterThan(low!);
  });
  it('clamps negative momentum to 0', () => {
    const s = computeCompositeScore(baseEquity({ changePct1m: -0.05 }), DEFAULT_COMPOSITE_SCORER_CONFIG);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(0);
  });
});

describe('GainersBloc1Service — orchestration', () => {
  const svc = new GainersBloc1Service();

  it('ACCEPT for healthy equity candidate', () => {
    const out = svc.evaluate(baseEquity());
    expect(out.decision).toBe('ACCEPT');
    expect(out.rejectReason).toBeNull();
    expect(out.compositeScore).not.toBeNull();
    expect(out.trendFilter).toBe(TrendFilterKind.EMA_GOLDEN_CROSS);
  });
  it('REJECT short-circuits on first failed gate (no compositeScore)', () => {
    const out = svc.evaluate(baseEquity({ medianDailyVolUsd20d: 1 }));
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
    expect(out.compositeScore).toBeNull();
    expect(out.trendFilter).toBeNull();
  });
  it('REJECT on trend filter fail when prefilter passes', () => {
    const out = svc.evaluate(baseEquity({ ema50Daily: 90, ema200Daily: 100 }));
    expect(out.decision).toBe('REJECT');
    expect(out.rejectReason).toBe(CandidateRejectReason.TREND_FILTER_FAIL);
    expect(out.trendFilter).toBe(TrendFilterKind.EMA_GOLDEN_CROSS);
  });
  it('evaluateBatchAccepted returns only ACCEPT sorted desc by score', () => {
    const batch = [
      baseEquity({ symbol: 'A', persistenceScore: 0.7 }),
      baseEquity({ symbol: 'B', persistenceScore: 1.0 }),
      baseEquity({ symbol: 'C', medianDailyVolUsd20d: 1 }),
    ];
    const out = svc.evaluateBatchAccepted(batch);
    expect(out.length).toBe(2);
    expect(out[0].raw.symbol).toBe('B');
    expect(out[1].raw.symbol).toBe('A');
  });
});
