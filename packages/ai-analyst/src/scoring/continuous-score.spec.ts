/**
 * PR #351 — Tests scoring discriminant continu.
 *
 * Couverture :
 *   - 5 sous-scores (amplitude, rvol, momentum, persistence, capQuality)
 *   - Smoking gun 020560.KO (rvol=24.16 + chg=16.94, ignoré 477 fois en prod)
 *   - FOMO penalty us_sm (rvol >3.5 → décroissance, >8.5 → 0)
 *   - Bornes [0..100] et fallback (mcap null, momentum all-null)
 */

import {
  calculateContinuousScore,
  computeAmplitudeScore,
  computeRvolScore,
  computeMomentumScore,
  computePersistenceSubScore,
  computeCapQualityScore,
} from './continuous-score';

describe('PR #351 continuous-score', () => {
  describe('computeAmplitudeScore', () => {
    it('asia chg=10% → ~0.5 (centre sigmoid)', () => {
      expect(computeAmplitudeScore(10, 'asia_equity')).toBeCloseTo(0.5, 2);
    });
    it('asia chg=20% → > 0.9', () => {
      expect(computeAmplitudeScore(20, 'asia_equity')).toBeGreaterThan(0.9);
    });
    it('asia chg=0% → < 0.1', () => {
      expect(computeAmplitudeScore(0, 'asia_equity')).toBeLessThan(0.1);
    });
    it('crypto chg=3% → ~0.5', () => {
      expect(computeAmplitudeScore(3, 'crypto_major')).toBeCloseTo(0.5, 2);
    });
    it('us_large chg=7% → ~0.5', () => {
      expect(computeAmplitudeScore(7, 'us_equity_large')).toBeCloseTo(0.5, 2);
    });
  });

  describe('computeRvolScore', () => {
    it('asia rvol=5 → 1.0 (target)', () => {
      expect(computeRvolScore(5, 'asia_equity')).toBe(1.0);
    });
    it('asia rvol=2.5 → 0.5', () => {
      expect(computeRvolScore(2.5, 'asia_equity')).toBeCloseTo(0.5, 2);
    });
    it('asia rvol=24.16 (smoking gun) → 1.0 (saturé)', () => {
      expect(computeRvolScore(24.16, 'asia_equity')).toBe(1.0);
    });
    it('us_sm rvol=3 → 1.0 (modéré préféré)', () => {
      expect(computeRvolScore(3, 'us_equity_small_mid')).toBe(1.0);
    });
    it('us_sm rvol=5 → décroissance ~0.7 (FOMO penalty)', () => {
      const score = computeRvolScore(5, 'us_equity_small_mid');
      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThan(0.8);
    });
    it('us_sm rvol=10 → 0 (FOMO max)', () => {
      expect(computeRvolScore(10, 'us_equity_small_mid')).toBe(0);
    });
    it('rvol=0 ou négatif → 0', () => {
      expect(computeRvolScore(0, 'asia_equity')).toBe(0);
      expect(computeRvolScore(-1, 'crypto_major')).toBe(0);
    });
  });

  describe('computeMomentumScore', () => {
    it('momentum 5m=2%, 15m=5%, 30m=8% → 1.0 (max)', () => {
      expect(computeMomentumScore(0.02, 0.05, 0.08)).toBe(1.0);
    });
    it('momentum tout négatif → 0', () => {
      expect(computeMomentumScore(-0.02, -0.05, -0.08)).toBe(0);
    });
    it('momentum 5m=1% seul, autres null → > 0.5 (positif partiel)', () => {
      const score = computeMomentumScore(0.01, null, null);
      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThan(1);
    });
    it('tous null → 0.5 (neutre)', () => {
      expect(computeMomentumScore(null, null, null)).toBe(0.5);
    });
  });

  describe('computePersistenceSubScore', () => {
    it('passe direct le ratio existant clampé [0, 1]', () => {
      expect(computePersistenceSubScore(0.677)).toBe(0.677);
      expect(computePersistenceSubScore(1.2)).toBe(1);
      expect(computePersistenceSubScore(-0.1)).toBe(0);
    });
  });

  describe('computeCapQualityScore', () => {
    it('us_large mcap=500B → 1.0 (sweet spot)', () => {
      expect(computeCapQualityScore(500e9, 'us_equity_large')).toBe(1.0);
    });
    it('us_large mcap=100B → 0.5 (trop petit)', () => {
      expect(computeCapQualityScore(100e9, 'us_equity_large')).toBe(0.5);
    });
    it('us_large mcap=3000B → 0.7 (mega cap)', () => {
      expect(computeCapQualityScore(3000e9, 'us_equity_large')).toBe(0.7);
    });
    it('us_sm mcap=3.54B (TP avg mesuré) → 1.0', () => {
      expect(computeCapQualityScore(3.54e9, 'us_equity_small_mid')).toBe(1.0);
    });
    it('us_sm mcap=0.1B → 0.2 (penny FOMO)', () => {
      expect(computeCapQualityScore(0.1e9, 'us_equity_small_mid')).toBe(0.2);
    });
    it('us_sm mcap=50B → 0.5 (dérive large)', () => {
      expect(computeCapQualityScore(50e9, 'us_equity_small_mid')).toBe(0.5);
    });
    it('mcap null → 0.5 (fallback neutre)', () => {
      expect(computeCapQualityScore(null, 'us_equity_large')).toBe(0.5);
    });
    it('asia/eu/crypto → 0.7 (neutre)', () => {
      expect(computeCapQualityScore(10e9, 'asia_equity')).toBe(0.7);
      expect(computeCapQualityScore(10e9, 'eu_equity')).toBe(0.7);
      expect(computeCapQualityScore(10e9, 'crypto_major')).toBe(0.7);
    });
  });

  describe('calculateContinuousScore — smoking gun 020560.KO', () => {
    it('020560.KO (asia, chg=16.94%, rvol=24.16) DOIT scorer ≥ 65', () => {
      const result = calculateContinuousScore({
        changePctSnapshot: 16.94,
        rvol: 24.16,
        marketCapUsd: 5e9,
        persistenceMultiTf: 0.5,
        momentum5m: 0.01,
        momentum15m: 0.02,
        momentum30m: 0.05,
        atrNormalized: null,
      }, 'asia_equity');
      expect(result.total).toBeGreaterThanOrEqual(65);
      expect(result.subScores.rvolScore).toBe(1.0);
      expect(result.subScores.amplitudeScore).toBeGreaterThan(0.85);
    });

    it('signal faible (chg=2%, rvol=1.2) DOIT scorer < 40', () => {
      const result = calculateContinuousScore({
        changePctSnapshot: 2,
        rvol: 1.2,
        marketCapUsd: 1e9,
        persistenceMultiTf: 0.3,
        momentum5m: 0,
        momentum15m: 0,
        momentum30m: 0,
        atrNormalized: null,
      }, 'asia_equity');
      expect(result.total).toBeLessThan(40);
    });

    it('us_sm avec rvol=24 (FOMO) DOIT scorer < 50 malgré chg élevé', () => {
      const result = calculateContinuousScore({
        changePctSnapshot: 16,
        rvol: 24,
        marketCapUsd: 0.2e9,
        persistenceMultiTf: 0.7,
        momentum5m: 0.02,
        momentum15m: 0.04,
        momentum30m: 0.06,
        atrNormalized: null,
      }, 'us_equity_small_mid');
      expect(result.total).toBeLessThan(50);
      expect(result.subScores.rvolScore).toBe(0); // FOMO max
      expect(result.subScores.capQualityScore).toBe(0.2); // penny
    });
  });

  describe('calculateContinuousScore — bornes', () => {
    it('cas max théorique → > 90', () => {
      const result = calculateContinuousScore({
        changePctSnapshot: 100,
        rvol: 10,
        marketCapUsd: 500e9,
        persistenceMultiTf: 1,
        momentum5m: 0.05,
        momentum15m: 0.10,
        momentum30m: 0.15,
        atrNormalized: null,
      }, 'us_equity_large');
      expect(result.total).toBeGreaterThan(90);
      expect(result.total).toBeLessThanOrEqual(100);
    });

    it('cas min → < 10 (toutes features nulles ou négatives)', () => {
      const result = calculateContinuousScore({
        changePctSnapshot: -10,
        rvol: 0,
        marketCapUsd: 0,
        persistenceMultiTf: 0,
        momentum5m: -0.05,
        momentum15m: -0.10,
        momentum30m: -0.15,
        atrNormalized: null,
      }, 'crypto_major');
      expect(result.total).toBeLessThan(10);
    });
  });
});
