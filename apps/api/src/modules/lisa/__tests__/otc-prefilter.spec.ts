/**
 * PR #295 — Tests du pré-filtre OTC Foreign Ordinary US.
 *
 * Cas réels observés prod 08/05/2026 20:28 UTC : BRDCF, MGDDF, SEMUF, MAKSF.
 * Tous matchent le pattern 5-letter ending in F → drop attendu.
 */

import {
  isLikelyOtcForeignOrdinaryUS,
  filterOutOtcForeignOrdinary,
} from '../services/otc-prefilter.helper';

describe('isLikelyOtcForeignOrdinaryUS', () => {
  describe('matches OTC Foreign Ordinary patterns', () => {
    it.each([
      ['BRDCF.US'],
      ['MGDDF.US'],
      ['SEMUF.US'],
      ['MAKSF.US'],
      // Sans suffix (treated as US default)
      ['BRDCF'],
      ['MGDDF'],
      // Lowercase input (normalized)
      ['brdcf.us'],
      ['  BRDCF.US  '],  // whitespace trimmed
    ])('flags %s as OTC', (sym) => {
      expect(isLikelyOtcForeignOrdinaryUS(sym)).toBe(true);
    });
  });

  describe('preserves legitimate US tickers', () => {
    it.each([
      ['AAPL.US'],     // 4 letters
      ['AAPL'],
      ['MSFT.US'],     // 4 letters
      ['GOOGL.US'],    // 5 letters but ends in L
      ['TSLA.US'],
      ['BRK-B.US'],    // class share, contains hyphen
      ['ABCDE.US'],    // 5 letters not ending in F
      ['ABCD.US'],     // 4 letters
      ['F.US'],        // 1 letter (Ford)
      ['FORD.US'],     // 4 letters ending in D
    ])('does NOT flag %s', (sym) => {
      expect(isLikelyOtcForeignOrdinaryUS(sym)).toBe(false);
    });
  });

  describe('preserves non-US exchanges (APAC/EU)', () => {
    it.each([
      ['7203.T'],         // Toyota Tokyo
      ['005930.KO'],      // Samsung Korea
      ['0700.HK'],        // Tencent Hong Kong
      ['CCP.AU'],         // Credit Corp ASX
      ['BMW.XETRA'],      // BMW Frankfurt
      ['MC.PA'],          // LVMH Paris
      ['HSBA.LSE'],       // HSBC London
      ['NESN.SW'],        // Nestlé Swiss
      ['BRDCF.HK'],       // hypothetical 5-letter F on non-US — preserved
      ['ABCDF.PA'],       // hypothetical 5-letter F Paris — preserved
    ])('does NOT flag %s (non-US exchange)', (sym) => {
      expect(isLikelyOtcForeignOrdinaryUS(sym)).toBe(false);
    });
  });

  describe('handles edge cases', () => {
    it.each([
      [''],            // empty string
      [' '],           // whitespace only
      ['.US'],         // suffix only, empty root
      ['BTCUSDT'],     // crypto pair (no suffix, 7 letters)
      ['BTC-USD.CC'],  // crypto with EODHD suffix
      ['EURUSD.FOREX'],// FX pair
    ])('does NOT flag %s', (sym) => {
      expect(isLikelyOtcForeignOrdinaryUS(sym)).toBe(false);
    });
  });
});

describe('filterOutOtcForeignOrdinary', () => {
  it('splits a mixed batch into kept/dropped', () => {
    const input = [
      { symbol: 'AAPL.US' },
      { symbol: 'BRDCF.US' },
      { symbol: '7203.T' },
      { symbol: 'MGDDF.US' },
      { symbol: 'TSLA.US' },
      { symbol: 'SEMUF.US' },
    ];
    const { kept, dropped } = filterOutOtcForeignOrdinary(input);
    expect(kept.map((c) => c.symbol)).toEqual(['AAPL.US', '7203.T', 'TSLA.US']);
    expect(dropped.map((c) => c.symbol)).toEqual(['BRDCF.US', 'MGDDF.US', 'SEMUF.US']);
  });

  it('returns empty arrays for empty input', () => {
    const { kept, dropped } = filterOutOtcForeignOrdinary([]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('preserves all candidates when none match OTC pattern', () => {
    const input = [
      { symbol: 'AAPL.US' },
      { symbol: 'TSLA.US' },
      { symbol: '7203.T' },
    ];
    const { kept, dropped } = filterOutOtcForeignOrdinary(input);
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it('drops all candidates when all match OTC pattern', () => {
    const input = [
      { symbol: 'BRDCF.US' },
      { symbol: 'MGDDF.US' },
    ];
    const { kept, dropped } = filterOutOtcForeignOrdinary(input);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(2);
  });

  it('preserves candidate object shape (extra fields)', () => {
    const input = [
      { symbol: 'AAPL.US', currentPrice: 180, exchange: 'US' },
      { symbol: 'BRDCF.US', currentPrice: 5, exchange: 'US' },
    ];
    const { kept, dropped } = filterOutOtcForeignOrdinary(input);
    expect(kept[0]).toEqual({ symbol: 'AAPL.US', currentPrice: 180, exchange: 'US' });
    expect(dropped[0]).toEqual({ symbol: 'BRDCF.US', currentPrice: 5, exchange: 'US' });
  });
});
