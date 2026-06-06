import { isMarketOpen, sessionClassForSymbol } from '../market-session.helper';

describe('isMarketOpen', () => {
  it('fermé le weekend (sam/dim) quelle que soit l’heure', () => {
    expect(isMarketOpen('us', new Date('2026-06-06T15:00:00Z'))).toBe(false); // samedi
    expect(isMarketOpen('eu', new Date('2026-06-07T10:00:00Z'))).toBe(false); // dimanche
    expect(isMarketOpen('asia', new Date('2026-06-06T03:00:00Z'))).toBe(false);
  });

  it('ouvert en séance un jour de semaine', () => {
    expect(isMarketOpen('us', new Date('2026-06-05T15:00:00Z'))).toBe(true); // vendredi 15:00 UTC
    expect(isMarketOpen('eu', new Date('2026-06-05T10:00:00Z'))).toBe(true);
    expect(isMarketOpen('asia', new Date('2026-06-05T03:00:00Z'))).toBe(true);
  });

  it('fermé hors séance en semaine', () => {
    expect(isMarketOpen('us', new Date('2026-06-05T22:00:00Z'))).toBe(false); // après cloche US
    expect(isMarketOpen('eu', new Date('2026-06-05T18:00:00Z'))).toBe(false);
    expect(isMarketOpen('asia', new Date('2026-06-05T09:00:00Z'))).toBe(false);
  });

  it('bornes : ouverture incluse, clôture exclue', () => {
    expect(isMarketOpen('eu', new Date('2026-06-05T07:00:00Z'))).toBe(true); // open inclus
    expect(isMarketOpen('eu', new Date('2026-06-05T16:30:00Z'))).toBe(false); // close exclu
  });
});

describe('sessionClassForSymbol', () => {
  it('mappe les suffixes equity vers leur session', () => {
    expect(sessionClassForSymbol('AAL.LSE')).toBe('eu');
    expect(sessionClassForSymbol('ADYEN.AS')).toBe('eu');
    expect(sessionClassForSymbol('IFX.XETRA')).toBe('eu');
    expect(sessionClassForSymbol('GNFT.PA')).toBe('eu');
    expect(sessionClassForSymbol('AAPL.US')).toBe('us');
    expect(sessionClassForSymbol('358570.KQ')).toBe('asia');
    expect(sessionClassForSymbol('0700.HK')).toBe('asia');
    expect(sessionClassForSymbol('005930.KO')).toBe('asia');
  });

  it('null (fail-open) pour crypto / forex / indices / inconnu', () => {
    expect(sessionClassForSymbol('BTCUSDT')).toBeNull(); // paire Binance sans suffixe
    expect(sessionClassForSymbol('BTC-USD.CC')).toBeNull();
    expect(sessionClassForSymbol('EURUSD.FOREX')).toBeNull();
    expect(sessionClassForSymbol('VIX.INDX')).toBeNull();
    expect(sessionClassForSymbol('BRENT.COMM')).toBeNull();
    expect(sessionClassForSymbol('FOO.ZZZ')).toBeNull(); // suffixe inconnu
  });
});
