/**
 * Tests pour computeAtrPct — pure helper.
 */
import { computeAtrPct, type OhlcBar } from '../atr-helper';

function bar(high: number, low: number, close: number): OhlcBar {
  return { high, low, close };
}

describe('computeAtrPct — happy path', () => {
  it('computes ATR14 on 15 bars (minimum)', () => {
    // 15 bars : besoin de prev close pour le 1er TR du fenêtre 14.
    // Tous les bars : high-low = 1, prev_close gap = 0 → TR = 1
    // ATR = 1, last close = 100 → ATR% = 1%
    const bars: OhlcBar[] = Array.from({ length: 15 }, (_, i) => bar(101 + i, 100 + i, 100 + i));
    const atrPct = computeAtrPct(bars, 14);
    expect(atrPct).not.toBeNull();
    // ATR depends on gap close-to-high, but for our linear sequence it's
    // dominated by the same daily range (1 USD on $100-115). Anyway just
    // verify it's positive and reasonable.
    expect(atrPct!).toBeGreaterThan(0);
    expect(atrPct!).toBeLessThan(5);
  });

  it('returns higher ATR when bars are more volatile', () => {
    // Volatile : range 5, calm : range 0.1
    const calm: OhlcBar[] = Array.from({ length: 20 }, () => bar(100.05, 99.95, 100));
    const volatile: OhlcBar[] = Array.from({ length: 20 }, () => bar(102.5, 97.5, 100));
    const atrCalm = computeAtrPct(calm, 14)!;
    const atrVolatile = computeAtrPct(volatile, 14)!;
    expect(atrVolatile).toBeGreaterThan(atrCalm * 10); // ordre de magnitude
  });

  it('ratio ATR14/ATR50 < 0.8 when last 14 bars are calmer than the 50', () => {
    // 37 bars volatile + 14 bars calm = 51 bars (need period+1=51 pour ATR50)
    const bars: OhlcBar[] = [
      ...Array.from({ length: 37 }, () => bar(102, 98, 100)),
      ...Array.from({ length: 14 }, () => bar(100.2, 99.8, 100)),
    ];
    const atr14 = computeAtrPct(bars, 14)!;
    const atr50 = computeAtrPct(bars, 50)!;
    expect(atr14).not.toBeNull();
    expect(atr50).not.toBeNull();
    expect(atr14 / atr50).toBeLessThan(0.8); // déclenche RANGE
  });

  it('ratio ATR14/ATR50 ≈ 1 when bars are uniformly volatile', () => {
    const bars: OhlcBar[] = Array.from({ length: 51 }, () => bar(101, 99, 100));
    const atr14 = computeAtrPct(bars, 14)!;
    const atr50 = computeAtrPct(bars, 50)!;
    const ratio = atr14 / atr50;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });
});

describe('computeAtrPct — edge cases', () => {
  it('returns null when bars.length < period + 1', () => {
    const bars: OhlcBar[] = Array.from({ length: 14 }, () => bar(101, 99, 100));
    expect(computeAtrPct(bars, 14)).toBeNull();
    expect(computeAtrPct(Array.from({ length: 50 }, () => bar(101, 99, 100)), 50)).toBeNull();
  });

  it('returns null when bars.length === period (need period+1 minimum)', () => {
    const bars: OhlcBar[] = Array.from({ length: 14 }, () => bar(101, 99, 100));
    expect(computeAtrPct(bars, 14)).toBeNull();
  });

  it('accepts exactly period + 1 bars (boundary)', () => {
    const bars: OhlcBar[] = Array.from({ length: 15 }, () => bar(101, 99, 100));
    expect(computeAtrPct(bars, 14)).not.toBeNull();
  });

  it('returns null on period < 1', () => {
    const bars: OhlcBar[] = Array.from({ length: 20 }, () => bar(101, 99, 100));
    expect(computeAtrPct(bars, 0)).toBeNull();
    expect(computeAtrPct(bars, -1)).toBeNull();
  });

  it('returns null when bars is not an array', () => {
    expect(computeAtrPct(null as unknown as OhlcBar[], 14)).toBeNull();
    expect(computeAtrPct(undefined as unknown as OhlcBar[], 14)).toBeNull();
  });

  it('returns null when bars contain NaN/Infinity', () => {
    const bars: OhlcBar[] = [
      ...Array.from({ length: 14 }, () => bar(101, 99, 100)),
      bar(NaN, 99, 100),
    ];
    expect(computeAtrPct(bars, 14)).toBeNull();
  });

  it('returns null when bars contain 0 or negative prices', () => {
    const bars1: OhlcBar[] = [
      ...Array.from({ length: 14 }, () => bar(101, 99, 100)),
      bar(0, 0, 0),
    ];
    expect(computeAtrPct(bars1, 14)).toBeNull();

    const bars2: OhlcBar[] = [
      ...Array.from({ length: 14 }, () => bar(101, 99, 100)),
      bar(-1, 99, 100),
    ];
    expect(computeAtrPct(bars2, 14)).toBeNull();
  });

  it('returns null when high < low (data corruption)', () => {
    const bars: OhlcBar[] = [
      ...Array.from({ length: 14 }, () => bar(101, 99, 100)),
      bar(99, 101, 100), // inversed
    ];
    expect(computeAtrPct(bars, 14)).toBeNull();
  });

  it('handles realistic BTC daily bars (50 days, ~2-4% range)', () => {
    // Simule ~50 jours BTC avec range typique 2-4% du prix
    const bars: OhlcBar[] = Array.from({ length: 51 }, (_, i) => {
      const close = 70000 + i * 100;
      return { high: close * 1.025, low: close * 0.975, close };
    });
    const atr14 = computeAtrPct(bars, 14)!;
    const atr50 = computeAtrPct(bars, 50)!;
    expect(atr14).toBeGreaterThan(2); // > 2%
    expect(atr14).toBeLessThan(6);    // < 6%
    expect(atr50).toBeGreaterThan(2);
    expect(atr50).toBeLessThan(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeRealizedVolPct (P1 PR D)
// ─────────────────────────────────────────────────────────────────────────────

import { computeRealizedVolPct } from '../atr-helper';

describe('computeRealizedVolPct — happy path', () => {
  it('returns 0 when bars are flat (no movement)', () => {
    const bars: OhlcBar[] = Array.from({ length: 61 }, () => bar(100, 100, 100));
    const v = computeRealizedVolPct(bars, 60);
    expect(v).toBe(0);
  });

  it('returns positive value for volatile bars', () => {
    // Génère 61 closes alternants ±1% pour simuler choppy market
    const bars: OhlcBar[] = Array.from({ length: 61 }, (_, i) => {
      const close = i % 2 === 0 ? 100 : 101;
      return bar(close + 0.5, close - 0.5, close);
    });
    const v = computeRealizedVolPct(bars, 60)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(20); // sanity bound
  });

  it('triggers VOL_SPIKE threshold (>3%) on extreme intraday moves', () => {
    // Simulate très volatile : close varie 5% par bar
    const bars: OhlcBar[] = [];
    let close = 100;
    for (let i = 0; i < 61; i++) {
      close = close * (1 + (i % 2 === 0 ? 0.05 : -0.05)); // ±5% per bar
      bars.push(bar(close * 1.01, close * 0.99, close));
    }
    const v = computeRealizedVolPct(bars, 60)!;
    expect(v).toBeGreaterThan(3); // déclencherait VOL_SPIKE
  });

  it('low realized vol on smooth uptrend', () => {
    // Hausse régulière 0.05% par bar = très lisse
    const bars: OhlcBar[] = [];
    let close = 100;
    for (let i = 0; i < 61; i++) {
      close = close * 1.0005;
      bars.push(bar(close, close, close));
    }
    const v = computeRealizedVolPct(bars, 60)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.5); // smooth → low vol
  });

  it('default periods=60 (1h depuis 1m bars)', () => {
    const bars: OhlcBar[] = Array.from({ length: 61 }, (_, i) =>
      bar(100 + i * 0.1, 100 + i * 0.1, 100 + i * 0.1),
    );
    expect(computeRealizedVolPct(bars)).not.toBeNull();
  });
});

describe('computeRealizedVolPct — edge cases', () => {
  it('returns null when bars.length < periods + 1', () => {
    const bars: OhlcBar[] = Array.from({ length: 60 }, () => bar(100, 100, 100));
    expect(computeRealizedVolPct(bars, 60)).toBeNull();
  });

  it('returns null when periods < 2', () => {
    const bars: OhlcBar[] = Array.from({ length: 100 }, () => bar(100, 100, 100));
    expect(computeRealizedVolPct(bars, 1)).toBeNull();
    expect(computeRealizedVolPct(bars, 0)).toBeNull();
  });

  it('returns null when bars is not array', () => {
    expect(computeRealizedVolPct(null as unknown as OhlcBar[], 60)).toBeNull();
    expect(computeRealizedVolPct(undefined as unknown as OhlcBar[], 60)).toBeNull();
  });

  it('returns null when close is 0 or negative', () => {
    const bars: OhlcBar[] = Array.from({ length: 61 }, () => bar(100, 100, 100));
    bars[10] = bar(0, 0, 0); // corruption
    expect(computeRealizedVolPct(bars, 60)).toBeNull();
  });

  it('returns null when log return is non-finite (close jump from 0)', () => {
    const bars: OhlcBar[] = Array.from({ length: 61 }, () => bar(100, 100, 100));
    // Even though we filter close <= 0, a NaN in close should fail too
    bars[5] = bar(NaN, NaN, NaN);
    expect(computeRealizedVolPct(bars, 60)).toBeNull();
  });

  it('handles realistic BTC 1m bars (60 min, ~0.1% noise)', () => {
    // BTC à ~70k avec bruit 1m 0.05-0.1%, typique heures liquides
    const bars: OhlcBar[] = [];
    let close = 70000;
    for (let i = 0; i < 61; i++) {
      const noise = (Math.sin(i * 0.5) * 0.001); // ±0.1%
      close = close * (1 + noise);
      bars.push(bar(close * 1.0005, close * 0.9995, close));
    }
    const v = computeRealizedVolPct(bars, 60)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5); // realistic
  });
});
