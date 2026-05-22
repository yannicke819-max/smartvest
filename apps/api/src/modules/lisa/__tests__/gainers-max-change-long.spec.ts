/**
 * Plafond changePct LONG (GAINERS_MAX_CHANGE_PCT_LONG) — anti chase-the-top.
 *
 * Mesure 22/05 (paired n=469 us_equity_small_mid) : le LONG perd sur les pops
 * sur-étendus (≥10% : -0.35/-0.40% mean) mais est positif sur 5-10% (+0.085%).
 * Le plafond skip les entrées long au-dessus du seuil.
 */

function blocksLong(changePct: number, ceilingPct: number): boolean {
  if (ceilingPct <= 0) return false; // off
  return changePct >= ceilingPct;
}

describe('Plafond changePct LONG (anti chase-the-top)', () => {
  it('off (0) → n’importe quelle hausse passe', () => {
    expect(blocksLong(38, 0)).toBe(false);
    expect(blocksLong(6, 0)).toBe(false);
  });

  it('plafond 10% : pop modéré (6%) passe', () => {
    expect(blocksLong(6, 10)).toBe(false);
  });

  it('plafond 10% : pop sur-étendu (14%) bloqué', () => {
    expect(blocksLong(14, 10)).toBe(true);
  });

  it('plafond 10% : seuil exact (10%) bloqué (>=)', () => {
    expect(blocksLong(10, 10)).toBe(true);
  });

  it('plafond 10% : très gros pop (38%) bloqué', () => {
    expect(blocksLong(38, 10)).toBe(true);
  });
});
