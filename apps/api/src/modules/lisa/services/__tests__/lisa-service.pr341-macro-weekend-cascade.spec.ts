import { LisaService } from '../lisa.service';

/**
 * PR #341 — tests pour `isCascadeFullyClosed`, helper utilisé par
 * `fetchCascade` pour short-circuit silencieux quand TOUS les tickers ciblent
 * des marchés fermés.
 *
 * Pattern identique à market-snapshot-refactor.spec : Object.create LisaService
 * sans appeler le constructor (les méthodes testées sont pure logique).
 */

function makeBareLisaService(): LisaService {
  return Object.create(LisaService.prototype) as LisaService;
}

describe('LisaService.isCascadeFullyClosed — PR #341 macro weekend filter', () => {
  const service = makeBareLisaService();

  describe('cascade fully closed → true', () => {
    it('SPY.US samedi → true (us equity fermé weekend)', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'SPY.US', quality: 'live' }],
        sat,
      );
      expect(closed).toBe(true);
    });

    it('EURUSD.FOREX dimanche 21h UTC → true (forex pas encore réouvert)', () => {
      const sun = new Date('2026-05-17T21:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'EURUSD.FOREX', quality: 'live' }],
        sun,
      );
      expect(closed).toBe(true);
    });

    it('cascade gold avec XAUUSD.FOREX + GLD.US tous fermés samedi → true', () => {
      const sat = new Date('2026-05-16T10:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [
          { ticker: 'XAUUSD.FOREX', quality: 'live' },
          { ticker: 'GLD.US', multiplier: 10, quality: 'proxy' },
        ],
        sat,
      );
      expect(closed).toBe(true);
    });

    it('cascade brent (USO.US) samedi → true', () => {
      const sat = new Date('2026-05-16T10:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'USO.US', multiplier: 1.05, quality: 'proxy' }],
        sat,
      );
      expect(closed).toBe(true);
    });
  });

  describe('cascade traversée normale → false', () => {
    it('EURUSD.FOREX dimanche 23h UTC → false (forex ouvert)', () => {
      const sun = new Date('2026-05-17T23:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'EURUSD.FOREX', quality: 'live' }],
        sun,
      );
      expect(closed).toBe(false);
    });

    it('SPY.US lundi 14h UTC → false (us equity ouvert)', () => {
      const mon = new Date('2026-05-18T14:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'SPY.US', quality: 'live' }],
        mon,
      );
      expect(closed).toBe(false);
    });
  });

  describe('exemptions (source ou ticker spécial) → false même weekend', () => {
    it('^VIX samedi → false (Yahoo indices toujours servis)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: '^VIX', source: 'yahoo', quality: 'live' }],
        sat,
      );
      expect(closed).toBe(false);
    });

    it('^TNX samedi → false (Yahoo indice rates 24/7)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: '^TNX', source: 'yahoo', quality: 'live' }],
        sat,
      );
      expect(closed).toBe(false);
    });

    it('DX-Y.NYB samedi → false (Yahoo dollar index exempt)', () => {
      const sat = new Date('2026-05-16T03:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'DX-Y.NYB', source: 'yahoo', quality: 'live' }],
        sat,
      );
      expect(closed).toBe(false);
    });

    it('DGS10 samedi → false (source FRED toujours considérée open)', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'DGS10', source: 'fred', quality: 'live' }],
        sat,
      );
      expect(closed).toBe(false);
    });

    it('BTC-USD.CC dimanche → false (crypto 24/7)', () => {
      const sun = new Date('2026-05-17T03:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'BTC-USD.CC', quality: 'live' }],
        sun,
      );
      expect(closed).toBe(false);
    });

    it('cascade us10y mixte (TNX yahoo + TNX.INDX eodhd + DGS10 fred) samedi → false', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [
          { ticker: '^TNX', source: 'yahoo', quality: 'live' },
          { ticker: 'TNX.INDX', source: 'eodhd', quality: 'live' },
          { ticker: 'DGS10', source: 'fred', quality: 'live' },
        ],
        sat,
      );
      expect(closed).toBe(false);
    });

    it('cascade dxy mixte avec UUP.US fallback samedi → false (DX-Y.NYB exempt)', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [
          { ticker: 'DX-Y.NYB', source: 'yahoo', quality: 'live' },
          { ticker: 'DXY.INDX', source: 'eodhd', quality: 'live' },
          { ticker: 'UUP.US', source: 'eodhd', multiplier: 4.1, quality: 'proxy' },
        ],
        sat,
      );
      expect(closed).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('attempts vide → false (rien à filtrer, pas de short-circuit)', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed([], sat);
      expect(closed).toBe(false);
    });

    it('source eodhd implicite (par défaut) sur SPY.US samedi → true', () => {
      const sat = new Date('2026-05-16T15:00:00Z');
      const closed = service.isCascadeFullyClosed(
        [{ ticker: 'SPY.US', quality: 'live' }], // pas de `source`, default eodhd
        sat,
      );
      expect(closed).toBe(true);
    });
  });
});
