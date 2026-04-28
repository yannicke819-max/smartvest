/**
 * P3-A — Tests rebound-tp scanner.
 *
 * Note importante sur le design du fixture : Bollinger Bands(20,2) sur
 * une chute LINÉAIRE produit des bandes très larges (forte stddev), si
 * bien que `close < bbLower` ne se déclenche jamais sur un trend
 * one-way. Le pattern réaliste de capitulation = consolidation prolongée
 * + drop sharp en quelques barres + amorce de rebond. C'est ce que
 * `capitulationSetup` modélise (stable 12 bars + drop 4 bars + bounce 1).
 */
import { scanRebound, Candle } from '../rebound-tp';

function makeBars(
  count: number,
  closeFn: (i: number) => number,
  volFn: (i: number) => number,
): Candle[] {
  const bars: Candle[] = [];
  let prevClose = closeFn(0);
  for (let i = 0; i < count; i++) {
    const close = closeFn(i);
    const open = i === 0 ? close * 0.999 : prevClose;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    bars.push({ timestamp: i, open, high, low, close, volume: volFn(i) });
    prevClose = close;
  }
  return bars;
}

/**
 * Setup de capitulation classique :
 *  - 16 bougies stables ≈ 100 (consolidation)
 *  - 3 bougies de drop sharp (92 → 88 → 82)
 *  - 1 bougie reversal (close 85 > open 82, volume spike ×3)
 *
 * RSI[t]   ≈ 14 (très bas)
 * RSI[t-1] ≈ 0  (avgGain=0 sur les 14 retours précédents)
 * Drawdown 20 ≈ -15.5% (peak high=100.5 → close=85)
 * BBLower ≈ 86.3 → close=85 < BBLower ✓
 */
function capitulationSetup(volSpikeRatio = 3.5): Candle[] {
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100, 100,    // 16 stable bars
    92, 88, 82, 85,                  // drop + reversal
  ];
  return closes.map((close, i) => {
    const open = i === 0 ? close * 0.999 : closes[i - 1];
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    return {
      timestamp: i,
      open,
      high,
      low,
      close,
      volume: i === closes.length - 1 ? Math.round(1000 * volSpikeRatio) : 1000,
    };
  });
}

describe('scanRebound', () => {
  it('returns BUY on full capitulation setup with all conditions met', () => {
    const bars = capitulationSetup();
    const sig = scanRebound(bars);
    expect(sig.type).toBe('BUY');
    if (sig.type !== 'BUY') return;
    expect(sig.entry).toBe(85);
    expect(sig.tp1).toBe(89.25); // 85 × 1.05
    expect(sig.tp2).toBe(93.5);  // 85 × 1.10
    expect(sig.tp3).toBe(97.75); // 85 × 1.15
    expect(sig.sl).toBe(81.6);   // 85 × 0.96
    expect(sig.timeStopDays).toBe(10);
    expect(sig.confidence).toBeGreaterThan(0);
    expect(sig.confidence).toBeLessThanOrEqual(1);
    expect(sig.indicators.rsi14).toBeLessThan(30);
    expect(sig.indicators.rsi14Prev).toBeLessThan(30);
    expect(sig.indicators.volSpikeRatio).toBeGreaterThan(1.5);
    expect(sig.indicators.drawdown20Pct).toBeLessThan(-15);
    expect(sig.indicators.bbLower).toBeGreaterThan(0);
  });

  it('returns HOLD insufficient_bars when history < min', () => {
    const bars = makeBars(15, () => 100, () => 1000);
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/insufficient_bars/);
    }
  });

  it('returns HOLD on bull trap (RSI not oversold)', () => {
    // Steady bull trend → RSI well above 30
    const bars = makeBars(30, (i) => 100 + i * 0.5, () => 1000);
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/rsi=/);
    }
  });

  it('returns HOLD when no volume spike (false positive filter)', () => {
    const bars = capitulationSetup(1.0); // pas de spike, vol nominal
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/volRatio/);
    }
  });

  it('returns HOLD when reversal candle is bearish (close < open)', () => {
    const setup = capitulationSetup();
    // Override last bar pour close < open (chandelle baissière)
    const last = setup[setup.length - 1];
    setup[setup.length - 1] = { ...last, open: 88, close: 82 };
    const sig = scanRebound(setup);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/candle_not_bullish/);
    }
  });

  it('returns HOLD when drawdown insufficient (price stable)', () => {
    // Range tight → drawdown faible
    const bars = makeBars(30, (i) => 100 + Math.sin(i / 3) * 0.5, () => 1000);
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      // Plusieurs failures possibles (rsi pas oversold, dd faible…) — on
      // vérifie juste qu'on a un diagnostic.
      expect(sig.reason.length).toBeGreaterThan(0);
    }
  });

  it('returns HOLD on invalid bar (negative price)', () => {
    const bars = capitulationSetup();
    bars[5] = { ...bars[5], close: -1 };
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/invalid_bar_values/);
    }
  });

  it('returns HOLD on invalid bar (high < low)', () => {
    const bars = capitulationSetup();
    bars[5] = { ...bars[5], high: 50, low: 100 };
    const sig = scanRebound(bars);
    expect(sig.type).toBe('HOLD');
  });

  it('returns HOLD when input is not an array', () => {
    const sig = scanRebound(null as unknown as Candle[]);
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/invalid_history_not_array/);
    }
  });

  it('respects custom cfg overrides (TP/SL percentages)', () => {
    const sig = scanRebound(capitulationSetup(), {
      tp1Pct: 3,
      tp2Pct: 6,
      tp3Pct: 9,
      slPct: 2,
      timeStopDays: 5,
    });
    expect(sig.type).toBe('BUY');
    if (sig.type !== 'BUY') return;
    expect(sig.tp1).toBe(87.55); // 85 × 1.03
    expect(sig.tp2).toBe(90.1);  // 85 × 1.06
    expect(sig.tp3).toBe(92.65); // 85 × 1.09
    expect(sig.sl).toBe(83.3);   // 85 × 0.98
    expect(sig.timeStopDays).toBe(5);
  });

  it('respects stricter rsiOversold threshold (RSI 14 fails when oversold=10)', () => {
    // RSI[t] ≈ 14, donc avec oversold=10 → HOLD car rsi14 >= 10
    const sig = scanRebound(capitulationSetup(), { rsiOversold: 10 });
    expect(sig.type).toBe('HOLD');
    if (sig.type === 'HOLD') {
      expect(sig.reason).toMatch(/rsi=/);
    }
  });

  it('confidence rises with more extreme oversold conditions', () => {
    const baseline = scanRebound(capitulationSetup(2.0));
    expect(baseline.type).toBe('BUY');
    if (baseline.type !== 'BUY') return;
    // Setup encore plus extrême : volume spike x10
    const extreme = scanRebound(capitulationSetup(10));
    expect(extreme.type).toBe('BUY');
    if (extreme.type !== 'BUY') return;
    expect(extreme.confidence).toBeGreaterThan(baseline.confidence);
  });
});
