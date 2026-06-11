import {
  gainPickerBand,
  computeLiveBandLaw,
  resolveBandAlpha,
  BACKTEST_BAND_ALPHA,
} from '../oversold-live-law.helper';

describe('oversold-live-law — Phase 2 (boucle fermée)', () => {
  it('gainPickerBand classe le drop dans les bandes coarse', () => {
    expect(gainPickerBand(-1)).toBe('>-3%');
    expect(gainPickerBand(-4)).toBe('-3/-5%');
    expect(gainPickerBand(-6)).toBe('-5/-8%');
    expect(gainPickerBand(-10)).toBe('-8/-12%');
    expect(gainPickerBand(-15)).toBe('<-12%');
  });

  it('computeLiveBandLaw agrège le rendement forward-J10 moyen par bande', () => {
    const law = computeLiveBandLaw([
      { drop: -9, fwdReturnPct: 2.0 },
      { drop: -10, fwdReturnPct: 4.0 }, // même bande -8/-12 → moyenne 3.0
      { drop: -6, fwdReturnPct: 1.5 }, // bande -5/-8
    ]);
    expect(law['-8/-12%']).toEqual({ alpha: 3.0, n: 2 });
    expect(law['-5/-8%']).toEqual({ alpha: 1.5, n: 1 });
    expect(law['<-12%']).toBeUndefined();
  });

  it('resolveBandAlpha → LIVE quand sample ≥ minSample', () => {
    const live = computeLiveBandLaw(
      Array.from({ length: 12 }, () => ({ drop: -10, fwdReturnPct: 3.2 })),
    );
    const r = resolveBandAlpha(-10, live, 10);
    expect(r.source).toBe('live');
    expect(r.alpha).toBe(3.2); // loi apprise, ≠ backtest 2.45
    expect(r.n).toBe(12);
  });

  it('resolveBandAlpha → BACKTEST quand sample < minSample (cas avant J+10)', () => {
    const live = computeLiveBandLaw([{ drop: -10, fwdReturnPct: 3.2 }]); // n=1
    const r = resolveBandAlpha(-10, live, 10);
    expect(r.source).toBe('backtest');
    expect(r.alpha).toBe(BACKTEST_BAND_ALPHA['-8/-12%']); // 2.45
    expect(r.n).toBe(1);
  });

  it('resolveBandAlpha → BACKTEST quand AUCUN label (loi vide = état actuel ~avant 18/06)', () => {
    const r = resolveBandAlpha(-6, {}, 10);
    expect(r.source).toBe('backtest');
    expect(r.alpha).toBe(1.0); // -5/-8% backtest
    expect(r.n).toBe(0);
  });
});
