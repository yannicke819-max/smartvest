/**
 * P3-C — Tests RSI prefilter pur.
 */
import { evaluatePrefilter, prefilterUniverse } from '../rsi-prefilter';
import type { Candle } from '../rebound-tp';

function makeBars(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: i,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1000,
  }));
}

describe('evaluatePrefilter', () => {
  it('passes when RSI is well below threshold (oversold)', () => {
    // Drop sharp last 4 closes → RSI très bas
    const bars = makeBars([
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100, 100, 92, 88, 82, 85,
    ]);
    const r = evaluatePrefilter('AAPL.US', bars, 35);
    expect(r.passes).toBe(true);
    expect(r.rsi14).toBeLessThan(35);
    expect(r.reason).toBeUndefined();
  });

  it('rejects ticker where RSI=42 (above 35 threshold)', () => {
    // Tendance haussière modérée → RSI ~50-60
    const bars = makeBars(Array.from({ length: 20 }, (_, i) => 100 + i * 0.3));
    const r = evaluatePrefilter('AAPL.US', bars, 35);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('rsi_too_high');
    expect(r.rsi14).toBeGreaterThanOrEqual(35);
  });

  it('rejects insufficient bars (< rsiPeriod + 1)', () => {
    const r = evaluatePrefilter('X', makeBars([100, 100]), 35);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('insufficient_bars');
  });

  it('rejects null bars', () => {
    const r = evaluatePrefilter('X', null, 35);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('insufficient_bars');
  });

  it('rejects bars with invalid close (NaN/negative)', () => {
    const bars = makeBars([100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                           100, 100, 100, 100, 100, 100, 100, 100, 100, NaN]);
    const r = evaluatePrefilter('X', bars, 35);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('invalid_data');
  });

  it('handles RSI=100 edge case (avgLoss=0)', () => {
    // Trend monotone haussier → avgLoss=0 → RSI=100
    const bars = makeBars(Array.from({ length: 20 }, (_, i) => 100 + i));
    const r = evaluatePrefilter('X', bars, 35);
    expect(r.passes).toBe(false);
    expect(r.rsi14).toBe(100);
  });

  it('respects custom rsi period', () => {
    const bars = makeBars([
      100, 100, 100, 100, 100, 92, 88, 82, 85,
    ]);
    // Avec period=7 (besoin 8 bars), bars=9 OK
    const r = evaluatePrefilter('X', bars, 35, 7);
    expect(r.passes).toBe(true);
  });
});

describe('prefilterUniverse', () => {
  it('returns only tickers that pass', () => {
    const oversold = makeBars([
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100, 100, 92, 88, 82, 85,
    ]);
    const trend = makeBars(Array.from({ length: 20 }, (_, i) => 100 + i * 0.3));
    const universe = [
      { ticker: 'AAPL.US', bars: oversold },
      { ticker: 'MSFT.US', bars: trend },
      { ticker: 'NVDA.US', bars: oversold },
    ];
    const passing = prefilterUniverse(universe, 35);
    expect(passing).toHaveLength(2);
    expect(passing.map((p) => p.ticker)).toEqual(['AAPL.US', 'NVDA.US']);
  });

  it('returns empty array when nothing passes', () => {
    const trend = makeBars(Array.from({ length: 20 }, (_, i) => 100 + i * 0.3));
    const passing = prefilterUniverse(
      [{ ticker: 'A', bars: trend }, { ticker: 'B', bars: trend }],
      35,
    );
    expect(passing).toHaveLength(0);
  });
});
