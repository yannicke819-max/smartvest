/**
 * Anti falling-knife / whipsaw guard (fix #2, incident LPG 21/05/2026).
 *
 * Le scanner gainers achète des day-gainers ; après un stop, le post-SL cooldown
 * (dur, ~60 min) finit par expirer. Sans garde supplémentaire, un titre qui fade
 * en faisant des plus bas est racheté dès que le cooldown lève → re-stop
 * (« catching a falling knife » / « death by a thousand cuts »).
 *
 * Le garde refuse la ré-entrée tant que (a) on est dans la fenêtre reentryGuardMs
 * APRÈS un closed_stop, ET (b) le prix du candidat n'a pas repris au-dessus de
 * l'entrée stoppée. Tests logiques purs (mirror de la condition dans scanPortfolio).
 */

interface LastStop {
  ms: number;          // timestamp du closed_stop
  entryPrice: number;  // prix d'entrée du trade stoppé
}

/** Mirror exact de la condition implémentée dans scanPortfolio. */
function blocksReentry(
  candClose: number,
  lastSl: LastStop | undefined,
  reentryGuardMs: number,
  now: number,
): boolean {
  if (reentryGuardMs <= 0) return false;
  if (!lastSl) return false;
  return (
    now - lastSl.ms < reentryGuardMs
    && Number.isFinite(lastSl.entryPrice)
    && lastSl.entryPrice > 0
    && candClose <= lastSl.entryPrice
  );
}

describe('Anti falling-knife re-entry guard', () => {
  const GUARD_MS = 240 * 60_000; // 240 min default
  const NOW = 1_700_000_000_000;
  const MIN_AGO = (m: number) => ({ ms: NOW - m * 60_000 });

  it('LPG 21/05 — bloque la ré-entrée 62 min après stop si prix sous entrée stoppée', () => {
    // Entrée stoppée #1 = 46.73 ; ré-entrée candidate à 46.375 (plus bas).
    const lastSl: LastStop = { ...MIN_AGO(62), entryPrice: 46.73 };
    expect(blocksReentry(46.375, lastSl, GUARD_MS, NOW)).toBe(true);
  });

  it('autorise la ré-entrée si le prix a repris AU-DESSUS de l’entrée stoppée (momentum repris)', () => {
    const lastSl: LastStop = { ...MIN_AGO(62), entryPrice: 46.73 };
    expect(blocksReentry(47.10, lastSl, GUARD_MS, NOW)).toBe(false);
  });

  it('prix exactement égal à l’entrée stoppée → bloqué (<=)', () => {
    const lastSl: LastStop = { ...MIN_AGO(30), entryPrice: 46.73 };
    expect(blocksReentry(46.73, lastSl, GUARD_MS, NOW)).toBe(true);
  });

  it('au-delà de la fenêtre de garde → autorisé même si prix sous l’entrée', () => {
    const lastSl: LastStop = { ...MIN_AGO(300), entryPrice: 46.73 }; // 300 > 240
    expect(blocksReentry(45.00, lastSl, GUARD_MS, NOW)).toBe(false);
  });

  it('garde désactivé (reentryGuardMs=0) → jamais bloqué', () => {
    const lastSl: LastStop = { ...MIN_AGO(10), entryPrice: 46.73 };
    expect(blocksReentry(40.00, lastSl, 0, NOW)).toBe(false);
  });

  it('aucun stop récent → autorisé', () => {
    expect(blocksReentry(46.375, undefined, GUARD_MS, NOW)).toBe(false);
  });

  it('entryPrice invalide (NaN / 0) → ne bloque pas (fail-open)', () => {
    expect(blocksReentry(46.375, { ...MIN_AGO(30), entryPrice: NaN }, GUARD_MS, NOW)).toBe(false);
    expect(blocksReentry(46.375, { ...MIN_AGO(30), entryPrice: 0 }, GUARD_MS, NOW)).toBe(false);
  });

  it('clamp config lookback [0, 1440]', () => {
    const clamp = (v: number) => Math.max(0, Math.min(1440, v));
    expect(clamp(-5)).toBe(0);
    expect(clamp(240)).toBe(240);
    expect(clamp(99999)).toBe(1440);
  });
});
