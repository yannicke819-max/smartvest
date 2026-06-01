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

  describe('Europe supportée — LSE / Euronext / XETRA / SIX', () => {
    it.each([
      ['BARC.L', 'BARC:LSE'],
      ['BARC.LSE', 'BARC:LSE'],
      ['BNP.PA', 'BNP:Euronext'],
      ['ASML.AS', 'ASML:Euronext'],
      ['HEIA.AMS', 'HEIA:Euronext'],
      ['BMW.XETRA', 'BMW:XETR'],
      ['BMW.DE', 'BMW:XETR'],
      ['NESN.SW', 'NESN:SIX'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });

  describe('Asia supportée — KRX / SSE / SZSE (validé live 19/05/2026)', () => {
    // Mapping reste valide pour /quote (last price stops).
    // Pour intraday voir isIntradayEodOnly() qui bypass ces suffixes.
    it.each([
      ['005930.KO', '005930:KRX'],
      ['086790.KQ', '086790:KRX'],
      ['600519.SHG', '600519:SSE'],
      ['300024.SHE', '300024:SZSE'],
    ])('%s → %s', (input, expected) => {
      expect(eodhdToTdSymbol(input)).toBe(expected);
    });
  });

  describe('Exchanges NON supportés sur plan TD Pro actuel → null (fallback EODHD)', () => {
    // Add-ons payants non souscrits (Milan, JPX, HKEX, XASX) + EOD-only Tel Aviv + Warsaw absent.
    it.each([
      ['STM.MI', 'Milan (Borsa Italiana) — add-on requis'],
      ['ENEL.MI', 'Milan — add-on requis'],
      ['7203.T', 'Tokyo (JPX) — add-on payant'],
      ['9984.T', 'Tokyo — add-on payant'],
      ['0700.HK', 'Hong Kong (HKEX) — add-on payant'],
      ['9988.HK', 'HK — add-on payant'],
      ['CBA.AU', 'ASX (XASX) — add-on requis'],
      ['BHP.AU', 'ASX — add-on requis'],
      ['TEVA.TA', 'Tel Aviv (XTAE) — EOD only sur Pro'],
      ['LPP.WAR', 'Warsaw (GPW) — pas dans Pro'],
    ])('%s → null (%s)', (input) => {
      expect(eodhdToTdSymbol(input)).toBeNull();
    });
  });

  describe('isIntradayEodOnly — KO/KQ/SHG/SHE bypass intraday (doc 01/06/2026)', () => {
    // Mapping reste pour /quote, mais l'intraday 5min retourne ~93% nulls → skip.
    it.each([
      ['005930.KO', true],
      ['086790.KQ', true],
      ['600519.SHG', true],
      ['300024.SHE', true],
      ['AAPL.US', false],
      ['BARC.LSE', false],
      ['BNP.PA', false],
      ['TEVA.TA', false],  // .TA déjà null via eodhdToTdSymbol, pas besoin de double-flag
    ])('%s → isIntradayEodOnly=%s', (input, expected) => {
      // import dynamique pour rester aligné avec eodhdToTdSymbol
      const { isIntradayEodOnly } = require('../td-symbol-mapper');
      expect(isIntradayEodOnly(input)).toBe(expected);
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
