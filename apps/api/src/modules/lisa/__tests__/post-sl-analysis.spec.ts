/**
 * PR #292 — Tests pure helper post_sl_analysis (rebound, ATR, drawdown).
 */
import {
  computeAtr,
  computePostSlAnalysis,
  type OhlcCandle,
} from '../services/post-sl-analysis.helper';

function candle(ts: number, o: number, h: number, l: number, c: number): OhlcCandle {
  return { timestamp: ts, open: o, high: h, low: l, close: c };
}

describe('computeAtr', () => {
  it('returns null when not enough candles for period+1', () => {
    const candles = Array.from({ length: 14 }, (_, i) => candle(1000 + i * 60, 100, 101, 99, 100));
    expect(computeAtr(candles, 14)).toBeNull();
  });

  it('computes ATR(14) on sample with consistent volatility', () => {
    // 15 candles, each with TR ≈ 1.0 (high-low = 1.0 systematically)
    const candles = Array.from({ length: 15 }, (_, i) => candle(1000 + i * 60, 100, 101, 100, 100.5));
    const atr = computeAtr(candles, 14);
    expect(atr).not.toBeNull();
    expect(atr).toBeCloseTo(1.0, 2);
  });

  it('handles gap-style TR via |high - close_prev|', () => {
    // Candle gap up : high=105, close_prev=100 → TR_gap = 5
    const candles: OhlcCandle[] = [
      candle(1000, 100, 100.5, 99.5, 100),    // close_prev = 100
      candle(1060, 105, 105.5, 104.5, 105),   // gap up : TR = max(1, |105.5 - 100|, |104.5 - 100|) = 5.5
    ];
    // Pour ATR(1) (period=1, need 2 candles)
    const atr = computeAtr(candles, 1);
    expect(atr).toBeCloseTo(5.5, 2);
  });
});

describe('computePostSlAnalysis', () => {
  const exitTs = 1700000000;
  const exitPrice = 100;

  it('detects rebound to 50% within 30min', () => {
    // 30 candles 1min post-SL.
    // Drawdown : low atteint 99 (drop 1%) après 5min
    // Recovery : high atteint 99.5 (rebound 50% du drop -1% = +0.5% from low = 99.5) après 15min
    const candlesPost: OhlcCandle[] = [
      candle(exitTs + 60, 100, 100, 99.5, 99.5),     // 1min : drop 0.5%
      candle(exitTs + 120, 99.5, 99.5, 99, 99),       // 2min : drop 1% (worst)
      candle(exitTs + 300, 99, 99.5, 99, 99.5),       // 5min : already 50% recovery
    ];
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'long',
      candlesPostSl: candlesPost,
      candlesPriorAtr: [],
    });
    expect(result.max_drawdown_post_sl_pct).toBeCloseTo(-0.01, 4); // -1%
    expect(result.max_recovery_post_sl_pct).toBeCloseTo(0, 4);
    // recovery=0 vs |drawdown|/2=0.5%. 0 < 0.5% → rebound50 = false
    expect(result.rebound_to_50pct_within_30min).toBe(false);
  });

  it('detects 100% rebound (high comes back to exitPrice)', () => {
    const candlesPost: OhlcCandle[] = [
      candle(exitTs + 60, 100, 100, 99, 99),
      candle(exitTs + 120, 99, 100, 99, 100),  // rebond complet
      candle(exitTs + 180, 100, 100.5, 100, 100.3),  // dépasse exitPrice
    ];
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'long',
      candlesPostSl: candlesPost,
      candlesPriorAtr: [],
    });
    // max recovery vs exitPrice = +0.5% (high 100.5)
    expect(result.max_recovery_post_sl_pct).toBeCloseTo(0.005, 4);
    // |max drawdown| = 1% (low 99). recovery 0.5% >= 1%/2 = 0.5% → rebound50 = true
    expect(result.rebound_to_50pct_within_30min).toBe(true);
    // recovery 0.5% < 1% (full drawdown) → rebound100 = false
    expect(result.rebound_to_100pct_within_30min).toBe(false);
  });

  it('classifies as wick when drawdown < 1× ATR', () => {
    // ATR : 14 candles 5m avec variation 0.01% chaque (bruit faible)
    const candlesPriorAtr: OhlcCandle[] = Array.from({ length: 15 }, (_, i) =>
      candle(exitTs - (15 - i) * 300, 100, 100.05, 99.95, 100)
    );
    // ATR ≈ 0.10 absolute / 100 = 0.001 = 0.1%
    // Post-SL drawdown : 0.05% (= 0.05 absolute)
    const candlesPost: OhlcCandle[] = [
      candle(exitTs + 60, 100, 100, 99.95, 99.95),  // -0.05%
    ];
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'long',
      candlesPostSl: candlesPost,
      candlesPriorAtr,
    });
    expect(result.atr_14_at_exit_pct).toBeCloseTo(0.001, 4);
    expect(result.max_drawdown_post_sl_pct).toBeCloseTo(-0.0005, 4);
    // |drawdown| / atr = 0.0005 / 0.001 = 0.5 → wick
    expect(result.drawdown_in_atr_units).toBeCloseTo(0.5, 2);
    expect(result.drawdown_in_atr_units).toBeLessThan(1);
  });

  it('classifies as real move when drawdown > 2× ATR', () => {
    // ATR low (0.1%), but drawdown big (0.5%)
    const candlesPriorAtr: OhlcCandle[] = Array.from({ length: 15 }, (_, i) =>
      candle(exitTs - (15 - i) * 300, 100, 100.05, 99.95, 100)
    );
    const candlesPost: OhlcCandle[] = [
      candle(exitTs + 60, 100, 100, 99.5, 99.5),  // -0.5%
    ];
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'long',
      candlesPostSl: candlesPost,
      candlesPriorAtr,
    });
    expect(result.drawdown_in_atr_units).toBeCloseTo(5, 2);  // 0.005/0.001 = 5
    expect(result.drawdown_in_atr_units).toBeGreaterThan(2);
  });

  it('handles empty post-SL candles gracefully', () => {
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'long',
      candlesPostSl: [],
      candlesPriorAtr: [],
    });
    expect(result.max_drawdown_post_sl_pct).toBe(0);
    expect(result.max_recovery_post_sl_pct).toBe(0);
    expect(result.candle_count).toBe(0);
    expect(result.atr_14_at_exit_pct).toBeNull();
  });

  it('inverts drawdown/recovery direction for short positions', () => {
    // Short : prix monte = perte. exitPrice 100, high 102 = drawdown -2% (perte)
    const candlesPost: OhlcCandle[] = [
      candle(exitTs + 60, 100, 102, 100, 101),  // high 102 = mauvais pour short
    ];
    const result = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction: 'short',
      candlesPostSl: candlesPost,
      candlesPriorAtr: [],
    });
    expect(result.max_drawdown_post_sl_pct).toBeCloseTo(-0.02, 4);  // -2% loss for short
    expect(result.max_recovery_post_sl_pct).toBeCloseTo(0, 4);  // low=100=exit, no recovery
  });
});
