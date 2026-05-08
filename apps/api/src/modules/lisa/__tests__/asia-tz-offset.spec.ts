/**
 * PR #288 — Tests offset detection + correction TZ Asia/Pacific.
 *
 * Bug confirmé prod 08/05/2026 : EODHD intraday encode les timestamps des
 * candles en local exchange time treated as UTC. Pour 300161.SHE :
 *   - Candle réelle close 15:00 CST = 07:00 UTC May 8
 *   - EODHD timestamp = May 7 23:00 UTC (= 15:00 CST naïvement encodé UTC)
 * → notre filter `c.timestamp >= startTs` (real UTC) rejetait tout.
 *
 * Fix : ajouter offset (8h SHE/SHG/HK, 9h KO/KQ/T, 10h AU) avant filter.
 */
import {
  getExchangeUtcOffsetSec,
} from '../services/gainers-user-shadow.service';

describe('PR #288 — getExchangeUtcOffsetSec', () => {
  it('returns 8h for China exchanges (SHE, SHG, HK)', () => {
    expect(getExchangeUtcOffsetSec('300161.SHE')).toBe(8 * 3600);
    expect(getExchangeUtcOffsetSec('600519.SHG')).toBe(8 * 3600);
    expect(getExchangeUtcOffsetSec('0700.HK')).toBe(8 * 3600);
  });

  it('returns 9h for Korea/Japan (KO, KQ, T)', () => {
    expect(getExchangeUtcOffsetSec('005930.KO')).toBe(9 * 3600);
    expect(getExchangeUtcOffsetSec('013310.KQ')).toBe(9 * 3600);
    expect(getExchangeUtcOffsetSec('7203.T')).toBe(9 * 3600);
  });

  it('returns 10h for Australia (AU)', () => {
    expect(getExchangeUtcOffsetSec('CCP.AU')).toBe(10 * 3600);
  });

  it('returns 0 for US/EU (no offset needed)', () => {
    expect(getExchangeUtcOffsetSec('AAPL.US')).toBe(0);
    expect(getExchangeUtcOffsetSec('NYT.US')).toBe(0);
    expect(getExchangeUtcOffsetSec('AAZ.LSE')).toBe(0);
    expect(getExchangeUtcOffsetSec('BMW.XETRA')).toBe(0);
    expect(getExchangeUtcOffsetSec('AC.PA')).toBe(0);
  });

  it('returns 0 for null/undefined/empty/no-suffix', () => {
    expect(getExchangeUtcOffsetSec(null)).toBe(0);
    expect(getExchangeUtcOffsetSec(undefined)).toBe(0);
    expect(getExchangeUtcOffsetSec('')).toBe(0);
    expect(getExchangeUtcOffsetSec('NOSUFFIX')).toBe(0);
  });

  it('handles lowercase suffix (defensive)', () => {
    expect(getExchangeUtcOffsetSec('300161.she')).toBe(8 * 3600);
    expect(getExchangeUtcOffsetSec('aapl.us')).toBe(0);
  });
});

describe('PR #288 — Offset shift math validation', () => {
  it('candle encoded in CST (-8h vs real UTC) shifts back to real UTC after offset+', () => {
    // Real UTC : 06:30 today = exemple X
    const realUtcSec = Math.floor(Date.now() / 1000) - 60;
    // EODHD encoderait cette candle Shenzhen comme "real - 8h"
    const encodedByEodhd = realUtcSec - 8 * 3600;
    // Notre fix : timestamp + offset
    const corrected = encodedByEodhd + getExchangeUtcOffsetSec('300161.SHE');
    expect(corrected).toBe(realUtcSec);
  });

  it('candle for KOSDAQ shifts by +9h', () => {
    const realUtcSec = 1778166000;
    const encodedByEodhd = realUtcSec - 9 * 3600;
    const corrected = encodedByEodhd + getExchangeUtcOffsetSec('013310.KQ');
    expect(corrected).toBe(realUtcSec);
  });

  it('US ticker timestamps remain unchanged (offset=0)', () => {
    const ts = 1778166000;
    expect(ts + getExchangeUtcOffsetSec('AAPL.US')).toBe(ts);
  });

  it('regression : real-prod values from PR #287 SQL diag — Shenzhen close TODAY', () => {
    // Source: SQL diag user 08/05/2026 — 300161.SHE step4_last = 1778137200
    const step4LastEncoded = 1778137200;
    const correctedToRealUtc = step4LastEncoded + getExchangeUtcOffsetSec('300161.SHE');
    // = 1778137200 + 28800 = 1778166000 = May 8 06:20 UTC (just before Shenzhen close at 07:00)
    expect(correctedToRealUtc).toBe(1778166000);
  });

  it('regression : real-prod KOSDAQ — 013310.KQ step4_last shifts to KOSDAQ close TODAY', () => {
    const step4LastEncoded = 1778133600;
    const correctedToRealUtc = step4LastEncoded + getExchangeUtcOffsetSec('013310.KQ');
    // = 1778133600 + 32400 = 1778166000 = same May 8 06:20 UTC (just before KOSDAQ close at 06:30)
    expect(correctedToRealUtc).toBe(1778166000);
  });
});
