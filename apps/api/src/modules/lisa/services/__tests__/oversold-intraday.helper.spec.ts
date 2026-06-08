import {
  analyzeRealtimeRebound,
  passesRealtimeReboundFilter,
  DEFAULT_REALTIME_REBOUND_CONFIG,
} from '../oversold-intraday.helper';

describe('analyzeRealtimeRebound', () => {
  it('calcule reboundFromLow, rangePos et dayChg depuis l’OHLC du jour', () => {
    // SOI.PA 08/06/2026 (données EODHD real-time réelles)
    const a = analyzeRealtimeRebound({ open: 138.15, high: 157.6, low: 137.3, close: 152.85, prevClose: 146.65 });
    expect(a).not.toBeNull();
    expect(a!.reboundFromLowPct).toBeCloseTo(11.32, 1); // (152.85-137.3)/137.3
    expect(a!.rangePosPct).toBeCloseTo(76.6, 0); // (152.85-137.3)/(157.6-137.3)
    expect(a!.dayChgPct).toBeCloseTo(4.23, 1); // (152.85-146.65)/146.65
  });

  it('retourne null si close ou low invalides', () => {
    expect(analyzeRealtimeRebound({ open: 1, high: 1, low: 0, close: 1, prevClose: 1 })).toBeNull();
    expect(analyzeRealtimeRebound({ open: 1, high: 1, low: 1, close: 0, prevClose: 1 })).toBeNull();
  });

  it('rangePos=0 quand high==low (range nul, pas de division par zéro)', () => {
    const a = analyzeRealtimeRebound({ open: 10, high: 10, low: 10, close: 10, prevClose: 9 });
    expect(a!.rangePosPct).toBe(0);
    expect(a!.reboundFromLowPct).toBe(0);
  });
});

describe('passesRealtimeReboundFilter (seuils par défaut: reboundFromLow≥1.5%, rangePos≥50%)', () => {
  const pass = (ohlc: { open: number; high: number; low: number; close: number; prevClose: number }) =>
    passesRealtimeReboundFilter(analyzeRealtimeRebound(ohlc)!, DEFAULT_REALTIME_REBOUND_CONFIG);

  // Régression sur données réelles 08/06/2026 : le gate doit OUVRIR les 3 vrais
  // winners (qui ont continué à monter) et REJETER les 2 faders (qui ont refadé).
  it('OUVRE les winners SOI / IFX / ADYEN', () => {
    expect(pass({ open: 138.15, high: 157.6, low: 137.3, close: 152.85, prevClose: 146.65 }).pass).toBe(true); // SOI
    expect(pass({ open: 74.7, high: 79.58, low: 74.02, close: 78.78, prevClose: 77.3 }).pass).toBe(true); // IFX
    expect(pass({ open: 821, high: 841, low: 815.8, close: 833.7, prevClose: 817.4 }).pass).toBe(true); // ADYEN
  });

  it('REJETTE NEL (rebond du creux mais scotché en bas de range, rangePos 41%)', () => {
    const r = pass({ open: 2.895, high: 3.095, low: 2.85, close: 2.95, prevClose: 2.975 }); // NEL
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('rangePos='))).toBe(true);
    // reboundFromLow (3.5%) passe seul → c'est bien rangePos qui sauve le filtre
    expect(r.reasons.some((x) => x.startsWith('reboundFromLow='))).toBe(false);
  });

  it('REJETTE ETL (rebond insuffisant 1.1% ET bas de range 15%)', () => {
    const r = pass({ open: 3.029, high: 3.158, low: 2.934, close: 2.967, prevClose: 3.013 }); // ETL
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('reboundFromLow='))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('rangePos='))).toBe(true);
  });

  it('requirePositiveDay ajoute un gate sur dayChg < 0', () => {
    // ADYEN est vert (+2%), donc passe même avec requirePositiveDay
    const adyen = analyzeRealtimeRebound({ open: 821, high: 841, low: 815.8, close: 833.7, prevClose: 817.4 })!;
    expect(passesRealtimeReboundFilter(adyen, { ...DEFAULT_REALTIME_REBOUND_CONFIG, requirePositiveDay: true }).pass).toBe(true);
    // Un titre rouge sur la journée mais haut de range serait rejeté par ce gate
    const redButHigh = analyzeRealtimeRebound({ open: 100, high: 100, low: 95, close: 98, prevClose: 102 })!;
    const r = passesRealtimeReboundFilter(redButHigh, { ...DEFAULT_REALTIME_REBOUND_CONFIG, requirePositiveDay: true });
    expect(r.reasons.some((x) => x.startsWith('dayChg='))).toBe(true);
  });
});
