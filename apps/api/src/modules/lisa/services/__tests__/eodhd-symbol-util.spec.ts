/**
 * Hotfix EODHD bypass — tests d'ensureEodhdSuffix.
 */

import { ensureEodhdSuffix } from '../eodhd-symbol.util';

describe('ensureEodhdSuffix', () => {
  describe('symbol déjà suffixé', () => {
    it('preserve "AAPL.US" comme tel', () => {
      expect(ensureEodhdSuffix('AAPL.US', 'US')).toBe('AAPL.US');
    });

    it('preserve "005940.KO" comme tel', () => {
      expect(ensureEodhdSuffix('005940.KO', 'KO')).toBe('005940.KO');
    });

    it('preserve "BTC-USD.CC" (crypto)', () => {
      expect(ensureEodhdSuffix('BTC-USD.CC', null)).toBe('BTC-USD.CC');
    });

    it('preserve même si exchange ne correspond pas (priority au symbol)', () => {
      // Cas pathologique : symbol a déjà .KO mais exchange=US (donnée corrompue)
      // → priorité au symbol stocké, on ne corrige pas (anti data-loss)
      expect(ensureEodhdSuffix('005940.KO', 'US')).toBe('005940.KO');
    });
  });

  describe('symbol raw + exchange connu', () => {
    it('Korea KOSPI : "005940" + "KO" → "005940.KO"', () => {
      expect(ensureEodhdSuffix('005940', 'KO')).toBe('005940.KO');
    });

    it('Korea KOSDAQ : "059120" + "KQ" → "059120.KQ"', () => {
      expect(ensureEodhdSuffix('059120', 'KQ')).toBe('059120.KQ');
    });

    it('India NSE : "NOCIL" + "NSE" → "NOCIL.NSE"', () => {
      expect(ensureEodhdSuffix('NOCIL', 'NSE')).toBe('NOCIL.NSE');
    });

    it('India BSE : "RELIANCE" + "BSE" → "RELIANCE.BSE"', () => {
      expect(ensureEodhdSuffix('RELIANCE', 'BSE')).toBe('RELIANCE.BSE');
    });

    it('Shanghai : "600322" + "SHG" → "600322.SHG"', () => {
      expect(ensureEodhdSuffix('600322', 'SHG')).toBe('600322.SHG');
    });

    it('Shenzhen : "000783" + "SHE" → "000783.SHE"', () => {
      expect(ensureEodhdSuffix('000783', 'SHE')).toBe('000783.SHE');
    });

    it('Hong Kong : "0700" + "HK" → "0700.HK"', () => {
      expect(ensureEodhdSuffix('0700', 'HK')).toBe('0700.HK');
    });

    it('LSE : "VOD" + "LSE" → "VOD.LSE"', () => {
      expect(ensureEodhdSuffix('VOD', 'LSE')).toBe('VOD.LSE');
    });

    it('case-insensitive : "ko" → ".KO"', () => {
      expect(ensureEodhdSuffix('005940', 'ko')).toBe('005940.KO');
    });
  });

  describe('Tokyo special case T → T (pas TSE)', () => {
    it('exchange "T" → suffix ".T"', () => {
      expect(ensureEodhdSuffix('7203', 'T')).toBe('7203.T');
    });

    it('exchange "TSE" (legacy scanner) → suffix ".T" (normalisé)', () => {
      // Le scanner historique a pu écrire "TSE" en exchange. EODHD intraday
      // attend `.T`. On normalise pour éviter le 404.
      expect(ensureEodhdSuffix('7203', 'TSE')).toBe('7203.T');
    });
  });

  describe('exchange manquant', () => {
    it('fallback .US si exchange null', () => {
      expect(ensureEodhdSuffix('AAPL', null)).toBe('AAPL.US');
    });

    it('fallback .US si exchange undefined', () => {
      expect(ensureEodhdSuffix('AAPL', undefined)).toBe('AAPL.US');
    });

    it('fallback .US si exchange empty string', () => {
      expect(ensureEodhdSuffix('AAPL', '')).toBe('AAPL.US');
    });
  });

  describe('edge cases', () => {
    it('symbol vide → retourne tel quel', () => {
      expect(ensureEodhdSuffix('', 'US')).toBe('');
    });

    it('exchange avec espaces → trimmed', () => {
      expect(ensureEodhdSuffix('AAPL', '  US  ')).toBe('AAPL.US');
    });
  });
});
