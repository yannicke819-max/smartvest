/**
 * Tests Momentum Analyzer — Phase 2 du refactor scanner.
 * Vérifie que les métriques distinguent rising / stalled / reversing.
 */

import { computeMomentumMetrics, classifyBucket, type Candle } from '../momentum-analyzer.helper';

/** Helper : génère une candle synthétique. */
function candle(ts: number, close: number, volume = 1000, range = 0.5): Candle {
  return {
    timestamp: ts,
    open: close - range / 2,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume,
  };
}

describe('Momentum Analyzer', () => {
  describe('computeMomentumMetrics', () => {
    it('returns NEUTRAL on empty input', () => {
      const m = computeMomentumMetrics([]);
      expect(m.sampleSize).toBe(0);
      expect(m.risingScore).toBe(0.5);
    });

    it('returns NEUTRAL on insufficient candles (<3)', () => {
      const m = computeMomentumMetrics([candle(0, 100), candle(60, 101)]);
      expect(m.sampleSize).toBe(0);
    });

    it('rising trend (close monotone increasing): gradient positif, risingScore > 0.6', () => {
      const candles = [
        candle(0, 100, 1000),
        candle(60, 101, 1100),
        candle(120, 102, 1200),
        candle(180, 103, 1300),
        candle(240, 104, 1400),
        candle(300, 105, 1500),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.gradientPctPerMin).toBeGreaterThan(0);
      expect(m.risingScore).toBeGreaterThan(0.55);
    });

    it('falling trend: gradient négatif, risingScore < 0.4', () => {
      const candles = [
        candle(0, 105),
        candle(60, 104),
        candle(120, 103),
        candle(180, 102),
        candle(240, 101),
        candle(300, 100),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.gradientPctPerMin).toBeLessThan(0);
      expect(m.risingScore).toBeLessThan(0.45);
    });

    it('flat / stalled: gradient ≈ 0, risingScore proche de 0.5', () => {
      const candles = [
        candle(0, 100),
        candle(60, 100.1),
        candle(120, 99.9),
        candle(180, 100),
        candle(240, 100.05),
        candle(300, 100),
      ];
      const m = computeMomentumMetrics(candles);
      expect(Math.abs(m.gradientPctPerMin)).toBeLessThan(0.05);
      expect(m.risingScore).toBeGreaterThan(0.4);
      expect(m.risingScore).toBeLessThan(0.7);
    });

    it('accelerating (slow start, fast end): acceleration positive', () => {
      const candles = [
        candle(0, 100),
        candle(60, 100.1),
        candle(120, 100.2),
        candle(180, 101),
        candle(240, 102),
        candle(300, 103.5),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.acceleration).toBeGreaterThan(0);
    });

    it('decelerating (fast start, slow end): acceleration négative', () => {
      const candles = [
        candle(0, 100),
        candle(60, 101.5),
        candle(120, 102.5),
        candle(180, 103),
        candle(240, 103.1),
        candle(300, 103.2),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.acceleration).toBeLessThan(0);
    });

    it('volume surge: volumeMomentum > 1', () => {
      const candles = [
        candle(0, 100, 1000),
        candle(60, 101, 1000),
        candle(120, 102, 1100),
        candle(180, 103, 2000),
        candle(240, 104, 3000),
        candle(300, 105, 4000),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.volumeMomentum).toBeGreaterThan(1.5);
    });

    it('handles unsorted input (sorts by timestamp)', () => {
      const candles = [
        candle(300, 105),
        candle(0, 100),
        candle(180, 103),
        candle(60, 101),
        candle(240, 104),
        candle(120, 102),
      ];
      const m = computeMomentumMetrics(candles);
      expect(m.gradientPctPerMin).toBeGreaterThan(0);
      expect(m.sampleSize).toBe(6);
    });

    it('handles zero/null first close safely', () => {
      const candles = [
        candle(0, 0),
        candle(60, 100),
        candle(120, 101),
      ];
      const m = computeMomentumMetrics(candles);
      expect(Number.isFinite(m.gradientPctPerMin)).toBe(true);
    });
  });

  describe('classifyBucket', () => {
    const baseRising = { gradientPctPerMin: 0.05, acceleration: 0.02, volumeMomentum: 1.2, verticalityScore: 0.3, risingScore: 0.7, sampleSize: 6 };
    const baseReversing = { gradientPctPerMin: -0.15, acceleration: -0.05, volumeMomentum: 0.8, verticalityScore: 0.5, risingScore: 0.3, sampleSize: 6 };

    it('sweet_spot_rising : changePct ∈ [3,12] + risingScore > 0.55', () => {
      expect(classifyBucket(5, 0.9, baseRising)).toBe('sweet_spot_rising');
    });

    it('peak_parabolic : changePct > 12 + closeToHigh > 0.95', () => {
      expect(classifyBucket(20, 0.99, baseRising)).toBe('peak_parabolic');
    });

    it('early_mover : changePct ∈ [0.5,3] + accel positive', () => {
      expect(classifyBucket(1.5, 0.9, baseRising)).toBe('early_mover');
    });

    it('reversing : gradient < -0.1 quelle que soit changePct', () => {
      expect(classifyBucket(5, 0.9, baseReversing)).toBe('reversing');
    });

    it('stalled : tout le reste (sweet-spot mais momentum faible)', () => {
      const stalled = { ...baseRising, risingScore: 0.5, gradientPctPerMin: 0.01 };
      expect(classifyBucket(5, 0.9, stalled)).toBe('stalled');
    });
  });
});
