import {
  buildSignal,
  decayedConfidence,
  HALF_LIFE_PRESETS,
  isSignalFresh,
  signalAgeMs,
  signalDecayFactor,
} from '../signal-half-life';

describe('signal-half-life', () => {
  const t0 = 1_700_000_000_000;

  describe('signalDecayFactor', () => {
    it('returns 1.0 at emission time', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'SCALP_1M', { emittedAt: t0 });
      expect(signalDecayFactor(sig, t0)).toBe(1.0);
    });

    it('returns 0.75 at half of half-life', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'INTRADAY_5M', { emittedAt: t0 });
      const halfHalfLife = HALF_LIFE_PRESETS.INTRADAY_5M / 2;
      expect(signalDecayFactor(sig, t0 + halfHalfLife)).toBeCloseTo(0.75, 2);
    });

    it('returns 0.5 at exactly half-life', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'INTRADAY_5M', { emittedAt: t0 });
      expect(signalDecayFactor(sig, t0 + HALF_LIFE_PRESETS.INTRADAY_5M)).toBeCloseTo(0.5, 2);
    });

    it('returns 0.25 at 2× half-life', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'INTRADAY_5M', { emittedAt: t0 });
      expect(signalDecayFactor(sig, t0 + 2 * HALF_LIFE_PRESETS.INTRADAY_5M)).toBeCloseTo(0.25, 2);
    });

    it('returns 0 beyond hard expiry (3× half-life by default)', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'SCALP_1M', { emittedAt: t0 });
      expect(signalDecayFactor(sig, t0 + 3 * HALF_LIFE_PRESETS.SCALP_1M)).toBe(0);
      expect(signalDecayFactor(sig, t0 + 10 * HALF_LIFE_PRESETS.SCALP_1M)).toBe(0);
    });

    it('handles future emittedAt gracefully (clock skew)', () => {
      const sig = buildSignal('BUY', 'momentum', 'scanner', 'SCALP_1M', { emittedAt: t0 + 1000 });
      expect(signalDecayFactor(sig, t0)).toBe(1.0);
    });
  });

  describe('isSignalFresh', () => {
    it('uses 0.5 threshold by default', () => {
      const sig = buildSignal('BUY', 'm', 's', 'INTRADAY_5M', { emittedAt: t0 });
      expect(isSignalFresh(sig, { now: t0 + HALF_LIFE_PRESETS.INTRADAY_5M - 1 })).toBe(true);
      expect(isSignalFresh(sig, { now: t0 + HALF_LIFE_PRESETS.INTRADAY_5M * 1.5 })).toBe(false);
    });

    it('respects custom strict threshold', () => {
      const sig = buildSignal('BUY', 'm', 's', 'INTRADAY_5M', { emittedAt: t0 });
      expect(isSignalFresh(sig, { now: t0 + 1000, minDecayFactor: 0.95 })).toBe(true);
      expect(isSignalFresh(sig, { now: t0 + HALF_LIFE_PRESETS.INTRADAY_5M / 2, minDecayFactor: 0.95 })).toBe(false);
    });
  });

  describe('decayedConfidence', () => {
    it('multiplies base confidence by decay factor', () => {
      const sig = buildSignal('BUY', 'm', 's', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      expect(decayedConfidence(sig, t0)).toBeCloseTo(0.8, 2);
      expect(decayedConfidence(sig, t0 + HALF_LIFE_PRESETS.INTRADAY_5M)).toBeCloseTo(0.4, 2);
    });

    it('returns undefined when base confidence missing', () => {
      const sig = buildSignal('BUY', 'm', 's', 'INTRADAY_5M', { emittedAt: t0 });
      expect(decayedConfidence(sig, t0)).toBeUndefined();
    });

    it('makes a fresh 0.7 outrank a stale 0.9 on scalping window', () => {
      const fresh = buildSignal('BUY', 'a', 'sc1', 'SCALP_1M', { confidence: 0.7, emittedAt: t0 });
      const stale = buildSignal('BUY', 'b', 'sc2', 'SCALP_1M', { confidence: 0.9, emittedAt: t0 - 40_000 });
      const dFresh = decayedConfidence(fresh, t0)!;
      const dStale = decayedConfidence(stale, t0)!;
      expect(dFresh).toBeGreaterThan(dStale);
    });
  });

  describe('signalAgeMs', () => {
    it('returns 0 for future-emitted signal (no negative age)', () => {
      const sig = buildSignal('BUY', 'm', 's', 'SCALP_1M', { emittedAt: t0 + 5000 });
      expect(signalAgeMs(sig, t0)).toBe(0);
    });

    it('returns positive age for past-emitted signal', () => {
      const sig = buildSignal('BUY', 'm', 's', 'SCALP_1M', { emittedAt: t0 - 12_345 });
      expect(signalAgeMs(sig, t0)).toBe(12_345);
    });
  });

  describe('buildSignal', () => {
    it('wires ttlMs in context to match half-life preset', () => {
      const sig = buildSignal('BUY', 'm', 's', 'SWING_1H', { emittedAt: t0 });
      expect(sig.context.ttlMs).toBe(HALF_LIFE_PRESETS.SWING_1H);
      expect(sig.halfLifeMs).toBe(HALF_LIFE_PRESETS.SWING_1H);
    });

    it('default hardExpiry = 3 × halfLife', () => {
      const sig = buildSignal('BUY', 'm', 's', 'SCALP_1M', { emittedAt: t0 });
      expect(sig.hardExpiryMs).toBe(3 * HALF_LIFE_PRESETS.SCALP_1M);
    });

    it('respects custom hardExpiry override', () => {
      const sig = buildSignal('BUY', 'm', 's', 'SCALP_1M', { emittedAt: t0, hardExpiryMs: 200_000 });
      expect(sig.hardExpiryMs).toBe(200_000);
    });
  });
});
