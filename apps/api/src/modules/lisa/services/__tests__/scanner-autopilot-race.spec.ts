/**
 * Bug #314 #M3 (PR-C) — Test race condition scanner gainers vs autopilot.
 *
 * Avant le fix : les crons top-gainers-scanner et lisa-autopilot tournent tous
 * deux à la minute, sans verrou DB. Deux INSERT concurrents pouvaient dépasser
 * le cap (T0 scanner lit 4/5, T0+ε autopilot lit 4/5, les deux INSERT → 6/5).
 *
 * Fix : fonction DB `try_open_position` — check cap + insert atomiques sous
 * `pg_advisory_xact_lock(hashtext(portfolio_id))`. Le verrou sérialise les
 * appels concurrents sur le MÊME portfolio.
 *
 * Pattern de test : reproduction en isolation de la sémantique atomique de
 * la fonction (norme repo, cf. mechanical-trading.batch-cap.spec.ts — pas de
 * Postgres dans la suite unit). Un mutex modélise le verrou advisory : deux
 * appels concurrents sont sérialisés, donc le 2e voit le count à jour. On
 * vérifie qu'avec 4 positions / max 5, exactement 1 des 2 appels concurrents
 * réussit et l'autre retourne null.
 *
 * Un test d'intégration DB réel (Supabase local) validerait le verrou Postgres
 * lui-même — hors scope de la suite unit, documenté.
 */

/** Mutex async minimal — modélise pg_advisory_xact_lock scopé portfolio. */
class PortfolioLock {
  private chain: Promise<void> = Promise.resolve();
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // La chaîne avance quoi qu'il arrive (succès ou échec) pour ne pas bloquer.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** DB simulée : un compteur de positions ouvertes par portfolio. */
class MockDb {
  private openCount = new Map<string, number>();
  private locks = new Map<string, PortfolioLock>();

  constructor(seed: Record<string, number> = {}) {
    for (const [pid, n] of Object.entries(seed)) this.openCount.set(pid, n);
  }

  private lockFor(portfolioId: string): PortfolioLock {
    let l = this.locks.get(portfolioId);
    if (!l) { l = new PortfolioLock(); this.locks.set(portfolioId, l); }
    return l;
  }

  getOpenCount(portfolioId: string): number {
    return this.openCount.get(portfolioId) ?? 0;
  }

  /**
   * Reproduit try_open_position : sous le verrou advisory (mutex), check cap
   * puis insert. Retourne un id (string) si inséré, null si cap atteint.
   */
  async tryOpenPosition(portfolioId: string, maxOpen: number): Promise<string | null> {
    return this.lockFor(portfolioId).withLock(async () => {
      const current = this.openCount.get(portfolioId) ?? 0;
      // micro-yield : simule la latence entre le SELECT COUNT et l'INSERT —
      // sans le verrou, c'est là que la race se produirait.
      await new Promise((r) => setTimeout(r, 1));
      if (current >= maxOpen) return null;
      this.openCount.set(portfolioId, current + 1);
      return `pos-${portfolioId}-${current + 1}`;
    });
  }
}

describe('Bug #314 #M3 — try_open_position atomic cap guard', () => {
  it('2 appels concurrents, 4/5 positions → exactement 1 réussit, 1 retourne null', async () => {
    const db = new MockDb({ pf1: 4 });
    const MAX = 5;

    // Scanner et autopilot frappent le même portfolio "en même temps".
    const [scannerResult, autopilotResult] = await Promise.all([
      db.tryOpenPosition('pf1', MAX),
      db.tryOpenPosition('pf1', MAX),
    ]);

    const succeeded = [scannerResult, autopilotResult].filter((r) => r !== null);
    const refused = [scannerResult, autopilotResult].filter((r) => r === null);

    expect(succeeded).toHaveLength(1);  // exactement 1 INSERT
    expect(refused).toHaveLength(1);    // exactement 1 null (cap atteint)
    expect(db.getOpenCount('pf1')).toBe(5);  // jamais 6 — cap respecté
  });

  it('2 appels concurrents, 3/5 positions → les 2 réussissent (slots dispo)', async () => {
    const db = new MockDb({ pf1: 3 });
    const [r1, r2] = await Promise.all([
      db.tryOpenPosition('pf1', 5),
      db.tryOpenPosition('pf1', 5),
    ]);
    expect([r1, r2].filter((r) => r !== null)).toHaveLength(2);
    expect(db.getOpenCount('pf1')).toBe(5);
  });

  it('5 appels concurrents, 4/5 positions → exactement 1 réussit, 4 refusés', async () => {
    const db = new MockDb({ pf1: 4 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.tryOpenPosition('pf1', 5)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(4);
    expect(db.getOpenCount('pf1')).toBe(5);  // cap strict, jamais dépassé
  });

  it('appel sur cap déjà atteint (5/5) → retourne null directement', async () => {
    const db = new MockDb({ pf1: 5 });
    const r = await db.tryOpenPosition('pf1', 5);
    expect(r).toBeNull();
    expect(db.getOpenCount('pf1')).toBe(5);
  });

  it('portfolios différents ne se bloquent pas mutuellement (verrou scopé)', async () => {
    const db = new MockDb({ pfA: 4, pfB: 4 });
    // pfA et pfB ont chacun 1 slot — 2 appels concurrents, un par portfolio.
    const [rA, rB] = await Promise.all([
      db.tryOpenPosition('pfA', 5),
      db.tryOpenPosition('pfB', 5),
    ]);
    // Aucun blocage croisé : les deux réussissent (portfolios indépendants).
    expect(rA).not.toBeNull();
    expect(rB).not.toBeNull();
    expect(db.getOpenCount('pfA')).toBe(5);
    expect(db.getOpenCount('pfB')).toBe(5);
  });
});
