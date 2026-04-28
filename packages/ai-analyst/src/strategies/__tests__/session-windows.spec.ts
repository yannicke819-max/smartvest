/**
 * P4-A — Tests session-windows pure.
 *
 * Vérifie les transitions à 4 timestamps de référence (CEST = UTC+2 été) :
 *   - 02h CEST = 00h UTC → Nikkei (00-06 UTC) actif
 *   - 10h CEST = 08h UTC → DAX/CAC (07-15:30) + FTSE (08-16:30) + HSI (01:30-08:00 fini)
 *   - 16h CEST = 14h UTC → CAC/DAX fini, FTSE actif, US (14:30-21:00) qq min
 *   - 23h CEST = 21h UTC → US fini, après-hours, fallback
 */
import { isWithinSession, aggregateActiveWatchlists } from '../session-windows';

const CAC = {
  name: 'cac40',
  exchange: 'EURONEXT',
  sessionOpenUtc: '07:00',
  sessionCloseUtc: '15:30',
  tickers: ['MC.PA', 'BNP.PA'],
};
const DAX = {
  name: 'dax40',
  exchange: 'XETRA',
  sessionOpenUtc: '07:00',
  sessionCloseUtc: '15:30',
  tickers: ['SAP.DE', 'SIE.DE'],
};
const FTSE = {
  name: 'ftse100',
  exchange: 'LSE',
  sessionOpenUtc: '08:00',
  sessionCloseUtc: '16:30',
  tickers: ['HSBA.L', 'BP.L'],
};
const NIKKEI = {
  name: 'nikkei225',
  exchange: 'TSE',
  sessionOpenUtc: '00:00',
  sessionCloseUtc: '06:00',
  tickers: ['7203.T', '6758.T'],
};
const HSI = {
  name: 'hsi50',
  exchange: 'HKEX',
  sessionOpenUtc: '01:30',
  sessionCloseUtc: '08:00',
  tickers: ['0700.HK', '9988.HK'],
};
const SP500 = {
  name: 'sp500',
  exchange: 'US',
  sessionOpenUtc: '14:30',
  sessionCloseUtc: '21:00',
  tickers: ['AAPL.US', 'MSFT.US'],
};
const ALL = [CAC, DAX, FTSE, NIKKEI, HSI, SP500];

const at = (h: number, m: number = 0) => new Date(Date.UTC(2026, 3, 28, h, m, 0));

describe('isWithinSession', () => {
  it('returns true at exact open time', () => {
    expect(isWithinSession(at(7, 0), { openUtc: '07:00', closeUtc: '15:30' })).toBe(true);
  });

  it('returns true at exact close time', () => {
    expect(isWithinSession(at(15, 30), { openUtc: '07:00', closeUtc: '15:30' })).toBe(true);
  });

  it('returns false 1 min before open', () => {
    expect(isWithinSession(at(6, 59), { openUtc: '07:00', closeUtc: '15:30' })).toBe(false);
  });

  it('returns false 1 min after close', () => {
    expect(isWithinSession(at(15, 31), { openUtc: '07:00', closeUtc: '15:30' })).toBe(false);
  });

  it('handles 30-min open like 14:30 NYSE', () => {
    expect(isWithinSession(at(14, 29), { openUtc: '14:30', closeUtc: '21:00' })).toBe(false);
    expect(isWithinSession(at(14, 30), { openUtc: '14:30', closeUtc: '21:00' })).toBe(true);
    expect(isWithinSession(at(21, 0), { openUtc: '14:30', closeUtc: '21:00' })).toBe(true);
    expect(isWithinSession(at(21, 1), { openUtc: '14:30', closeUtc: '21:00' })).toBe(false);
  });

  it('returns false on invalid window strings', () => {
    expect(isWithinSession(at(10), { openUtc: 'invalid', closeUtc: '15:30' })).toBe(false);
    expect(isWithinSession(at(10), { openUtc: '07:00', closeUtc: '99:00' })).toBe(false);
  });

  it('rejects cross-midnight (open >= close)', () => {
    expect(isWithinSession(at(10), { openUtc: '15:00', closeUtc: '07:00' })).toBe(false);
  });
});

describe('aggregateActiveWatchlists transitions', () => {
  it('02h CEST (00h UTC) → only Nikkei active', () => {
    const r = aggregateActiveWatchlists(ALL, at(0, 0));
    expect(r.activeExchanges).toEqual(['TSE']);
    expect(new Set(r.active)).toEqual(new Set(['7203.T', '6758.T']));
  });

  it('03h CEST (01h UTC) → Nikkei still active, HSI not yet (HSI opens 01:30)', () => {
    const r = aggregateActiveWatchlists(ALL, at(1, 0));
    expect(r.activeExchanges).toEqual(['TSE']);
  });

  it('04h CEST (02h UTC) → Nikkei + HSI overlap', () => {
    const r = aggregateActiveWatchlists(ALL, at(2, 0));
    expect(new Set(r.activeExchanges)).toEqual(new Set(['TSE', 'HKEX']));
    expect(r.active).toContain('7203.T');
    expect(r.active).toContain('0700.HK');
  });

  it('10h CEST (08h UTC) → DAX/CAC + FTSE + HSI fini-juste-fini', () => {
    const r = aggregateActiveWatchlists(ALL, at(8, 0));
    // HSI close 08:00 inclus → encore actif
    // DAX/CAC actif (07:00-15:30)
    // FTSE actif (08:00-16:30)
    expect(new Set(r.activeExchanges)).toEqual(new Set(['EURONEXT', 'XETRA', 'LSE', 'HKEX']));
  });

  it('11h CEST (09h UTC) → DAX/CAC + FTSE only', () => {
    const r = aggregateActiveWatchlists(ALL, at(9, 0));
    expect(new Set(r.activeExchanges)).toEqual(new Set(['EURONEXT', 'XETRA', 'LSE']));
  });

  it('16h CEST (14h UTC) → Europe (CAC/DAX/FTSE) actif, US pas encore (US 14:30)', () => {
    const r = aggregateActiveWatchlists(ALL, at(14, 0));
    // CAC/DAX 07-15:30 still active. FTSE 08-16:30 active. US not yet.
    expect(new Set(r.activeExchanges)).toEqual(new Set(['EURONEXT', 'XETRA', 'LSE']));
  });

  it('17h CEST (15h UTC) → CAC/DAX/FTSE/US all overlap', () => {
    const r = aggregateActiveWatchlists(ALL, at(15, 0));
    expect(new Set(r.activeExchanges)).toEqual(new Set(['EURONEXT', 'XETRA', 'LSE', 'US']));
  });

  it('19h CEST (17h UTC) → CAC/DAX/FTSE fini, US only', () => {
    const r = aggregateActiveWatchlists(ALL, at(17, 0));
    expect(new Set(r.activeExchanges)).toEqual(new Set(['US']));
  });

  it('23h CEST (21h UTC) → US close inclusive, after-hours pas encore', () => {
    const r = aggregateActiveWatchlists(ALL, at(21, 0));
    expect(new Set(r.activeExchanges)).toEqual(new Set(['US']));
  });

  it('23h01 CEST (21h01 UTC) → US-after-hours fallback déclenché', () => {
    const r = aggregateActiveWatchlists(ALL, at(21, 1));
    expect(r.active.length).toBe(0); // pas de fallback fourni
    expect(r.activeExchanges).toEqual([]);
  });

  it('returns empty when no fallback provided and no active session', () => {
    const r = aggregateActiveWatchlists(ALL, at(22, 0));
    expect(r.active.length).toBe(0);
  });

  it('falls back to provided US tickers when nothing active (22h UTC)', () => {
    // 22h UTC : US fini (21:00), Asie pas encore (00:00).
    const r = aggregateActiveWatchlists(
      [CAC, NIKKEI],
      at(22, 0),
      ['AAPL.US', 'MSFT.US'],
    );
    expect(r.active).toEqual(['AAPL.US', 'MSFT.US']);
    expect(r.activeExchanges).toEqual(['US_AFTERHOURS']);
  });

  it('dedups tickers across cross-listed watchlists', () => {
    const customWl = { ...SP500, tickers: ['AAPL.US', 'AAPL.US', 'MSFT.US'] };
    const r = aggregateActiveWatchlists([customWl], at(15, 0));
    expect(new Set(r.active)).toEqual(new Set(['AAPL.US', 'MSFT.US']));
  });

  it('skips watchlists without session_open_utc set', () => {
    const noWindow = { ...SP500, sessionOpenUtc: null, sessionCloseUtc: null };
    const r = aggregateActiveWatchlists([noWindow], at(15, 0));
    expect(r.active).toEqual([]);
  });
});
