/**
 * Plafond ATR sur le SL gainers (GAINERS_SL_ATR_MAX_PCT).
 *
 * L'élargissement ATR (GAINERS_SL_ATR_MULTIPLIER) était NON borné → un titre
 * très volatil pouvait risquer -3%+ sur une position (IES.LSE 22/05 : SL eu
 * -1.80% élargi à -3.34% par ATR). Le cap borne le risque queue sans retirer
 * l'anti-wick pour les titres modérés.
 *
 * Test pure-logic : ré-implémente la résolution SL telle que codée dans
 * scanPortfolio (base → max(base, ATR×mult) → min(., cap)).
 */

function resolveSlPct(opts: {
  baseSlPct: number;       // matrice par classe, ex 1.80 (eu) / 1.30 (asia)
  atrPct: number | null;   // ATR en décimal (0.022 = 2.2%) ou null
  atrMultiplier: number;   // GAINERS_SL_ATR_MULTIPLIER (0 = off)
  atrMaxPct: number;       // GAINERS_SL_ATR_MAX_PCT (0 = off)
}): number {
  let effective = opts.baseSlPct;
  if (opts.atrMultiplier > 0 && opts.atrPct != null && opts.atrPct > 0) {
    const atrSlPct = opts.atrPct * 100 * opts.atrMultiplier;
    if (atrSlPct > opts.baseSlPct) effective = atrSlPct;
  }
  if (opts.atrMaxPct > 0 && effective > opts.atrMaxPct) effective = opts.atrMaxPct;
  return effective;
}

describe('Gainers SL — ATR widening + cap', () => {
  it('IES.LSE reproduit : ATR élargit -1.80% → -3.34% sans cap', () => {
    // atrPct ~2.23%, mult 1.5 → 3.34%
    const sl = resolveSlPct({ baseSlPct: 1.80, atrPct: 0.02227, atrMultiplier: 1.5, atrMaxPct: 0 });
    expect(sl).toBeCloseTo(3.34, 1);
  });

  it('avec cap 2.5% : IES.LSE plafonné de 3.34% → 2.50%', () => {
    const sl = resolveSlPct({ baseSlPct: 1.80, atrPct: 0.02227, atrMultiplier: 1.5, atrMaxPct: 2.5 });
    expect(sl).toBe(2.5);
  });

  it('titre modéré : ATR×mult sous le cap → inchangé (anti-wick préservé)', () => {
    // atrPct 1.2%, mult 1.5 → 1.80% = base ; cap 2.5 ne mord pas
    const sl = resolveSlPct({ baseSlPct: 1.80, atrPct: 0.012, atrMultiplier: 1.5, atrMaxPct: 2.5 });
    expect(sl).toBe(1.80);
  });

  it('ATR widening off (mult=0) → base inchangée même avec cap', () => {
    const sl = resolveSlPct({ baseSlPct: 1.80, atrPct: 0.05, atrMultiplier: 0, atrMaxPct: 2.5 });
    expect(sl).toBe(1.80);
  });

  it('cap off (0) → pas de plafond (back-compat)', () => {
    const sl = resolveSlPct({ baseSlPct: 1.30, atrPct: 0.03, atrMultiplier: 1.5, atrMaxPct: 0 });
    expect(sl).toBeCloseTo(4.5, 5); // 3% × 1.5
  });

  it('cap n’abaisse jamais sous la base (base déjà < cap)', () => {
    const sl = resolveSlPct({ baseSlPct: 1.30, atrPct: null, atrMultiplier: 1.5, atrMaxPct: 2.5 });
    expect(sl).toBe(1.30);
  });

  it('cap sous la base matrice : plafonne quand même (responsabilité de config)', () => {
    // cap 1.0 < base 1.80 → effective base 1.80 puis capé à 1.0
    const sl = resolveSlPct({ baseSlPct: 1.80, atrPct: null, atrMultiplier: 0, atrMaxPct: 1.0 });
    expect(sl).toBe(1.0);
  });
});
