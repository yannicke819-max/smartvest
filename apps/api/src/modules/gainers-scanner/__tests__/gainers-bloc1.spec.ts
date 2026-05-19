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
  SHADOW_TREND_FILTER_CONFIG,
  evaluateTrendFilter,
} from '../bloc1/trend-filter';
import {
  DEFAULT_COMPOSITE_SCORER_CONFIG,
  LEGACY_COMPOSITE_SCORER_CONFIG,
  SHADOW_COMPOSITE_SCORER_CONFIG,
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

    // PR6.6.4 — Bypass top 5 crypto majors
    describe('PR6.6.4 — TOP5_CRYPTO_BYPASS_LIQUIDITY (TEMPORAIRE jusqu\'au 17/05/2026)', () => {
      it('PASS BTCUSDT même si vol24hUsd < 50M floor', () => {
        const r = checkLiquidityFloor(
          baseCrypto({ symbol: 'BTCUSDT', vol24hUsd: 1_000_000 }),
          DEFAULT_BLOC1_CONFIG,
        );
        expect(r.pass).toBe(true);
      });
      it('PASS BNBUSDT même si vol24hUsd = 36M (cas weekend réel)', () => {
        const r = checkLiquidityFloor(
          baseCrypto({ symbol: 'BNBUSDT', vol24hUsd: 36_000_000 }),
          DEFAULT_BLOC1_CONFIG,
        );
        expect(r.pass).toBe(true);
      });
      it('NOT bypass DOGEUSDT (pas dans top 5) → fail si vol < 50M', () => {
        const r = checkLiquidityFloor(
          baseCrypto({ symbol: 'DOGEUSDT', vol24hUsd: 30_000_000 }),
          DEFAULT_BLOC1_CONFIG,
        );
        expect(r.pass).toBe(false);
        expect(r.reason).toBe(CandidateRejectReason.LIQUIDITY_FLOOR);
      });
      it('NOT bypass ADAUSDT (pas dans top 5) → fail si vol < 50M', () => {
        const r = checkLiquidityFloor(
          baseCrypto({ symbol: 'ADAUSDT', vol24hUsd: 10_000_000 }),
          DEFAULT_BLOC1_CONFIG,
        );
        expect(r.pass).toBe(false);
      });
      it('NOT bypass equity ticker (bypass crypto only)', () => {
        const r = checkLiquidityFloor(
          baseEquity({ symbol: 'BTCUSDT', medianDailyVolUsd20d: 5_000_000 }),
          DEFAULT_BLOC1_CONFIG,
        );
        expect(r.pass).toBe(false); // equity branch, pas concerné par bypass
      });
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

  // PR6.6.5 — Shadow tolérance EMA null
  describe('PR6.6.5 — shadowSkipNullFields', () => {
    it('Cas 1 : EMAs présents, shadowSkipNullFields=false → strict identique', () => {
      const r = evaluateTrendFilter(
        baseEquity({ ema50Daily: 100, ema200Daily: 90 }),
        DEFAULT_TREND_FILTER_CONFIG,
      );
      expect(r.pass).toBe(true);
      expect(r.kind).toBe(TrendFilterKind.EMA_GOLDEN_CROSS);
    });

    it('Cas 1bis : EMAs présents bear (50<200), shadowSkipNullFields=true → REJECT (skip seulement null)', () => {
      const r = evaluateTrendFilter(
        baseEquity({ ema50Daily: 90, ema200Daily: 100 }),
        SHADOW_TREND_FILTER_CONFIG,
      );
      expect(r.pass).toBe(false);
      expect(r.reason).toBe(CandidateRejectReason.TREND_FILTER_FAIL);
    });

    it('Cas 2 : EMAs null, shadowSkipNullFields=false → REJECT TREND_FILTER_FAIL (prod strict)', () => {
      const r1 = evaluateTrendFilter(baseEquity({ ema50Daily: null }), DEFAULT_TREND_FILTER_CONFIG);
      const r2 = evaluateTrendFilter(baseEquity({ ema200Daily: null }), DEFAULT_TREND_FILTER_CONFIG);
      const r3 = evaluateTrendFilter(
        baseEquity({ ema50Daily: null, ema200Daily: null }),
        DEFAULT_TREND_FILTER_CONFIG,
      );
      expect(r1.pass).toBe(false);
      expect(r1.reason).toBe(CandidateRejectReason.TREND_FILTER_FAIL);
      expect(r2.pass).toBe(false);
      expect(r3.pass).toBe(false);
    });

    it('Cas 3 : EMAs null, shadowSkipNullFields=true → PASS kind=NONE', () => {
      const r1 = evaluateTrendFilter(
        baseEquity({ ema50Daily: null }),
        SHADOW_TREND_FILTER_CONFIG,
      );
      const r2 = evaluateTrendFilter(
        baseEquity({ ema200Daily: null }),
        SHADOW_TREND_FILTER_CONFIG,
      );
      const r3 = evaluateTrendFilter(
        baseEquity({ ema50Daily: null, ema200Daily: null }),
        SHADOW_TREND_FILTER_CONFIG,
      );
      expect(r1.pass).toBe(true);
      expect(r1.kind).toBe(TrendFilterKind.NONE);
      expect(r1.reason).toBeNull();
      expect(r2.pass).toBe(true);
      expect(r2.kind).toBe(TrendFilterKind.NONE);
      expect(r3.pass).toBe(true);
      expect(r3.kind).toBe(TrendFilterKind.NONE);
    });

    it('Régression prod : DEFAULT_TREND_FILTER_CONFIG.shadowSkipNullFields = false', () => {
      expect(DEFAULT_TREND_FILTER_CONFIG.shadowSkipNullFields).toBe(false);
    });

    it('Shadow config : SHADOW_TREND_FILTER_CONFIG.shadowSkipNullFields = true', () => {
      expect(SHADOW_TREND_FILTER_CONFIG.shadowSkipNullFields).toBe(true);
      expect(SHADOW_TREND_FILTER_CONFIG.enabled).toBe(true);
    });
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

  // PR #362 — Recalibrage data-driven
  describe('PR #362 — recalibrage data-driven', () => {
    it('momentumNormalizationCeiling default = 0.25 (anti-saturation asia/eu)', () => {
      expect(DEFAULT_COMPOSITE_SCORER_CONFIG.momentumNormalizationCeiling).toBe(0.25);
    });

    it('LEGACY_COMPOSITE_SCORER_CONFIG conserve ceiling 0.10 (régression bit-perfect ADR-005)', () => {
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.momentumNormalizationCeiling).toBe(0.1);
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.weightPersistence).toBe(0.5);
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.weightMomentum).toBe(0.3);
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.weightVolatilityInv).toBe(0.2);
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.perClassWeights).toBeUndefined();
      expect(LEGACY_COMPOSITE_SCORER_CONFIG.perClassMomentumBoost).toBeUndefined();
    });

    it('Saturation fix : ch1m=20% sur ceiling 0.25 ne sature plus le component momentum', () => {
      // Ancien (ceiling 0.10) : 0.20/0.10=2.0 → clamp 1.0 (saturé)
      // Nouveau (ceiling 0.25) : 0.20/0.25=0.8 (non saturé)
      const rawNoClass = baseEquity({ changePct1m: 0.2, persistenceScore: 0.5, atrDailyRelative: 0.05 });
      const sNew = computeCompositeScore(rawNoClass, DEFAULT_COMPOSITE_SCORER_CONFIG);
      const sLegacy = computeCompositeScore(rawNoClass, LEGACY_COMPOSITE_SCORER_CONFIG);
      // sLegacy : 0.5*0.5 + 0.3*1.0 + 0.2*(1-0.05/0.15)=0.2*0.667=0.1333 → 0.683
      // sNew (no assetClass, poids globaux) : 0.5*0.5 + 0.3*0.8 + 0.2*0.667 = 0.25+0.24+0.1333 = 0.6233
      expect(sLegacy!).toBeCloseTo(0.683, 2);
      expect(sNew!).toBeCloseTo(0.623, 2);
    });

    it('Per-class eu_equity : poids momentum 0.55 prend le dessus sur persistence 0.25', () => {
      // eu_equity, ch1m=18% (bucket 15-25, WR mesuré 39-58%), persistance=0.5, atr=0.05
      const raw = baseEquity({
        assetClass: 'eu_equity',
        changePct1m: 0.18,
        persistenceScore: 0.5,
        atrDailyRelative: 0.05,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // momentumComp = 0.18/0.25 = 0.72
      // volInvComp = 1 - 0.05/0.15 = 0.6667
      // weighted = 0.55*0.72 + 0.25*0.5 + 0.2*0.6667 = 0.396 + 0.125 + 0.1333 = 0.6543
      // ch1m=18% >= 10% → boost ×1.25 → 0.6543 * 1.25 = 0.818 (cap 1.0)
      expect(s!).toBeCloseTo(0.818, 2);
    });

    it('Per-class us_equity_large : persistance dominante (poids 0.55)', () => {
      // us_large, ch1m=7% (sous boost ×1.15 threshold de 10%), persistance haute=0.95
      const raw = baseEquity({
        assetClass: 'us_equity_large',
        changePct1m: 0.07,
        persistenceScore: 0.95,
        atrDailyRelative: 0.04,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // momentumComp = 0.07/0.25 = 0.28
      // volInvComp = 1 - 0.04/0.15 = 0.7333
      // weighted = 0.25*0.28 + 0.55*0.95 + 0.2*0.7333 = 0.07 + 0.5225 + 0.1467 = 0.7392
      // ch1m=7% < 10% → pas de boost
      expect(s!).toBeCloseTo(0.739, 2);
    });

    it('Per-class asia_equity : boost ×1.20 si ch1m >= 15%', () => {
      const raw = baseEquity({
        assetClass: 'asia_equity',
        changePct1m: 0.16,
        persistenceScore: 0.9,
        atrDailyRelative: 0.05,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // momentumComp = 0.16/0.25 = 0.64
      // volInvComp = 1 - 0.05/0.15 = 0.6667
      // weighted = 0.4*0.64 + 0.4*0.9 + 0.2*0.6667 = 0.256+0.36+0.1333 = 0.7493
      // ch1m=16% >= 15% → boost ×1.20 → 0.7493 * 1.20 = 0.899
      expect(s!).toBeCloseTo(0.899, 2);
    });

    it('Per-class asia_equity : pas de boost si ch1m < 15%', () => {
      const raw = baseEquity({
        assetClass: 'asia_equity',
        changePct1m: 0.12,
        persistenceScore: 0.9,
        atrDailyRelative: 0.05,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // momentumComp = 0.12/0.25 = 0.48
      // weighted = 0.4*0.48 + 0.4*0.9 + 0.2*0.6667 = 0.192+0.36+0.1333 = 0.6853
      // ch1m=12% < 15% → pas de boost
      expect(s!).toBeCloseTo(0.685, 2);
    });

    it('Per-class us_equity_small_mid : pas de boost configuré (bucket inversé)', () => {
      const raw = baseEquity({
        assetClass: 'us_equity_small_mid',
        changePct1m: 0.25,
        persistenceScore: 0.8,
        atrDailyRelative: 0.05,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // momentumComp = 0.25/0.25 = 1.0
      // volInvComp = 1 - 0.05/0.15 = 0.6667
      // weighted = 0.35*1.0 + 0.45*0.8 + 0.2*0.6667 = 0.35+0.36+0.1333 = 0.8433
      // PAS de boost (us_small_mid bucket inversé)
      expect(s!).toBeCloseTo(0.843, 2);
    });

    it('Rétrocompat : assetClass absent → poids globaux fallback (0.5/0.3/0.2)', () => {
      const raw = baseEquity({
        changePct1m: 0.10,
        persistenceScore: 0.9,
        atrDailyRelative: 0.05,
      });
      // Pas d'assetClass → poids globaux. Ceiling 0.25.
      // momentumComp = 0.10/0.25 = 0.4
      // volInvComp = 1 - 0.05/0.15 = 0.6667
      // weighted = 0.5*0.9 + 0.3*0.4 + 0.2*0.6667 = 0.45+0.12+0.1333 = 0.7033
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      expect(s!).toBeCloseTo(0.703, 2);
    });

    it('Rétrocompat : crypto_major sans poids per-class défini → fallback global', () => {
      // crypto_major n'est PAS dans DEFAULT_PER_CLASS_WEIGHTS (sample insuffisant)
      const raw = baseEquity({
        assetClass: 'crypto_major',
        changePct1m: 0.05,
        persistenceScore: 0.8,
        atrDailyRelative: 0.04,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // Fallback poids globaux 0.5/0.3/0.2, ceiling 0.25
      // momentumComp = 0.05/0.25 = 0.2
      // volInvComp = 1 - 0.04/0.15 = 0.7333
      // weighted = 0.5*0.8 + 0.3*0.2 + 0.2*0.7333 = 0.4+0.06+0.1467 = 0.6067
      expect(s!).toBeCloseTo(0.607, 2);
    });

    it('Boost momentum cap à 1.0 même si multiplier le pousse au-dessus', () => {
      const raw = baseEquity({
        assetClass: 'eu_equity',
        changePct1m: 0.5,  // 50% → boost ×1.25
        persistenceScore: 1.0,
        atrDailyRelative: 0.01,
      });
      const s = computeCompositeScore(raw, DEFAULT_COMPOSITE_SCORER_CONFIG);
      // Score avant boost déjà élevé, boost cap à 1.0
      expect(s!).toBeLessThanOrEqual(1.0);
      expect(s!).toBeGreaterThanOrEqual(0.95);
    });
  });

  // PR6.6.6 — shadowAllowPartialScore : best-effort scoring with null fields
  describe('PR6.6.6 — shadowAllowPartialScore', () => {
    it('Cas 1 : tous fields présents, shadowAllowPartialScore=false → strict identique', () => {
      const s = computeCompositeScore(baseEquity(), DEFAULT_COMPOSITE_SCORER_CONFIG);
      const sShadow = computeCompositeScore(baseEquity(), SHADOW_COMPOSITE_SCORER_CONFIG);
      expect(s).toBeCloseTo(sShadow!);
    });

    it('Cas 2 : persistence null, shadowAllowPartialScore=false → null (prod strict)', () => {
      const s = computeCompositeScore(
        baseEquity({ persistenceScore: null }),
        DEFAULT_COMPOSITE_SCORER_CONFIG,
      );
      expect(s).toBeNull();
    });

    it('Cas 3 : persistence null, shadowAllowPartialScore=true → score partiel non-null', () => {
      const s = computeCompositeScore(
        baseEquity({ persistenceScore: null }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      expect(s).not.toBeNull();
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(1);
    });

    it('Cas 4 : atr null, shadowAllowPartialScore=true → score partiel non-null', () => {
      const s = computeCompositeScore(
        baseEquity({ atrDailyRelative: null }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      expect(s).not.toBeNull();
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(1);
    });

    it('Cas 5 : persistence ET atr null, shadowAllowPartialScore=true → missing-penalty (PR6.6.6.1)', () => {
      const s = computeCompositeScore(
        baseEquity({ persistenceScore: null, atrDailyRelative: null, changePct1m: 0.05 }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      expect(s).not.toBeNull();
      // PR #362 : ceiling 0.25 (ex-0.10). momentumComp = 0.05/0.25 = 0.2
      // weightedSum = 0.3 × 0.2 = 0.06 (persistence + atr absents → max 0.3)
      expect(s!).toBeCloseTo(0.06);
    });

    it('Cas 5bis : PR6.6.6.1 — changePct1m=20% + tous null → score plafonné (ceiling 0.25)', () => {
      const s = computeCompositeScore(
        baseEquity({ persistenceScore: null, atrDailyRelative: null, changePct1m: 0.20 }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      // PR #362 : ceiling 0.25. momentum = 0.20/0.25 = 0.8 (n'est plus saturé)
      // weightedSum = 0.3 × 0.8 = 0.24 (vs 0.3 historique avec ceiling 0.10)
      expect(s).toBeCloseTo(0.24);
    });

    it('Cas 6 : Régression prod default — shadowAllowPartialScore=false', () => {
      expect(DEFAULT_COMPOSITE_SCORER_CONFIG.shadowAllowPartialScore).toBe(false);
    });

    it('Cas 7 : Shadow config = true', () => {
      expect(SHADOW_COMPOSITE_SCORER_CONFIG.shadowAllowPartialScore).toBe(true);
    });

    it('Cas 8 : PR6.6.6.1 — score partiel reflète complétude (NO renormalize, ceiling 0.25)', () => {
      // baseEquity : persistence=0.83, ch1m=0.02, atr=0.03. Pas d'assetClass.
      // PR #362 ceiling 0.25 : momentumComp = 0.02/0.25 = 0.08
      // volInvComp = 1 - 0.03/0.15 = 0.8
      // Strict score (poids globaux fallback) : 0.5*0.83 + 0.3*0.08 + 0.2*0.8
      //                                       = 0.415 + 0.024 + 0.16 = 0.599
      const strict = computeCompositeScore(baseEquity(), DEFAULT_COMPOSITE_SCORER_CONFIG);

      // Shadow partiel sans persistence (missing-penalty PR6.6.6.1) :
      // weightedSum = 0.3*0.08 + 0.2*0.8 = 0.024 + 0.16 = 0.184
      const partial = computeCompositeScore(
        baseEquity({ persistenceScore: null }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      expect(strict).toBeCloseTo(0.599);
      expect(partial).toBeCloseTo(0.184);
      // Ranking préservé : strict (0.599) > partial (0.184)
      expect(strict!).toBeGreaterThan(partial!);
    });

    it('Cas 9 : PR6.6.6.1 — ranking ordering full vs partial vs minimal', () => {
      // 3 candidats avec changePct1m identique 0.05 mais features différentes
      const full = computeCompositeScore(
        baseEquity({ changePct1m: 0.05, persistenceScore: 0.8, atrDailyRelative: 0.05 }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      const partial = computeCompositeScore(
        baseEquity({ changePct1m: 0.05, persistenceScore: 0.8, atrDailyRelative: null }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      const minimal = computeCompositeScore(
        baseEquity({ changePct1m: 0.05, persistenceScore: null, atrDailyRelative: null }),
        SHADOW_COMPOSITE_SCORER_CONFIG,
      );
      // Ranking attendu : full > partial > minimal
      expect(full!).toBeGreaterThan(partial!);
      expect(partial!).toBeGreaterThan(minimal!);
    });
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
