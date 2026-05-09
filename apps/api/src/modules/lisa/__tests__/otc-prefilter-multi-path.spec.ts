/**
 * PR #298 — Tests OTC pre-filter étendu aux 3 single-symbol paths.
 *
 * Bug observé prod 09/05/2026 08:15-08:20 UTC : ~14 OTC tickers (DNZOF,
 * FRCOF, OSCUF, FUWAF, SIEVF, EMSHF, LGGNF, HPHTF, CMHHF, RNSDF) loggués
 * "no eodhd intraday" à chaque cycle. PR #294 filtrait analyzeBatch mais
 * pas les autres paths. Fix : appliquer isLikelyOtcForeignOrdinaryUS dans
 * les 3 callsites manqués.
 */

import { isLikelyOtcForeignOrdinaryUS } from '../services/otc-prefilter.helper';

describe('PR #298 BUG 2 — OTC pre-filter sur les 3 callsites manqués', () => {
  // Cas réels prod 09/05/2026 08:15 UTC
  const prodObservedOtc = [
    'DNZOF.US', 'FRCOF.US', 'OSCUF.US', 'FUWAF.US', 'SIEVF.US',
    'EMSHF.US', 'LGGNF.US', 'HPHTF.US', 'CMHHF.US', 'RNSDF.US',
  ];

  describe('isLikelyOtcForeignOrdinaryUS catches all 10 prod tickers', () => {
    it.each(prodObservedOtc)('flags %s', (ticker) => {
      expect(isLikelyOtcForeignOrdinaryUS(ticker)).toBe(true);
    });
  });

  describe('preserves non-matching tickers (no false positives)', () => {
    it.each([
      'AAPL.US',     // 4 letters
      'TSLA.US',     // 4 letters not ending F
      'GOOGL.US',    // 5 letters ending L
      'BRK-B.US',    // class share with hyphen
      '7203.T',      // Tokyo
      '0700.HK',     // HK
      '005930.KO',   // KRX
      'BHP.AU',      // ASX
      'BTCUSDT',     // crypto no suffix
    ])('does NOT flag %s', (ticker) => {
      expect(isLikelyOtcForeignOrdinaryUS(ticker)).toBe(false);
    });
  });
});
