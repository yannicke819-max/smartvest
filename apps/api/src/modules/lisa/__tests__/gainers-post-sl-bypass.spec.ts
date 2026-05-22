/**
 * Bypass post-SL cooldown pour forts movers (GAINERS_POST_SL_BYPASS_STRONG_MOVER_PCT).
 *
 * Mesure shadow regret 22/05 : les signaux EU 10-15% rejetés par post_sl_cooldown
 * valaient +1.52% / 94% win → le ban temporel aveugle (60 min) détruit de la
 * valeur sur les vrais movers. Le bypass laisse passer les forts movers vers le
 * falling-knife guard (price-aware), qui reste l'autorité de sécurité.
 *
 * Test pure-logic : ré-implémente la condition exacte du gate.
 */

function shouldBlockPostSl(opts: {
  lastSlWithinCooldown: boolean; // un closed_stop récent < postSlCooldownMin
  changePct: number;             // hausse du candidat
  bypassPct: number;             // GAINERS_POST_SL_BYPASS_STRONG_MOVER_PCT (0 = off)
}): boolean {
  if (!opts.lastSlWithinCooldown) return false;
  const strongMover = opts.bypassPct > 0 && opts.changePct >= opts.bypassPct;
  return !strongMover; // bloque sauf si fort mover bypassé
}

describe('Post-SL cooldown — bypass forts movers', () => {
  it('bypass OFF (0) → bloque toujours pendant le cooldown (back-compat)', () => {
    expect(shouldBlockPostSl({ lastSlWithinCooldown: true, changePct: 14, bypassPct: 0 })).toBe(true);
    expect(shouldBlockPostSl({ lastSlWithinCooldown: true, changePct: 3, bypassPct: 0 })).toBe(true);
  });

  it('bypass 10% : fort mover (14%) pendant cooldown → NON bloqué (délégué falling-knife)', () => {
    expect(shouldBlockPostSl({ lastSlWithinCooldown: true, changePct: 14, bypassPct: 10 })).toBe(false);
  });

  it('bypass 10% : mover faible (7%) pendant cooldown → bloqué (cooldown s’applique)', () => {
    expect(shouldBlockPostSl({ lastSlWithinCooldown: true, changePct: 7, bypassPct: 10 })).toBe(true);
  });

  it('seuil exact (changePct == bypassPct) → bypassé (>=)', () => {
    expect(shouldBlockPostSl({ lastSlWithinCooldown: true, changePct: 10, bypassPct: 10 })).toBe(false);
  });

  it('pas de stop récent → jamais bloqué quel que soit le reste', () => {
    expect(shouldBlockPostSl({ lastSlWithinCooldown: false, changePct: 3, bypassPct: 10 })).toBe(false);
  });
});
