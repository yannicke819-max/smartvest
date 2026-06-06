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
  isKnownMarketClosed,
  extractSuffix,
  minutesToExchangeClose,
  minutesSinceExchangeOpen,
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

describe('isInExchangeSession — TSX (.TO) Toronto', () => {
  // TSX: 9:30-16:00 ET, same as NYSE. Follows NYSE holidays in v1 mapping.

  it('TSX 13:30 UTC = 9:30 EDT exact open → true', () => {
    expect(isInExchangeSession('SHOP.TO', '2026-05-15T13:30:00Z')).toBe(true);
  });

  it('TSX 20:00 UTC = 16:00 EDT exact close → false (exclusive)', () => {
    expect(isInExchangeSession('SHOP.TO', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('TSX winter EST: 14:30 UTC = 9:30 EST → true', () => {
    expect(isInExchangeSession('BB.TO', '2026-02-10T14:30:00Z')).toBe(true);
  });

  it('TSX Saturday during would-be RTH → false', () => {
    expect(isInExchangeSession('SHOP.TO', '2026-05-09T17:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — NSE (.NSE) India', () => {
  // NSE: 9:15-15:30 IST = UTC+5:30 (no DST in India)
  // 9:15 IST = 03:45 UTC, 15:30 IST = 10:00 UTC

  it('NSE 03:45 UTC = 9:15 IST exact open → true', () => {
    expect(isInExchangeSession('BHEL.NSE', '2026-05-15T03:45:00Z')).toBe(true);
  });

  it('NSE 03:44 UTC = 9:14 IST → false (1min before open)', () => {
    expect(isInExchangeSession('BHEL.NSE', '2026-05-15T03:44:00Z')).toBe(false);
  });

  it('NSE 10:00 UTC = 15:30 IST exact close → false (exclusive)', () => {
    expect(isInExchangeSession('HEG.NSE', '2026-05-15T10:00:00Z')).toBe(false);
  });

  it('NSE 09:59 UTC = 15:29 IST → true (1min before close)', () => {
    expect(isInExchangeSession('HEG.NSE', '2026-05-15T09:59:00Z')).toBe(true);
  });

  it('NSE Sunday → false', () => {
    expect(isInExchangeSession('BHEL.NSE', '2026-05-10T06:00:00Z')).toBe(false);
  });

  it('BSE same hours as NSE: 06:00 UTC = 11:30 IST mid-session → true', () => {
    expect(isInExchangeSession('RELIANCE.BSE', '2026-05-15T06:00:00Z')).toBe(true);
  });
});

describe('isInExchangeSession — NYSE Holidays 2026', () => {
  // 13:30-20:00 UTC = 9:30-16:00 EDT/EST RTH on a normal weekday.
  // On a holiday, even if the wall clock is in RTH, returns false.

  it('Christmas Dec 25 2026 (Friday) at 17:00 UTC RTH hour → false (closed)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-12-25T17:00:00Z')).toBe(false);
  });

  it('Independence Day observed July 3 2026 (Friday) at 17:00 UTC → false', () => {
    // July 4 2026 = Saturday → observed July 3 (Friday)
    expect(isInExchangeSession('AAPL.US', '2026-07-03T17:00:00Z')).toBe(false);
  });

  it('Thanksgiving Nov 26 2026 (Thursday) at 17:00 UTC → false', () => {
    expect(isInExchangeSession('AAPL.US', '2026-11-26T17:00:00Z')).toBe(false);
  });

  it('Day before Christmas Dec 24 2026 (Thursday) at 17:00 UTC → true (still trading)', () => {
    // Note: NYSE closes early at 13:00 ET on Christmas Eve, but v1 doesn't
    // model early closes. 17:00 UTC = 13:00 EDT borderline. Test verifies
    // v1 limitation (full RTH assumed). Future PR : early-close support.
    expect(isInExchangeSession('AAPL.US', '2026-12-24T17:00:00Z')).toBe(true);
  });

  it('Day after Thanksgiving Nov 27 2026 (Friday) at 17:00 UTC → true', () => {
    // NYSE has early close (13:00 ET) day after Thanksgiving but v1 ignores.
    expect(isInExchangeSession('AAPL.US', '2026-11-27T17:00:00Z')).toBe(true);
  });

  it('Holiday list does NOT apply to TSX (.TO) — known bug v1', () => {
    // TSX a son propre calendar (Victoria Day, Canada Day, etc.) très
    // différent de NYSE. Ancien héritage NYSE était faux à ~12 jours/an.
    // V1 : pas de holiday handling pour .TO → Christmas Dec 25 13:00 EDT
    // est classé "in session" (faux positif rare 1×/an, < ancien biais).
    // Cf. follow-up PR #297 pour calendar TSX dédié.
    expect(isInExchangeSession('SHOP.TO', '2026-12-25T17:00:00Z')).toBe(true);
  });

  it('Holiday list does NOT apply to Asia exchanges (still v1 limitation)', () => {
    // 7203.T (Tokyo) on Dec 25 = normal trading day in Japan
    // Dec 25 2026 = Friday, JST 9:00 = 00:00 UTC Friday Dec 25
    expect(isInExchangeSession('7203.T', '2026-12-25T01:00:00Z')).toBe(true);
  });
});

/**
 * Extended holiday support 25/05/2026 (post-triple-holiday incident).
 * Couvre LSE / Euronext / SIX / XETRA — calendriers ajoutés après détection
 * que le scanner a ouvert des positions EU sur prix EOD vendredi le 25/05/2026
 * (Memorial Day US + Spring Bank Holiday UK + Whit Monday EU/CH).
 */
describe('isInExchangeSession — Extended EU Holidays 2026', () => {
  it('25/05/2026 Whit Monday : Euronext Paris CLOSED', () => {
    // Lundi 25 mai 2026, 10:00 UTC = 12:00 Paris CEST → wall clock dans session mais férié
    expect(isInExchangeSession('NANO.PA', '2026-05-25T10:00:00Z')).toBe(false);
  });

  it('25/05/2026 Whit Monday : Euronext Amsterdam CLOSED', () => {
    expect(isInExchangeSession('ASML.AS', '2026-05-25T10:00:00Z')).toBe(false);
  });

  it('25/05/2026 Spring Bank Holiday UK : LSE CLOSED', () => {
    // .LSE et .L
    expect(isInExchangeSession('RMV.LSE', '2026-05-25T10:00:00Z')).toBe(false);
    expect(isInExchangeSession('VOD.L', '2026-05-25T10:00:00Z')).toBe(false);
  });

  it('25/05/2026 Whit Monday : SIX Swiss CLOSED', () => {
    expect(isInExchangeSession('AMS.SW', '2026-05-25T10:00:00Z')).toBe(false);
  });

  it('25/05/2026 Whit Monday : XETRA CLOSED', () => {
    expect(isInExchangeSession('SAP.XETRA', '2026-05-25T10:00:00Z')).toBe(false);
    expect(isInExchangeSession('SAP.DE', '2026-05-25T10:00:00Z')).toBe(false);
  });

  it('25/05/2026 Memorial Day : NYSE CLOSED (already covered avant)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-25T15:00:00Z')).toBe(false);
  });

  it('26/05/2026 (lendemain Whit Monday) : Euronext OUVERT', () => {
    // Mardi 26 mai 2026 = jour ouvré normal
    expect(isInExchangeSession('NANO.PA', '2026-05-26T10:00:00Z')).toBe(true);
  });

  it('22/05/2026 (vendredi avant Whit Monday) : marchés OUVERTS', () => {
    expect(isInExchangeSession('NANO.PA', '2026-05-22T10:00:00Z')).toBe(true);
    expect(isInExchangeSession('RMV.LSE', '2026-05-22T10:00:00Z')).toBe(true);
    expect(isInExchangeSession('AMS.SW', '2026-05-22T10:00:00Z')).toBe(true);
  });

  it('Good Friday 03/04/2026 : LSE + Euronext + SIX + XETRA tous CLOSED', () => {
    expect(isInExchangeSession('RMV.LSE', '2026-04-03T10:00:00Z')).toBe(false);
    expect(isInExchangeSession('NANO.PA', '2026-04-03T10:00:00Z')).toBe(false);
    expect(isInExchangeSession('AMS.SW', '2026-04-03T10:00:00Z')).toBe(false);
    expect(isInExchangeSession('SAP.XETRA', '2026-04-03T10:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — Cross-TZ weekend boundary (V2)', () => {
  // CRITIQUE : le check weekend doit utiliser la TZ de l'exchange, PAS UTC.
  // Exemple bug potentiel : Sunday 23:00 UTC = Monday 08:00 JST.
  // Si check weekend en UTC → returns false (Sunday) → bug : on skip
  // faussement la session TSE Monday matin.
  // Si check weekend en exchange-TZ → Monday in JST → continue, hour check
  //  → 08:00 < 09:00 (TSE open) → false (correct, before open).

  it('Sunday 23:00 UTC = Monday 08:00 JST → false (before TSE 09:00 open)', () => {
    expect(isInExchangeSession('7203.T', '2026-05-10T23:00:00Z')).toBe(false);
  });

  it('Monday 00:00 UTC = Monday 09:00 JST → true (TSE open exact)', () => {
    expect(isInExchangeSession('7203.T', '2026-05-11T00:00:00Z')).toBe(true);
  });

  it('Sunday 14:30 UTC = Sunday 23:30 JST → false (Sunday in Tokyo)', () => {
    // Critical : si on faisait le check weekend en UTC, ça retournerait false
    // pour la BONNE raison (Sunday). Mais c'est aussi false en JST (Sunday).
    // Test confirme cohérence both-ways.
    expect(isInExchangeSession('7203.T', '2026-05-10T14:30:00Z')).toBe(false);
  });

  it('Friday 23:30 UTC = Saturday 08:30 JST → false (Saturday in Tokyo)', () => {
    // BUG TRAP : UTC weekday=Friday (=5), JST weekday=Saturday (=6).
    // Si check weekend en UTC → returns true → BUG (TSE fermé samedi).
    // Notre helper utilise session.tz → correct false.
    expect(isInExchangeSession('7203.T', '2026-05-15T23:30:00Z')).toBe(false);
  });

  it('Saturday 23:30 UTC = Sunday 08:30 JST → false (Sunday in Tokyo)', () => {
    expect(isInExchangeSession('7203.T', '2026-05-16T23:30:00Z')).toBe(false);
  });

  it('HKEX: Sunday 17:30 UTC = Monday 01:30 HKT → false (before 09:30 open)', () => {
    expect(isInExchangeSession('0700.HK', '2026-05-10T17:30:00Z')).toBe(false);
  });

  it('HKEX: Monday 01:30 UTC = Monday 09:30 HKT → true (open exact)', () => {
    expect(isInExchangeSession('0700.HK', '2026-05-11T01:30:00Z')).toBe(true);
  });

  it('HKEX: Friday 23:00 UTC = Saturday 07:00 HKT → false (Saturday in HK)', () => {
    // Same trap as TSE : UTC=Friday but HKT=Saturday weekend.
    expect(isInExchangeSession('0700.HK', '2026-05-15T23:00:00Z')).toBe(false);
  });

  it('ASX summer: Sunday 23:00 UTC = Monday 10:00 AEDT → true (open exact)', () => {
    // ASX summer = AEDT (UTC+11) ; Sunday 23:00 UTC = Monday 10:00 AEDT = open.
    // Critical : UTC weekday=Sunday but AEDT weekday=Monday → must NOT skip.
    expect(isInExchangeSession('CCP.AU', '2026-01-04T23:00:00Z')).toBe(true);
  });

  it('ASX summer: Friday 23:00 UTC = Saturday 10:00 AEDT → false (Saturday in Sydney)', () => {
    expect(isInExchangeSession('CCP.AU', '2026-01-09T23:00:00Z')).toBe(false);
  });

  // Cas négatifs explicites — preuve qu'on ne laisse pas passer des faux
  // positifs weekend cross-TZ. Demandés en review pour clore happy path bias.

  it('NEGATIVE: TSE Sunday 14:59 UTC = Sunday 23:59 JST → false (Sunday weekend in JST)', () => {
    // Just before midnight Sunday in Tokyo. UTC = Sunday 14:59. Both UTC and JST
    // are Sunday → weekend. Helper must return false (not let through pre-Monday).
    expect(isInExchangeSession('7203.T', '2026-05-10T14:59:00Z')).toBe(false);
  });

  it('NEGATIVE: KRX Saturday 06:30 UTC = Saturday 15:30 KST → false (Saturday weekend)', () => {
    // Saturday in both UTC and KST. KRX would be at "close time" 15:30 KST
    // on a weekday but Saturday → weekend. Must return false.
    // Note : .KO/.KQ are EODHD suffixes (not Yahoo .KS).
    expect(isInExchangeSession('005930.KO', '2026-05-09T06:30:00Z')).toBe(false);
  });

  it('NEGATIVE: HKEX Sunday 08:00 UTC = Sunday 16:00 HKT → false (Sunday weekend)', () => {
    // Sunday in both UTC and HKT. HKEX would be at "close time" on a weekday
    // but Sunday → weekend. Must return false.
    expect(isInExchangeSession('0700.HK', '2026-05-10T08:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — Borderline near-close (V3)', () => {
  // Capture pendant les dernières minutes de session. Step 0 lets through
  // (in-session). Le sim window T+60min déborde la close → le caller
  // (Yahoo/EODHD) retournera des candles partielles. Le helper SEUL ne
  // sait pas modéliser ça — l'outcome (TIME_LIMIT vs partial fill) est
  // déterminé par walkForward sur les candles forward dispo.

  it('NYSE Friday 19:55 UTC = 15:55 EDT → true (5min before close)', () => {
    // Capture in-session. Step 0 lets through. walkForward verra ~5 candles
    // 19:55-20:00 puis rien après 20:00 (close). Outcome attendu : TIME_LIMIT
    // si ni TP ni SL touché dans ces 5 minutes (cas typique).
    expect(isInExchangeSession('AAPL.US', '2026-05-15T19:55:00Z')).toBe(true);
  });

  it('NYSE Friday 19:59 UTC = 15:59 EDT → true (1min before close)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T19:59:00Z')).toBe(true);
  });

  it('NYSE Friday 20:00 UTC = 16:00 EDT → false (close exact, exclusive)', () => {
    expect(isInExchangeSession('AAPL.US', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('TSE Friday 05:55 UTC = 14:55 JST → true (5min before TSE close 15:00)', () => {
    expect(isInExchangeSession('7203.T', '2026-05-15T05:55:00Z')).toBe(true);
  });

  it('TSE Friday 06:00 UTC = 15:00 JST → false (TSE close exact)', () => {
    expect(isInExchangeSession('7203.T', '2026-05-15T06:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — DST boundary tests per marketplace', () => {
  // Vérification que IANA TZ gère bien DST automatiquement pour TOUS les
  // marketplaces avec DST. Tests par exchange, pas seulement US.
  // Pas de DST en Asie (JST/HKT/KST/SGT/CST/IST tous fixés).

  it('Frankfurt CET winter: 08:00 UTC = 9:00 CET → true', () => {
    expect(isInExchangeSession('BMW.XETRA', '2026-01-15T08:00:00Z')).toBe(true);
  });

  it('Frankfurt CEST summer: 07:00 UTC = 9:00 CEST → true', () => {
    expect(isInExchangeSession('BMW.XETRA', '2026-07-15T07:00:00Z')).toBe(true);
  });

  it('Frankfurt CEST: 06:00 UTC = 8:00 CEST → false (1h before open)', () => {
    expect(isInExchangeSession('BMW.XETRA', '2026-07-15T06:00:00Z')).toBe(false);
  });

  it('Swiss CET winter: 08:00 UTC = 9:00 CET → true', () => {
    expect(isInExchangeSession('NESN.SW', '2026-01-15T08:00:00Z')).toBe(true);
  });

  it('Amsterdam CEST summer: 07:00 UTC = 9:00 CEST → true', () => {
    expect(isInExchangeSession('ASML.AS', '2026-07-15T07:00:00Z')).toBe(true);
  });

  it('TSX summer EDT: 13:30 UTC = 9:30 EDT → true (matches NYSE EDT)', () => {
    expect(isInExchangeSession('SHOP.TO', '2026-07-15T13:30:00Z')).toBe(true);
  });

  it('TSX winter EST: 14:30 UTC = 9:30 EST → true', () => {
    expect(isInExchangeSession('SHOP.TO', '2026-01-15T14:30:00Z')).toBe(true);
  });

  it('ASX summer AEDT: 23:00 UTC = 10:00 AEDT next day → true', () => {
    // 2026-01-04 23:00 UTC = 2026-01-05 10:00 AEDT (Sydney summer DST)
    expect(isInExchangeSession('CCP.AU', '2026-01-04T23:00:00Z')).toBe(true);
  });

  it('ASX winter AEST: 00:00 UTC = 10:00 AEST → true', () => {
    // 2026-07-15 00:00 UTC = 10:00 AEST (Sydney winter, no DST in winter)
    expect(isInExchangeSession('CCP.AU', '2026-07-15T00:00:00Z')).toBe(true);
  });

  // EU DST transitions ≠ US (last Sunday March/October vs 2nd Sun Mar / 1st Sun Nov).
  // 2026 EU DST : Spring forward 2026-03-29 (last Sun March), Fall back 2026-10-25.

  it('Paris pre-EU-DST 2026-03-27 (Fri): 08:00 UTC = 9:00 CET → true (still winter)', () => {
    expect(isInExchangeSession('MC.PA', '2026-03-27T08:00:00Z')).toBe(true);
  });

  it('Paris post-EU-DST 2026-03-30 (Mon): 07:00 UTC = 9:00 CEST → true (after spring forward)', () => {
    expect(isInExchangeSession('MC.PA', '2026-03-30T07:00:00Z')).toBe(true);
  });

  it('LSE post-EU-DST 2026-03-30 (Mon): 07:00 UTC = 8:00 BST → true (open exact)', () => {
    expect(isInExchangeSession('HSBA.LSE', '2026-03-30T07:00:00Z')).toBe(true);
  });

  it('Paris pre-EU-fall-back 2026-10-23 (Fri): 07:00 UTC = 9:00 CEST → true', () => {
    expect(isInExchangeSession('MC.PA', '2026-10-23T07:00:00Z')).toBe(true);
  });

  it('Paris post-EU-fall-back 2026-10-26 (Mon): 08:00 UTC = 9:00 CET → true (back to winter)', () => {
    expect(isInExchangeSession('MC.PA', '2026-10-26T08:00:00Z')).toBe(true);
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

describe('minutesToExchangeClose — force-close per-exchange', () => {
  // Corée (.KO/.KQ) : 09:00-15:30 Asia/Seoul = 00:00-06:30 UTC (KST = UTC+9, pas de DST).
  it('Corée mi-séance (06:00 UTC = 15:00 KST) → 30 min avant close', () => {
    expect(minutesToExchangeClose('005930.KO', '2026-05-22T06:00:00Z')).toBe(30);
  });

  it('Corée juste après cloche (06:31 UTC = 15:31 KST) → null (hors session)', () => {
    expect(minutesToExchangeClose('005930.KO', '2026-05-22T06:31:00Z')).toBeNull();
  });

  it('Corée tôt en séance (04:00 UTC = 13:00 KST) → 150 min avant close', () => {
    expect(minutesToExchangeClose('035720.KQ', '2026-05-22T04:00:00Z')).toBe(150);
  });

  it('Chine (.SHG) à 06:50 UTC = 14:50 Shanghai → 10 min avant close 15:00', () => {
    expect(minutesToExchangeClose('600519.SHG', '2026-05-22T06:50:00Z')).toBe(10);
  });

  it('weekend → null', () => {
    // 2026-05-23 = samedi
    expect(minutesToExchangeClose('005930.KO', '2026-05-23T04:00:00Z')).toBeNull();
  });

  it('crypto / sans suffixe → null (always-on, pas de close)', () => {
    expect(minutesToExchangeClose('BTCUSDT', '2026-05-22T06:00:00Z')).toBeNull();
    expect(minutesToExchangeClose('BTC-USD.CC', '2026-05-22T06:00:00Z')).toBeNull();
  });

  it('suffixe inconnu → null', () => {
    expect(minutesToExchangeClose('XXX.ZZZ', '2026-05-22T06:00:00Z')).toBeNull();
  });
});

describe('minutesSinceExchangeOpen — opening buffer (DST-safe)', () => {
  // 2026-05-22 = été (CEST/BST). EU ouvre 07:00 UTC, pas 08:00 (bug agrégé hiver).
  it('Paris (.PA) été : 09:06 UTC = 11:06 CEST, open 09:00 → 126 min', () => {
    expect(minutesSinceExchangeOpen('MC.PA', '2026-05-22T09:06:00Z')).toBe(126);
  });

  it('LSE (.LSE) été : 09:06 UTC = 10:06 BST, open 08:00 → 126 min', () => {
    expect(minutesSinceExchangeOpen('HSBA.LSE', '2026-05-22T09:06:00Z')).toBe(126);
  });

  it('Paris été à 07:30 UTC = 09:30 CEST → 30 min (buffer 90 bloquerait, vrai open 07:00)', () => {
    expect(minutesSinceExchangeOpen('MC.PA', '2026-05-22T07:30:00Z')).toBe(30);
  });

  it('Corée (.KO) : 06:00 UTC = 15:00 KST, open 09:00 → 360 min', () => {
    expect(minutesSinceExchangeOpen('005930.KO', '2026-05-22T06:00:00Z')).toBe(360);
  });

  it('avant open → null', () => {
    // 06:30 UTC = 08:30 CEST, avant open Paris 09:00
    expect(minutesSinceExchangeOpen('MC.PA', '2026-05-22T06:30:00Z')).toBeNull();
  });

  it('weekend / crypto / suffixe inconnu → null', () => {
    expect(minutesSinceExchangeOpen('MC.PA', '2026-05-23T09:00:00Z')).toBeNull(); // samedi
    expect(minutesSinceExchangeOpen('BTCUSDT', '2026-05-22T09:00:00Z')).toBeNull();
    expect(minutesSinceExchangeOpen('X.ZZZ', '2026-05-22T09:00:00Z')).toBeNull();
  });
});

describe('isKnownMarketClosed — garde anti-gaspillage EODHD (PR #634)', () => {
  // Skip un appel UNIQUEMENT si le marché est connu ET fermé. Fail-open partout
  // ailleurs (invariant "100% fonctionnel" : jamais couper sur un actif non classé).

  // --- Equity connu OUVERT → false (ne pas skip) ---
  it('US en séance (17:00 UTC = 13:00 EDT) → false (ouvert, ne pas skip)', () => {
    expect(isKnownMarketClosed('AAPL.US', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('EU Paris en séance (08:00 UTC été = 10:00 CEST) → false', () => {
    expect(isKnownMarketClosed('MC.PA', '2026-07-15T08:00:00Z')).toBe(false);
  });

  // --- Equity connu FERMÉ → true (skip OK) ---
  it('US week-end (samedi 17:00 UTC) → true (skip)', () => {
    expect(isKnownMarketClosed('AAPL.US', '2026-05-09T17:00:00Z')).toBe(true);
  });

  it('US after-hours (22:00 UTC = 18:00 EDT) → true (skip)', () => {
    expect(isKnownMarketClosed('AAPL.US', '2026-05-15T22:00:00Z')).toBe(true);
  });

  it('US férié Memorial Day 25/05/2026 en heures RTH → true (skip)', () => {
    expect(isKnownMarketClosed('AAPL.US', '2026-05-25T15:00:00Z')).toBe(true);
  });

  it('US férié Christmas 25/12/2026 en heures RTH → true (skip)', () => {
    expect(isKnownMarketClosed('AAPL.US', '2026-12-25T17:00:00Z')).toBe(true);
  });

  it('EU férié Whit Monday 25/05/2026 (Paris) → true (skip)', () => {
    expect(isKnownMarketClosed('NANO.PA', '2026-05-25T10:00:00Z')).toBe(true);
  });

  it('EU férié Good Friday 03/04/2026 (XETRA) → true (skip)', () => {
    expect(isKnownMarketClosed('SAP.XETRA', '2026-04-03T10:00:00Z')).toBe(true);
  });

  it('Asia Tokyo hors séance (10:00 UTC = 19:00 JST) → true (week-end+horaires gardés)', () => {
    expect(isKnownMarketClosed('7203.T', '2026-05-15T10:00:00Z')).toBe(true);
  });

  // --- FAIL-OPEN : jamais skip (invariant "100% fonctionnel") ---
  it('crypto .CC → false (24/7, fail-open) même un samedi', () => {
    expect(isKnownMarketClosed('BTC-USD.CC', '2026-05-09T03:00:00Z')).toBe(false);
  });

  it('Binance pair sans suffixe (BTCUSDT) → false (fail-open)', () => {
    expect(isKnownMarketClosed('BTCUSDT', '2026-05-09T03:00:00Z')).toBe(false);
  });

  it('forex .FOREX → false (fail-open)', () => {
    expect(isKnownMarketClosed('EURUSD.FOREX', '2026-05-09T03:00:00Z')).toBe(false);
  });

  it('CRITIQUE — suffixe equity INCONNU → false (fail-open, ≠ isInExchangeSession)', () => {
    // isInExchangeSession('FOO.ZZZ') = false (fermé/inconnu) MAIS isKnownMarketClosed
    // = false aussi (ne PAS skip) → on préfère un appel de trop qu'un prix manquant.
    expect(isInExchangeSession('FOO.ZZZ', '2026-05-15T17:00:00Z')).toBe(false);
    expect(isKnownMarketClosed('FOO.ZZZ', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('symbole vide → false (fail-open)', () => {
    expect(isKnownMarketClosed('', '2026-05-15T17:00:00Z')).toBe(false);
  });

  it('symbole sans point (AAPL legacy) → false (fail-open)', () => {
    expect(isKnownMarketClosed('AAPL', '2026-05-15T17:00:00Z')).toBe(false);
  });
});

describe('isInExchangeSession — couverture EU étendue (Milan/Madrid/Amsterdam)', () => {
  // été : CET/CEST → 09:00 local = 07:00 UTC. Mi-séance 09:06 UTC = 11:06 local → ouvert.
  it.each(['FCA.MI', 'SAN.MC', 'SAN.BME', 'INGA.AMS'])('%s ouvert mi-séance (09:06 UTC été)', (sym) => {
    expect(isInExchangeSession(sym, '2026-05-22T09:06:00Z')).toBe(true);
  });

  it.each(['FCA.MI', 'SAN.MC', 'INGA.AMS'])('%s fermé à 16:00 UTC (= 18:00 CEST, après close 17:30)', (sym) => {
    expect(isInExchangeSession(sym, '2026-05-22T16:00:00Z')).toBe(false);
  });
});
