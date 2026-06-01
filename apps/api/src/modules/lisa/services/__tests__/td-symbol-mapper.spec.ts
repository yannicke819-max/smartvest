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

  describe('Asia EOD-only sur Pro — null en intraday (fallback EODHD)', () => {
    // Doc TD pricing 01/06/2026 : KOSPI/KOSDAQ/SHG/SHE = EOD-only.
    // Intraday 5min retournait 60 candles dont 56 nulls — inutile + gaspille credits.
    it.each([
      ['005930.KO', 'KOSPI (XKRX) — EOD only sur Pro'],
      ['086790.KQ', 'KOSDAQ (XKOS) — EOD only sur Pro'],
      ['600519.SHG', 'Shanghai (XSHG) — EOD only sur Pro'],
      ['300024.SHE', 'Shenzhen (XSHE) — EOD only sur Pro'],
    ])('%s → null (%s)', (input) => {
      expect(eodhdToTdSymbol(input)).toBeNull();
    });
  });

  describe('Exchanges NON supportés sur plan TD Pro actuel → null (fallback EODHD)', () => {
    // Validé live 19/05/2026 : add-ons payants non souscrits (Milan, JPX, HKEX, XASX).
    // À retirer du Set UNSUPPORTED_TD_SUFFIXES si les add-ons sont activés.
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
