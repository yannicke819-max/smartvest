/**
 * Bug #314 (PR-A) — Tests UPDATE atomique close avec garde double-clause statut.
 *
 * 3 sites corrigés (#M1 mechanical-trading, #M2 option-broker, #m3 rebound-monitor) :
 * l'UPDATE de fermeture ajoute désormais une clause statut (`.eq('status','open')`
 * ou `.in('status', [...])`) + `.select()` + détection de race (0 rows touchées).
 * Sans ça, un acteur concurrent fermant la position entre SELECT et UPDATE
 * provoquait un double-comptage P&L et polluait l'audit.
 *
 * Pattern de test : reproduction en isolation de la logique de garde insérée
 * (norme du repo, cf. mechanical-trading.batch-cap.spec.ts — services trop
 * lourds en DI NestJS). Chaque test simule la race double-close via un mock
 * Supabase qui retourne 0 rows quand la clause statut ne matche plus.
 */

type UpdateRow = { id: string; status: string };

/**
 * Mock minimal du builder Supabase `.update().eq().eq().select()` /
 * `.update().eq().in().select()`. La DB simulée contient une seule position
 * dont le statut courant est `dbStatus`. L'UPDATE ne touche la row que si la
 * clause statut matche — exactement comme Postgres.
 */
function makeAtomicUpdateMock(dbStatus: string) {
  const calls: { statusGuard?: string | string[] } = {};
  const builder = {
    _idMatch: false,
    update(_payload: Record<string, unknown>) { return this; },
    eq(col: string, val: string) {
      if (col === 'id') this._idMatch = true;
      if (col === 'status') calls.statusGuard = val;
      return this;
    },
    in(col: string, vals: string[]) {
      if (col === 'status') calls.statusGuard = vals;
      return this;
    },
    async select(_cols?: string) {
      // Reproduit Postgres : la row n'est retournée que si id matche ET
      // la garde statut matche le statut courant en DB.
      const guard = calls.statusGuard;
      const guardMatches = Array.isArray(guard)
        ? guard.includes(dbStatus)
        : guard === dbStatus;
      const data: UpdateRow[] = this._idMatch && guardMatches
        ? [{ id: 'pos-1', status: dbStatus }]
        : [];
      return { data, error: null };
    },
  };
  return { builder, calls };
}

// ---------------------------------------------------------------------------
// #M1 — mechanical-trading.closePosition : .eq('status','open') + race log
// ---------------------------------------------------------------------------
async function m1RunUpdate(dbStatus: string): Promise<{ raceDetected: boolean }> {
  const { builder } = makeAtomicUpdateMock(dbStatus);
  const { data: updated } = await builder
    .update({ status: 'closed_stop' })
    .eq('id', 'pos-1')
    .eq('status', 'open')
    .select('*');
  return { raceDetected: !updated || updated.length === 0 };
}

describe('Bug #314 #M1 — mechanical-trading atomic close UPDATE', () => {
  it('position encore open → UPDATE applique, pas de race', async () => {
    const { raceDetected } = await m1RunUpdate('open');
    expect(raceDetected).toBe(false);
  });

  it('position déjà closed_stop (acteur concurrent) → 0 rows → race détectée', async () => {
    const { raceDetected } = await m1RunUpdate('closed_stop');
    expect(raceDetected).toBe(true);
  });

  it('position déjà closed_kill (kill-switch concurrent) → race détectée', async () => {
    const { raceDetected } = await m1RunUpdate('closed_kill');
    expect(raceDetected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #M2 — option-broker.closeOption : .eq('status','open') + race log
// ---------------------------------------------------------------------------
async function m2RunUpdate(dbStatus: string): Promise<{ raceDetected: boolean }> {
  const { builder } = makeAtomicUpdateMock(dbStatus);
  const { data: updated } = await builder
    .update({ status: 'closed_target' })
    .eq('id', 'pos-1')
    .eq('status', 'open')
    .select('*');
  return { raceDetected: !updated || updated.length === 0 };
}

describe('Bug #314 #M2 — option-broker atomic close UPDATE', () => {
  it('option encore open → UPDATE applique', async () => {
    const { raceDetected } = await m2RunUpdate('open');
    expect(raceDetected).toBe(false);
  });

  it('option déjà closed_expired (cron expire vs cron TP même tick) → race détectée', async () => {
    // Scénario du double-close : la boucle cron expire ferme l'option, puis
    // la boucle TP du même tick 5min tente de la re-fermer.
    const { raceDetected } = await m2RunUpdate('closed_expired');
    expect(raceDetected).toBe(true);
  });

  it('option déjà closed_target → race détectée', async () => {
    const { raceDetected } = await m2RunUpdate('closed_target');
    expect(raceDetected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #m3 — rebound-monitor.closePosition : .in('status', [non-terminaux]) + race log
// ---------------------------------------------------------------------------
async function m3RunUpdate(dbStatus: string): Promise<{ raceDetected: boolean }> {
  const { builder } = makeAtomicUpdateMock(dbStatus);
  const { data: updated } = await builder
    .update({ status: 'TP3_HIT' })
    .eq('id', 'pos-1')
    .in('status', ['OPEN', 'TP1_HIT', 'TP2_HIT'])
    .select('id');
  return { raceDetected: !updated || updated.length === 0 };
}

describe('Bug #314 #m3 — rebound-monitor atomic close UPDATE', () => {
  it('position OPEN → UPDATE applique', async () => {
    const { raceDetected } = await m3RunUpdate('OPEN');
    expect(raceDetected).toBe(false);
  });

  it('position TP1_HIT (partiel) → UPDATE applique encore (non-terminal)', async () => {
    const { raceDetected } = await m3RunUpdate('TP1_HIT');
    expect(raceDetected).toBe(false);
  });

  it('position déjà CLOSED → 0 rows → race détectée (statut terminal)', async () => {
    const { raceDetected } = await m3RunUpdate('CLOSED');
    expect(raceDetected).toBe(true);
  });

  it('position déjà SL_HIT → race détectée (statut terminal)', async () => {
    const { raceDetected } = await m3RunUpdate('SL_HIT');
    expect(raceDetected).toBe(true);
  });
});
