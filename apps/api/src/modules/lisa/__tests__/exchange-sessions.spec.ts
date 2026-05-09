/**
 * PR #296 — Tests du helper exchange-sessions.
 *
 * Couverture :
 *   - NYSE RTH borders (open/close exact)
 *   - DST transitions US (March/November) + EU (March/October)
 *   - Asia exchanges (TSE, HKEX, KRX, SSE, ASX) avec leur TZ propre
 *   - Weekend = false sur tous les exchanges
 *   - Crypto/FX always-on = true
 *   - Suffixes inconnus = false (conservatif)
 *   - Edge cases : symbol sans suffix, invalid date, etc.
 */

import {
  isInExchangeSession,
  extractSuffix,
} from '../services/exchange-sessions.helper';

describe('extractSuffix', () => {
  it.each([
    ['AAPL.US', '.US'],
    ['7203.T', '.T'],
    ['0700.HK', '.HK'],
    ['600519.SHG', '.SHG'],
    ['BTC-USD.CC', '.CC'],
    ['EURUSD.FOREX', '.FOREX'],
    ['BMW.XETRA', '.XETRA'],
    ['HSBA.LSE', '.LSE'],
    ['AAPL', null],
    ['BTCUSDT', null],
    ['', null],
  ])('%s → %s', (sym, expected) => {
    expect(extractSuffix(sym)).toBe(expected);
  });

  it('uppercases the suffix', () => {
    expect(extractSuffix('AAPL.us')).toBe('.US');
  });
});

describe('isInExchangeSession — NYSE (.US)', () => {
  // NYSE RTH: 9:30 AM - 4:00 PM ET. May 2026 = EDT (UTC-4).
  // EDT 9:30 = UTC 13:30
  // EDT 16:00 = UTC 20:00

  it('returns true at exact open 13:30 UTC (= 9:30 EDT)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T13:30:00Z')).toBe(true);
  });

  it('returns false 1min before open 13:29 UTC', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T13:29:00Z')).toBe(false);
  });

  it('returns true mid-session 17:00 UTC (= 13:00 EDT lunch)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T17:00:00Z')).toBe(true);
  });

  it('returns false at exact close 20:00 UTC (= 16:00 EDT, exclusive)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('returns true 1min before close 19:59 UTC', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T19:59:00Z')).toBe(true);
  });

  it('returns false in pre-market 12:00 UTC (= 8:00 EDT)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T12:00:00Z')).toBe(false);
  });

  it('returns false in after-hours 22:00 UTC (= 18:00 EDT)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T22:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — DST transitions US', () => {
  // DST starts second Sunday of March. 2026 → March 8.
  // After DST: EDT = UTC-4. 9:30 EDT = 13:30 UTC.
  // Before DST: EST = UTC-5. 9:30 EST = 14:30 UTC.

  it('handles winter EST (UTC-5): 14:30 UTC = 9:30 EST → true', () => {
    expect(isInExchangeSession('AAPL.US', '2026-02-10T14:30:00Z')).toBe(true);
  });

  it('handles winter EST: 13:30 UTC = 8:30 EST (pre-market) → false', () => {
    expect(isInExchangeSession('AAPL.US', '2026-02-10T13:30:00Z')).toBe(false);
  });

  it('handles summer EDT (UTC-4): 13:30 UTC = 9:30 EDT → true', () => {
    expect(isInExchangeSession('AAPL.US', '2026-07-15T13:30:00Z')).toBe(true);
  });

  it('handles summer EDT: 14:30 UTC = 10:30 EDT (mid-session) → true', () => {
    expect(isInExchangeSession('AAPL.US', '2026-07-15T14:30:00Z')).toBe(true);
  });

  // DST ends first Sunday of November. 2026 → November 1.
  it('handles fall back: 14:30 UTC on Nov 2 = 9:30 EST (post-DST) → true', () => {
    expect(isInExchangeSession('AAPL.US', '2026-11-02T14:30:00Z')).toBe(true);
  });

  it('handles spring forward: 13:30 UTC on Mar 9 = 9:30 EDT (post-DST) → true', () => {
    expect(isInExchangeSession('AAPL.US', '2026-03-09T13:30:00Z')).toBe(true);
  });
});

describe('isInExchangeSession — Weekend', () => {
  it('returns false on Saturday during would-be RTH', () => {
    // 2026-05-09 = Saturday
    expect(isInExchangeSession('AAPL.US', '2026-05-09T17:00:00Z')).toBe(false);
  });

  it('returns false on Sunday during would-be RTH', () => {
    // 2026-05-10 = Sunday
    expect(isInExchangeSession('AAPL.US', '2026-05-10T17:00:00Z')).toBe(false);
  });

  it('returns false on Saturday for Asia exchanges', () => {
    // 2026-05-09 02:00 UTC = 11:00 JST Saturday
    expect(isInExchangeSession('7203.T', '2026-05-09T02:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — Asia exchanges', () => {
  // TSE Tokyo: 9:00-15:00 JST. JST = UTC+9 (no DST).
  // 9:00 JST = 00:00 UTC, 15:00 JST = 06:00 UTC

  it('TSE: 00:00 UTC = 9:00 JST → true', () => {
    expect(isInExchangeSession('7203.T', '2026-05-15T00:00:00Z')).toBe(true);
  });

  it('TSE: 05:59 UTC = 14:59 JST → true', () => {
    expect(isInExchangeSession('7203.T', '2026-05-15T05:59:00Z')).toBe(true);
  });

  it('TSE: 06:00 UTC = 15:00 JST close → false', () => {
    expect(isInExchangeSession('7203.T', '2026-05-15T06:00:00Z')).toBe(false);
  });

  // HKEX: 9:30-16:00 HKT. HKT = UTC+8. 9:30 HKT = 01:30 UTC.
  it('HKEX: 01:30 UTC = 9:30 HKT → true', () => {
    expect(isInExchangeSession('0700.HK', '2026-05-15T01:30:00Z')).toBe(true);
  });

  it('HKEX: 01:29 UTC → false (before open)', () => {
    expect(isInExchangeSession('0700.HK', '2026-05-15T01:29:00Z')).toBe(false);
  });

  // KRX (KOSPI): 9:00-15:30 KST = UTC+9. 9:00 KST = 00:00 UTC.
  it('KRX KOSPI: 00:00 UTC = 9:00 KST → true', () => {
    expect(isInExchangeSession('005930.KO', '2026-05-15T00:00:00Z')).toBe(true);
  });

  it('KRX KOSDAQ: 06:30 UTC = 15:30 KST close → false', () => {
    expect(isInExchangeSession('094360.KQ', '2026-05-15T06:30:00Z')).toBe(false);
  });

  // ASX Sydney: 10:00-16:00 AEDT (UTC+11 summer) / AEST (UTC+10 winter)
  it('ASX summer (AEDT): 23:00 UTC = 10:00 AEDT next day → true', () => {
    // 2026-01-15 23:00 UTC = 2026-01-16 10:00 AEDT (summer DST in southern hemisphere)
    expect(isInExchangeSession('CCP.AU', '2026-01-15T23:00:00Z')).toBe(true);
  });

  it('ASX winter (AEST): 00:00 UTC = 10:00 AEST → true', () => {
    // 2026-07-15 00:00 UTC = 10:00 AEST
    expect(isInExchangeSession('CCP.AU', '2026-07-15T00:00:00Z')).toBe(true);
  });
});

describe('isInExchangeSession — EU exchanges with DST', () => {
  // Paris/Frankfurt CET = UTC+1, CEST = UTC+2 (DST: last Sunday March → last Sunday October)
  // 9:00 CET = 08:00 UTC (winter)
  // 9:00 CEST = 07:00 UTC (summer)

  it('Paris winter CET: 08:00 UTC = 9:00 CET → true', () => {
    expect(isInExchangeSession('MC.PA', '2026-01-15T08:00:00Z')).toBe(true);
  });

  it('Paris summer CEST: 07:00 UTC = 9:00 CEST → true', () => {
    expect(isInExchangeSession('MC.PA', '2026-07-15T07:00:00Z')).toBe(true);
  });

  it('Paris summer CEST: 08:00 UTC = 10:00 CEST mid-session → true', () => {
    expect(isInExchangeSession('MC.PA', '2026-07-15T08:00:00Z')).toBe(true);
  });

  it('Paris summer CEST: 15:30 UTC = 17:30 CEST close → false', () => {
    expect(isInExchangeSession('MC.PA', '2026-07-15T15:30:00Z')).toBe(false);
  });

  it('LSE summer BST: 07:00 UTC = 8:00 BST open → true', () => {
    expect(isInExchangeSession('HSBA.LSE', '2026-07-15T07:00:00Z')).toBe(true);
  });
});

describe('isInExchangeSession — Always-on classes', () => {
  it('crypto .CC always returns true', () => {
    expect(isInExchangeSession('BTC-USD.CC', '2026-05-09T03:00:00Z')).toBe(true);  // Saturday 3am UTC
    expect(isInExchangeSession('ETH-USD.CC', '2026-12-25T12:00:00Z')).toBe(true);  // Christmas
  });

  it('FX .FOREX always returns true', () => {
    expect(isInExchangeSession('EURUSD.FOREX', '2026-05-09T03:00:00Z')).toBe(true);
  });

  it('commodities .COMM always returns true', () => {
    expect(isInExchangeSession('BRENT.COMM', '2026-05-09T03:00:00Z')).toBe(true);
  });

  it('indices .INDX always returns true', () => {
    expect(isInExchangeSession('VIX.INDX', '2026-05-09T03:00:00Z')).toBe(true);
  });
});

describe('isInExchangeSession — Edge cases', () => {
  it('returns false for symbol without suffix', () => {
    // 'AAPL' or 'BTCUSDT' without dot — conservative false
    expect(isInExchangeSession('AAPL', '2026-05-15T17:00:00Z')).toBe(false);
    expect(isInExchangeSession('BTCUSDT', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('returns false for empty symbol', () => {
    expect(isInExchangeSession('', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('returns false for unknown suffix', () => {
    expect(isInExchangeSession('FOO.UNKNOWN', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('accepts Date object', () => {
    expect(isInExchangeSession('AAPL.US', new Date('2026-05-15T17:00:00Z'))).toBe(true);
  });

  it('accepts epoch seconds', () => {
    const ms = new Date('2026-05-15T17:00:00Z').getTime();
    expect(isInExchangeSession('AAPL.US', Math.floor(ms / 1000))).toBe(true);
  });

  it('accepts epoch milliseconds', () => {
    const ms = new Date('2026-05-15T17:00:00Z').getTime();
    expect(isInExchangeSession('AAPL.US', ms)).toBe(true);
  });

  it('returns false for invalid date string', () => {
    expect(isInExchangeSession('AAPL.US', 'not-a-date')).toBe(false);
  });
});
