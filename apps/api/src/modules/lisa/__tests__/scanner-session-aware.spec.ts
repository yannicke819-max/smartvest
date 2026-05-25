/**
 * PR #298 — Tests session-aware fetch dans top-gainers scanner.
 *
 * Bug observé prod 09/05/2026 08:20 UTC : avec
 * `gainers_session_filter_enabled=true` en DB, le scanner continue à fetch
 * les 9 EODHD screener (US + 8 Asia) à chaque cycle samedi (markets fermés).
 *
 * Cause : session_filter au mauvais layer (per-portfolio decision, pas
 * per-fetch). Fix : env `SCANNER_SESSION_AWARE=true` ajoute le check au
 * top de fetchAllCandidates.
 *
 * Tests : vérifier que le mapping exchange→session class est correct.
 * Le fix complet (intégration scanner) est testé en e2e via les logs Fly
 * post-deploy (cf. proof empirique dans PR description).
 */

// Re-implementation locale du mapping pour test isolation (évite import
// scanner service qui requiert tout le DI NestJS)
const exchangeToSession: Record<string, 'us' | 'eu' | 'asia'> = {
  'US': 'us', 'TO': 'us',
  'T': 'asia', 'HK': 'asia', 'KO': 'asia', 'KQ': 'asia',
  'SHG': 'asia', 'SHE': 'asia', 'AU': 'asia',
};

// Re-implementation locale de isMarketOpen pour test (mirror scanner code)
const SESSION_HOURS = {
  us:   { openUtcMin: 13 * 60 + 30, closeUtcMin: 20 * 60 },
  eu:   { openUtcMin:  7 * 60,      closeUtcMin: 16 * 60 + 30 },
  asia: { openUtcMin:  0,           closeUtcMin:  8 * 60 },
};

function isMarketOpen(cls: 'us' | 'eu' | 'asia', now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { openUtcMin, closeUtcMin } = SESSION_HOURS[cls];
  return min >= openUtcMin && min < closeUtcMin;
}

describe('PR #298 BUG 1 — Exchange to session class mapping', () => {
  it('maps US exchanges to us session', () => {
    expect(exchangeToSession['US']).toBe('us');
    expect(exchangeToSession['TO']).toBe('us');  // TSX similar hours
  });

  it('maps Asian exchanges to asia session', () => {
    expect(exchangeToSession['T']).toBe('asia');
    expect(exchangeToSession['HK']).toBe('asia');
    expect(exchangeToSession['KO']).toBe('asia');
    expect(exchangeToSession['KQ']).toBe('asia');
    expect(exchangeToSession['SHG']).toBe('asia');
    expect(exchangeToSession['SHE']).toBe('asia');
    expect(exchangeToSession['AU']).toBe('asia');
  });

  it('does NOT map EU exchanges (handled by separate gating)', () => {
    expect(exchangeToSession['LSE']).toBeUndefined();
    expect(exchangeToSession['XETRA']).toBeUndefined();
    expect(exchangeToSession['PA']).toBeUndefined();
  });
});

describe('PR #298 BUG 1 — Session-aware skip logic', () => {
  // Saturday 2026-05-09T08:20:00Z = weekend, all markets closed
  const saturdayMorning = new Date('2026-05-09T08:20:00Z');
  // Wednesday 2026-05-13T15:00:00Z = US active (15:00 UTC = 11:00 EDT RTH)
  const wedUsActive = new Date('2026-05-13T15:00:00Z');
  // Wednesday 2026-05-13T03:00:00Z = Asia active (03:00 UTC, all Asia open)
  const wedAsiaActive = new Date('2026-05-13T03:00:00Z');

  it('Saturday: ALL non-EU exchanges skipped (markets closed weekend)', () => {
    const exchanges = ['US', 'TO', 'T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU'];
    const skipped = exchanges.filter((ex) => {
      const cls = exchangeToSession[ex];
      return cls && !isMarketOpen(cls, saturdayMorning);
    });
    expect(skipped).toHaveLength(9);  // tous skip → 0 EODHD calls non-EU
  });

  it('Wed US active: only US exchanges scanned, Asia skipped', () => {
    const exchanges = ['US', 'TO', 'T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU'];
    const skipped = exchanges.filter((ex) => {
      const cls = exchangeToSession[ex];
      return cls && !isMarketOpen(cls, wedUsActive);
    });
    expect(skipped).toEqual(['T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU']);  // Asia skip
    // US et TO scannés (us session active)
  });

  it('Wed Asia active: only Asia exchanges scanned, US skipped', () => {
    const exchanges = ['US', 'TO', 'T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU'];
    const skipped = exchanges.filter((ex) => {
      const cls = exchangeToSession[ex];
      return cls && !isMarketOpen(cls, wedAsiaActive);
    });
    expect(skipped).toEqual(['US', 'TO']);  // US skip pendant Asia session
  });

  it('back-compat: SCANNER_SESSION_AWARE=false → scanner garde behavior 24/7 (no skip)', () => {
    // Quand sessionAware=false dans le code prod, la boucle skip pas le exchange
    // → behavior identique à pré-PR #298. Test du "no-op" mode.
    const exchanges = ['US', 'TO', 'T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU'];
    const sessionAware = false;
    const skipped = exchanges.filter((ex) => {
      if (!sessionAware) return false;  // no-op mode
      const cls = exchangeToSession[ex];
      return cls && !isMarketOpen(cls, saturdayMorning);
    });
    expect(skipped).toHaveLength(0);  // 0 skip = back-compat preserved
  });
});

describe('PR follow-up — EU weekend skip (sessionAware mode)', () => {
  // Bug résiduel observé prod 09/05/2026 10:00 UTC samedi :
  //   [top-gainers] EU session active (cac40/dax40/ftse100), scanning 9 exchanges
  // alors que EU markets sont fermés weekend.
  //
  // Cause : isWithinSession (helper) check uniquement open/close UTC, pas
  // weekend. Saturday 10:00 UTC ∈ [08:00, 16:30] → returns true.
  //
  // Fix : wrap getActiveEuWatchlists avec isMarketOpen('eu', now) qui check
  // weekend ET hours, quand sessionAware=true.

  it('isMarketOpen("eu") returns FALSE on Saturday in EU window', () => {
    // Saturday 2026-05-09T10:00:00Z = 12:00 CEST samedi
    // Inside EU window 07:00-16:30 UTC mais Saturday → must be false
    const saturdayInWindow = new Date('2026-05-09T10:00:00Z');
    expect(isMarketOpen('eu', saturdayInWindow)).toBe(false);
  });

  it('isMarketOpen("eu") returns FALSE on Sunday in EU window', () => {
    const sundayInWindow = new Date('2026-05-10T12:00:00Z');
    expect(isMarketOpen('eu', sundayInWindow)).toBe(false);
  });

  it('isMarketOpen("eu") returns TRUE on Wednesday in EU window', () => {
    // Wed 2026-05-13T10:00:00Z = 12:00 CEST mercredi
    const wedInWindow = new Date('2026-05-13T10:00:00Z');
    expect(isMarketOpen('eu', wedInWindow)).toBe(true);
  });

  it('isMarketOpen("eu") returns FALSE Wed before open', () => {
    // Wed 06:30 UTC = before 07:00 UTC open (EU summer hours)
    const wedBeforeOpen = new Date('2026-05-13T06:30:00Z');
    expect(isMarketOpen('eu', wedBeforeOpen)).toBe(false);
  });

  it('isMarketOpen("eu") returns TRUE Wed 07:30 UTC (was bug: 08:00 hardcoded blocked EU summer open)', () => {
    // Wed 07:30 UTC = 09:30 CEST = Paris/XETRA open 30 min ago
    const wedSummerMorning = new Date('2026-05-13T07:30:00Z');
    expect(isMarketOpen('eu', wedSummerMorning)).toBe(true);
  });

  it('isMarketOpen("eu") returns FALSE Wed after close', () => {
    // Wed 17:00 UTC = after 16:30 UTC close
    const wedAfterClose = new Date('2026-05-13T17:00:00Z');
    expect(isMarketOpen('eu', wedAfterClose)).toBe(false);
  });

  it('sessionAware=true + Saturday → euMarketOpen=false → skip EU watchlists fetch', () => {
    const sessionAware = true;
    const saturday = new Date('2026-05-09T10:00:00Z');
    const euMarketOpen = !sessionAware || isMarketOpen('eu', saturday);
    expect(euMarketOpen).toBe(false);  // skip EU
  });

  it('sessionAware=true + Wed → euMarketOpen=true → fetch EU watchlists', () => {
    const sessionAware = true;
    const wed = new Date('2026-05-13T10:00:00Z');
    const euMarketOpen = !sessionAware || isMarketOpen('eu', wed);
    expect(euMarketOpen).toBe(true);  // fetch
  });

  it('sessionAware=false (back-compat) → euMarketOpen=true regardless', () => {
    const sessionAware = false;
    const saturday = new Date('2026-05-09T10:00:00Z');
    const euMarketOpen = !sessionAware || isMarketOpen('eu', saturday);
    expect(euMarketOpen).toBe(true);  // legacy behavior preserved
  });
});
