/**
 * Bug #R9 / #R10 — Tests universe pre-filter (session + blacklist).
 *
 * Couverture :
 *   - marketForSymbol mapping (suffix → class)
 *   - isMarketOpenForClass (heure UTC + weekend)
 *   - DEAD_NSE_TICKERS (9 tickers statiques)
 *   - filterTickersForFetch combinaisons (R9 spec : Asia fermé, EU ouvert, US fermé, crypto, mix)
 */

import {
  DEAD_NSE_TICKERS,
  filterTickersForFetch,
  formatFilterLog,
  isMarketOpenForClass,
  marketForSymbol,
} from '../session-filter';

// Note: `export {}` n'est pas requis ici — le file importe déjà → ES module.

/** Construit une Date Mon 12/05/2025 (week-day) à H:M UTC. */
function utcOn(hour: number, minute = 0): Date {
  // 2025-05-12 = lundi (day=1)
  return new Date(Date.UTC(2025, 4, 12, hour, minute, 0));
}

const SATURDAY_NOON = new Date(Date.UTC(2025, 4, 17, 12, 0, 0)); // 17/05/2025 = samedi

describe('session-filter helpers', () => {
  describe('marketForSymbol', () => {
    it.each([
      ['AAPL', 'us'],
      ['AAPL.US', 'us'],
      ['SHOP.TO', 'us'],
      ['BMW.DE', 'eu'],
      ['BMW.XETRA', 'eu'],
      ['VOD.LSE', 'eu'],
      ['VOD.L', 'eu'],
      ['MC.PA', 'eu'],
      ['ASML.AS', 'eu'],
      ['SAMSUNG.KO', 'asia'],
      ['005930.KO', 'asia'],
      ['045390.KQ', 'asia'],
      ['7203.T', 'asia'],
      ['7203.TSE', 'asia'],
      ['0700.HK', 'asia'],
      ['600519.SHG', 'asia'],
      ['002371.SHE', 'asia'],
      ['BHEL.NSE', 'asia'],
      ['BHP.AU', 'asia'],
      ['BTCUSDT', 'crypto'],
      ['ETHUSDT', 'crypto'],
      ['SOLUSDT', 'crypto'],
      ['BTC-USD.CC', 'crypto'],
      ['EURUSD.FOREX', null],
    ])('maps %s → %s', (symbol, expected) => {
      expect(marketForSymbol(symbol)).toBe(expected);
    });

    it('returns null for empty / unknown', () => {
      expect(marketForSymbol('')).toBeNull();
      expect(marketForSymbol('FOO.WTF')).toBeNull();
    });
  });

  describe('isMarketOpenForClass', () => {
    it('US: open at 15:00 UTC (RTH), closed at 22:00 UTC, closed at 13:00 UTC pre-market', () => {
      expect(isMarketOpenForClass('us', utcOn(15, 0))).toBe(true);
      expect(isMarketOpenForClass('us', utcOn(22, 0))).toBe(false);
      expect(isMarketOpenForClass('us', utcOn(13, 0))).toBe(false);
    });

    it('EU: open at 9:30 UTC, closed at 17:00 UTC', () => {
      expect(isMarketOpenForClass('eu', utcOn(9, 30))).toBe(true);
      expect(isMarketOpenForClass('eu', utcOn(17, 0))).toBe(false);
    });

    it('Asia: open at 02:00 UTC, closed at 11:40 UTC (R9 prod scenario)', () => {
      expect(isMarketOpenForClass('asia', utcOn(2, 0))).toBe(true);
      expect(isMarketOpenForClass('asia', utcOn(11, 40))).toBe(false);
    });

    it('Crypto: always open', () => {
      expect(isMarketOpenForClass('crypto', utcOn(0, 0))).toBe(true);
      expect(isMarketOpenForClass('crypto', utcOn(23, 59))).toBe(true);
      expect(isMarketOpenForClass('crypto', SATURDAY_NOON)).toBe(true);
    });

    it('US/EU/Asia closed on Saturday (weekend gate)', () => {
      expect(isMarketOpenForClass('us', SATURDAY_NOON)).toBe(false);
      expect(isMarketOpenForClass('eu', SATURDAY_NOON)).toBe(false);
      expect(isMarketOpenForClass('asia', SATURDAY_NOON)).toBe(false);
    });
  });

  describe('DEAD_NSE_TICKERS (alias) + DEAD_TICKERS_STATIC', () => {
    it('total = 63 tickers (23 PR #337 + 31 PR #355 + 9 PR #363)', () => {
      expect(DEAD_NSE_TICKERS.size).toBe(63);
    });

    it.each([
      'BHEL.NSE', 'CESC.NSE', 'GHCL.NSE', 'HEG.NSE', 'IGPL.NSE',
      'NESCO.NSE', 'NITCO.NSE', 'NOCIL.NSE', 'SOTL.NSE',
    ])('contains legacy .NSE %s', (ticker) => {
      expect(DEAD_NSE_TICKERS.has(ticker)).toBe(true);
    });

    it.each([
      '000500.KO', '003550.KO', '005070.KO', '005300.KO', '016360.KO',
      '093370.KO', '039830.KQ', '045390.KQ', '047770.KQ', '059120.KQ',
      '088800.KQ', '094360.KQ', '200710.KQ',
    ])('contains asia empty-response %s (PR #337)', (ticker) => {
      expect(DEAD_NSE_TICKERS.has(ticker)).toBe(true);
    });

    it('contient le saigneur 222420.KQ (PR #337)', () => {
      expect(DEAD_NSE_TICKERS.has('222420.KQ')).toBe(true);
    });

    it('NE contient PAS 002900.KO (seul .KO rentable +$177/30j)', () => {
      expect(DEAD_NSE_TICKERS.has('002900.KO')).toBe(false);
    });

    it('NE contient PAS 005930.KO (Samsung, contrôle)', () => {
      expect(DEAD_NSE_TICKERS.has('005930.KO')).toBe(false);
    });

    it('alias DEAD_NSE_TICKERS pointe vers DEAD_TICKERS_STATIC (backward-compat)', () => {
      // Vérification de l'alias deprecated : même référence d'objet
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DEAD_TICKERS_STATIC } = require('../session-filter');
      expect(DEAD_NSE_TICKERS).toBe(DEAD_TICKERS_STATIC);
    });

    // PR #355 — 31 tickers ajoutés (audit Supabase 19/05/2026 9h30)
    it.each([
      // Asia KOSPI/KOSDAQ (12)
      '003690.KO', '001450.KO',
      '080220.KQ', '066430.KQ', '412350.KQ', '274090.KQ',
      '211270.KQ', '027360.KQ', '036930.KQ', '446540.KQ',
      '032580.KQ', '092190.KQ',
      // Asia SHG/SHE (4)
      '600500.SHG', '600578.SHG', '002421.SHE', '300259.SHE',
      // Asia saigneurs (4)
      '295310.KQ', '100790.KQ', '321370.KQ', '601678.SHG',
      // EU LSE (4)
      'SCLP.LSE', 'PANR.LSE', 'ABDN.LSE', 'GAMA.LSE',
      // US/TO (7)
      'ENPH.US', 'PZZA.US', 'TTGT.US', 'AXTI.US',
      'BLDP.TO', 'KEY.TO', 'SDE.TO',
    ])('PR #355 blacklist statique %s', (ticker) => {
      expect(DEAD_NSE_TICKERS.has(ticker)).toBe(true);
    });

    it('PR #355 — 002900.KO toujours autorisé (preuve TP +$177/30j)', () => {
      expect(DEAD_NSE_TICKERS.has('002900.KO')).toBe(false);
    });

    // PR #363 — 9 tickers US ajoutés (audit 19/05/2026 19h UTC)
    // 6 QW#6 deja bloqués ouverture + 3 saigneurs US 0 productivité
    it.each([
      // QW#6 ouverture-bloqués, ajout fetch-level (6)
      'PODD.US', 'CGNX.US', 'ORA.US', 'QCOM.US', 'ST.US', 'PRU.US',
      // Saigneurs US non-QW#6 (3)
      'EXLS.US', 'CTSH.US', 'KBR.US',
    ])('PR #363 blacklist statique %s', (ticker) => {
      expect(DEAD_NSE_TICKERS.has(ticker)).toBe(true);
    });

    it('PR #363 — DXCM.US toujours autorisé (productif +$20.58/30j 1 TP)', () => {
      expect(DEAD_NSE_TICKERS.has('DXCM.US')).toBe(false);
    });
  });
});

describe('filterTickersForFetch — R9/R10 spec cases', () => {
  it('Asia closed at 11:40 UTC → 0 fetch for .KQ/.KO/.SHE (US still pre-RTH)', () => {
    const r = filterTickersForFetch(
      // PR #337 : `005930.KO` (Samsung) + `002900.KO` (seul rentable) hors static
      // blacklist, donc bien droppés en session_closed et non en nse_blacklisted.
      ['002371.SHE', '005930.KO', '002900.KO', 'AAPL', 'BTCUSDT'],
      { now: utcOn(11, 40) },
    );
    // 11:40 UTC : Asia fermé (after 08:00), US pre-RTH (14:30 only), seul crypto ouvert
    expect(r.kept).toEqual(['BTCUSDT']);
    expect(r.droppedSessionClosed.asia).toEqual([
      '002371.SHE', '005930.KO', '002900.KO',
    ]);
    expect(r.droppedSessionClosed.us).toEqual(['AAPL']);
  });

  it('Asia closed at 15:00 UTC (US RTH open) → 0 fetch Asia, US kept', () => {
    const r = filterTickersForFetch(
      ['002371.SHE', 'AAPL', 'BTCUSDT'],
      { now: utcOn(15, 0) },
    );
    expect(r.kept.sort()).toEqual(['AAPL', 'BTCUSDT']);
    expect(r.droppedSessionClosed.asia).toEqual(['002371.SHE']);
  });

  it('EU open at 09:30 UTC → fetch for .PA/.L/.DE', () => {
    const r = filterTickersForFetch(
      ['MC.PA', 'VOD.L', 'BMW.DE'],
      { now: utcOn(9, 30) },
    );
    expect(r.kept).toEqual(['MC.PA', 'VOD.L', 'BMW.DE']);
    expect(r.droppedSessionClosed.eu).toEqual([]);
  });

  it('US closed at 23:00 UTC → 0 fetch for bare US tickers', () => {
    const r = filterTickersForFetch(
      ['AAPL', 'MSFT', 'GOOG.US'],
      { now: utcOn(23, 0) },
    );
    expect(r.kept).toEqual([]);
    expect(r.droppedSessionClosed.us).toEqual(['AAPL', 'MSFT', 'GOOG.US']);
  });

  it('Crypto always passes (24/7)', () => {
    for (const hour of [0, 3, 11, 15, 22, 23]) {
      const r = filterTickersForFetch(['BTCUSDT'], { now: utcOn(hour, 0) });
      expect(r.kept).toEqual(['BTCUSDT']);
    }
    // Saturday too
    const r = filterTickersForFetch(['ETHUSDT'], { now: SATURDAY_NOON });
    expect(r.kept).toEqual(['ETHUSDT']);
  });

  it('Mix Asia closed + EU open → only EU passes (US bare ticker filtered if US closed)', () => {
    // 09:30 UTC : Asia closed (after 08:00), EU open, US closed (before 14:30)
    const r = filterTickersForFetch(
      ['MC.PA', 'AAPL', '005930.KO', 'BTCUSDT'],
      { now: utcOn(9, 30) },
    );
    expect(r.kept.sort()).toEqual(['BTCUSDT', 'MC.PA']);
    expect(r.droppedSessionClosed.us).toEqual(['AAPL']);
    expect(r.droppedSessionClosed.asia).toEqual(['005930.KO']);
  });

  it('R9 prod scenario reproduction : 11:40 UTC, mix universe', () => {
    // Reproduit la séquence prod 15/05/2025 11:40 UTC (Asia closed, US pre-RTH, EU open).
    // PR #337 : substitution des tickers asia par des entrées hors static blacklist
    // (`005930.KO` Samsung, `002900.KO` rentable) — sinon ils tombent en
    // droppedNseBlacklist au lieu de droppedSessionClosed.asia.
    const symbols = [
      '002371.SHE', '005930.KO', '002900.KO', // 3 Asia → drop
      'MC.PA', 'BMW.DE',                        // 2 EU → keep (open)
      'AAPL',                                   // US closed pre-RTH → drop
      'BTCUSDT', 'ETHUSDT',                     // 2 crypto → keep
    ];
    const r = filterTickersForFetch(symbols, { now: utcOn(11, 40) });
    expect(r.kept.sort()).toEqual(['BMW.DE', 'BTCUSDT', 'ETHUSDT', 'MC.PA']);
    expect(r.droppedSessionClosed.asia).toHaveLength(3);
    expect(r.droppedSessionClosed.us).toEqual(['AAPL']);
  });

  it('static blacklist : 9 dead NSE tickers filtered when enabled (default)', () => {
    const r = filterTickersForFetch(
      ['BHEL.NSE', 'CESC.NSE', 'AAPL'],
      { now: utcOn(15, 0) }, // US open
    );
    expect(r.kept).toEqual(['AAPL']);
    expect(r.droppedStaticBlacklist).toEqual(['BHEL.NSE', 'CESC.NSE']);
  });

  it('static blacklist disabled → NSE tickers fall through to session check', () => {
    const r = filterTickersForFetch(
      ['BHEL.NSE', 'AAPL'],
      { now: utcOn(15, 0), staticBlacklistEnabled: false },
    );
    // NSE = asia ; 15:00 UTC Asia closed → drop par session
    expect(r.droppedStaticBlacklist).toEqual([]);
    expect(r.droppedSessionClosed.asia).toEqual(['BHEL.NSE']);
  });

  it('dynamic blacklist callback respected (after static check)', () => {
    const r = filterTickersForFetch(
      ['XYZ.NSE', 'AAPL'],
      {
        now: utcOn(15, 0),
        isDynamicallyBlacklisted: (s) => s === 'XYZ.NSE',
      },
    );
    expect(r.droppedDynamicBlacklist).toEqual(['XYZ.NSE']);
    expect(r.kept).toEqual(['AAPL']);
  });

  it('universe toggle : universeUs=false drops all US even when market open', () => {
    const r = filterTickersForFetch(
      ['AAPL', 'MC.PA', 'BTCUSDT'],
      { now: utcOn(15, 0), universeAllowed: { us: false, eu: true, crypto: true } },
    );
    expect(r.kept.sort()).toEqual(['BTCUSDT', 'MC.PA']);
    expect(r.droppedUniverseToggle).toEqual(['AAPL']);
  });

  it('unknown market symbol → kept (conservative)', () => {
    const r = filterTickersForFetch(
      ['EURUSD.FOREX', 'AAPL'],
      { now: utcOn(15, 0) },
    );
    expect(r.kept.sort()).toEqual(['AAPL', 'EURUSD.FOREX']);
    expect(r.passedUnknownMarket).toEqual(['EURUSD.FOREX']);
  });

  it('weekend : Asia/EU/US all dropped, crypto kept', () => {
    const r = filterTickersForFetch(
      ['AAPL', 'MC.PA', '005930.KO', 'BTCUSDT'],
      { now: SATURDAY_NOON },
    );
    expect(r.kept).toEqual(['BTCUSDT']);
    expect(r.droppedSessionClosed.us).toEqual(['AAPL']);
    expect(r.droppedSessionClosed.eu).toEqual(['MC.PA']);
    expect(r.droppedSessionClosed.asia).toEqual(['005930.KO']);
  });

  it('empty input → empty kept', () => {
    const r = filterTickersForFetch([], { now: utcOn(15, 0) });
    expect(r.kept).toEqual([]);
  });
});

describe('formatFilterLog', () => {
  it('formats counts with multiplier (R9 example : 17 Asia × 1 = 17 saved)', () => {
    const symbols = [
      // PR #337 : `000500.KO` et `045390.KQ` désormais dans static blacklist —
      // substitution par des tickers hors blacklist pour que le comptage reste
      // `3 asia` et non `1 asia, 2 nse_blacklisted`.
      '002371.SHE', '005930.KO', '002900.KO',
      'AAPL',
    ];
    const r = filterTickersForFetch(symbols, { now: new Date(Date.UTC(2025, 4, 12, 11, 40)) });
    const log = formatFilterLog(r, 1);
    expect(log).toMatch(/SESSION_FILTER/);
    expect(log).toMatch(/3 asia/);
    expect(log).toMatch(/1 us/);
    expect(log).toMatch(/saved ~4 EODHD calls/);
  });

  it('counts blacklisted separately', () => {
    const r = filterTickersForFetch(
      ['BHEL.NSE', 'CESC.NSE', 'AAPL'],
      { now: new Date(Date.UTC(2025, 4, 12, 15, 0)) },
    );
    expect(formatFilterLog(r, 1)).toMatch(/2 nse_blacklisted/);
  });

  it('returns 0 saved when nothing skipped', () => {
    const r = filterTickersForFetch(['BTCUSDT'], { now: new Date(Date.UTC(2025, 4, 12, 15, 0)) });
    expect(formatFilterLog(r, 1)).toMatch(/saved ~0 EODHD calls/);
  });
});
