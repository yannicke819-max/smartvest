/**
 * PR #355 — Tests helper pur `eodhdToTdSymbol`.
 *
 * Centralisation du mapping symbol EODHD → TD réutilisé par :
 *   - IntradayProviderRouter.convertToTdSymbol (dual-call)
 *   - evaluateTwelveDataFilters Supertrend US (fix bug 100% reject)
 */

import { eodhdToTdSymbol } from '../td-symbol-mapper';

describe('eodhdToTdSymbol — PR #355', () => {
  describe('US — strip suffixe (fix bug Supertrend)', () => {
    it.each([
      ['AAPL.US', 'AAPL'],
      ['EACO.US', 'EACO'],
      ['EOG.US', 'EOG'],
      ['KOS.US', 'KOS'],
      ['FDS.US', 'FDS'],
      ['BLDP.US', 'BLDP'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });

    it('AAPL (déjà sans suffixe) → AAPL', () => {
      expect(eodhdToTdSymbol('AAPL')).toBe('AAPL');
    });
  });

  describe('Canada Toronto Stock Exchange', () => {
    it.each([
      ['DCBO.TO', 'DCBO:TSX'],
      ['KEI.TO', 'KEI:TSX'],
      ['LCFS.TO', 'LCFS:TSX'],
      ['SDE.TO', 'SDE:TSX'],
      ['TNZ.TO', 'TNZ:TSX'],
      ['MATR.TO', 'MATR:TSX'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });

  describe('Europe — LSE / Euronext / XETRA / SIX / Milan', () => {
    it.each([
      ['BARC.L', 'BARC:LSE'],
      ['BARC.LSE', 'BARC:LSE'],
      ['BNP.PA', 'BNP:Euronext'],
      ['ASML.AS', 'ASML:Euronext'],
      ['HEIA.AMS', 'HEIA:Euronext'],
      ['BMW.XETRA', 'BMW:XETR'],
      ['BMW.DE', 'BMW:XETR'],
      ['NESN.SW', 'NESN:SIX'],
      ['STM.MI', 'STM:MIL'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });

  describe('Asia (PR #353)', () => {
    it.each([
      ['005930.KO', '005930:KRX'],
      ['086790.KQ', '086790:KRX'],
      ['600519.SHG', '600519:SSE'],
      ['300024.SHE', '300024:SZSE'],
      ['0700.HK', '0700:HKEX'],
      ['7203.T', '7203:XTKS'],
      ['CBA.AU', 'CBA:XASX'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });

  describe('Edge cases', () => {
    it.each([
      ['', null],
      ['SOMETHING.XYZ', null],
      ['FOO.BAR', null],
      ['TEST.ZZZ', null],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });
});
