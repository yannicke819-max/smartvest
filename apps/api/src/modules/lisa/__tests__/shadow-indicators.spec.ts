/**
 * PR6.4 — Tests pure functions ATR + EMA pour shadow enrichment.
 */

import {
  computeAtr,
  computeEma,
  computeDailyIndicators,
  type DailyCandle,
} from '../services/shadow-indicators.helper';

const flatCandle = (close: number): DailyCandle => ({
  high: close + 1, low: close - 1, close,
});

describe('computeAtr()', () => {
  it('returns null if candles.length < period+1', () => {
    expect(computeAtr([], 14)).toBeNull();
    expect(computeAtr(Array.from({ length: 14 }, (_, i) => flatCandle(100 + i)), 14)).toBeNull();
  });

  it('produces a numerical ATR for 15+ candles', () => {
    const candles = Array.from({ length: 15 }, (_, i) => flatCandle(100 + i));
    const atr = computeAtr(candles, 14);
    expect(atr).not.toBeNull();
    expect(atr).toBeGreaterThan(0);
  });

  it('Wilder smoothing reduces noise vs simple TR', () => {
    // 30 candles avec TR uniforme = 2 (high-low) → ATR doit converger vers 2
    const candles = Array.from({ length: 30 }, (_, i) => flatCandle(100 + i));
    const atr = computeAtr(candles, 14);
    // TR uniforme = 2 → ATR = 2 (Wilder converge vers la moyenne)
    expect(atr).toBeGreaterThan(1.5);
    expect(atr).toBeLessThan(3);
  });

  it('handles non-trivial high/low/close shape', () => {
    const candles: DailyCandle[] = [
      { high: 105, low: 95, close: 100 },
      { high: 108, low: 99, close: 106 },
      { high: 110, low: 104, close: 109 },
    ];
    // period 2 → only 2 TRs
    const atr = computeAtr(candles, 2);
    expect(atr).not.toBeNull();
    expect(atr).toBeGreaterThan(0);
  });
});

describe('computeEma()', () => {
  it('returns null if prices.length < period', () => {
    expect(computeEma([100, 101], 50)).toBeNull();
    expect(computeEma([], 1)).toBeNull();
  });

  it('returns the price itself when period=1 and 1 price', () => {
    // SMA(1) of [100] = 100
    expect(computeEma([100], 1)).toBe(100);
  });

  it('EMA on flat prices = the flat price', () => {
    const prices = Array.from({ length: 50 }, () => 100);
    expect(computeEma(prices, 50)).toBe(100);
  });

  it('EMA reacts to recent prices more than older ones', () => {
    // 50 prices à 100, puis 10 à 200 → EMA50 doit être > 100 mais < 200
    const prices = [...Array.from({ length: 50 }, () => 100), ...Array.from({ length: 10 }, () => 200)];
    const ema = computeEma(prices, 50);
    expect(ema).toBeGreaterThan(100);
    expect(ema).toBeLessThan(200);
  });

  it('EMA50 vs EMA200 on trending data : EMA50 plus rapide', () => {
    // 200 prices linéaires 1 → 200
    const prices = Array.from({ length: 200 }, (_, i) => i + 1);
    const ema50 = computeEma(prices, 50);
    const ema200 = computeEma(prices, 200);
    expect(ema50).not.toBeNull();
    expect(ema200).not.toBeNull();
    // EMA50 plus proche du prix courant (200) que EMA200
    expect(ema50!).toBeGreaterThan(ema200!);
  });
});

describe('computeDailyIndicators()', () => {
  it('returns all null on empty candles', () => {
    const r = computeDailyIndicators([]);
    expect(r.atr14).toBeNull();
    expect(r.ema50).toBeNull();
    expect(r.ema200).toBeNull();
  });

  it('returns ATR + EMA50 only when 51-199 candles (not enough for EMA200)', () => {
    const candles = Array.from({ length: 100 }, (_, i) => flatCandle(100 + i));
    const r = computeDailyIndicators(candles);
    expect(r.atr14).not.toBeNull();
    expect(r.ema50).not.toBeNull();
    expect(r.ema200).toBeNull();
  });

  it('returns all 3 indicators when 200+ candles', () => {
    const candles = Array.from({ length: 250 }, (_, i) => flatCandle(100 + i));
    const r = computeDailyIndicators(candles);
    expect(r.atr14).not.toBeNull();
    expect(r.ema50).not.toBeNull();
    expect(r.ema200).not.toBeNull();
  });
});
