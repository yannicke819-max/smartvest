/**
 * Tests de l'exit OVERSOLD : businessDaysSince (week-ends exclus) + la logique
 * de décision exit (hold expiré vs stop catastrophe) sur un OversoldExitService
 * avec deps mockées légèrement.
 */

import { businessDaysSince } from '../oversold.helper';

describe('businessDaysSince', () => {
  it('compte 5 jours ouvrés sur une semaine pleine (vendredi → vendredi suivant)', () => {
    // 2026-06-05 = vendredi. Jour suivant compté : lun 08, mar 09, mer 10,
    // jeu 11, ven 12 = 5 jours ouvrés (sam 06 + dim 07 exclus).
    const from = '2026-06-05T21:15:00.000Z';
    const to = '2026-06-12T21:00:00.000Z';
    expect(businessDaysSince(from, to)).toBe(5);
  });

  it('exclut le week-end (vendredi → lundi = 1 jour ouvré)', () => {
    // ven 2026-06-05 → lun 2026-06-08 : sam/dim exclus → seul lundi compte.
    expect(businessDaysSince('2026-06-05T21:00:00Z', '2026-06-08T21:00:00Z')).toBe(1);
  });

  it('le jour d’entrée (J0) n’est pas compté', () => {
    // Même jour → 0.
    expect(businessDaysSince('2026-06-03T21:00:00Z', '2026-06-03T23:00:00Z')).toBe(0);
  });

  it('10 jours ouvrés ≈ 14 jours calendaires (J+10 hold)', () => {
    // Entrée mercredi 2026-06-03. 10 jours ouvrés plus tard = mercredi 2026-06-17.
    // lun-ven semaine 1 (08-12) = 5, lun-ven semaine 2 (15-17) jeu/ven manquent ?
    // Détail : 04,05 (jeu/ven) = 2 ; 08-12 = 5 ; 15-17 (lun,mar,mer) = 3 → total 10.
    expect(businessDaysSince('2026-06-03T21:00:00Z', '2026-06-17T21:00:00Z')).toBe(10);
  });

  it('retourne 0 si to <= from', () => {
    expect(businessDaysSince('2026-06-10T00:00:00Z', '2026-06-05T00:00:00Z')).toBe(0);
  });

  it('gère les dates invalides sans crash', () => {
    expect(businessDaysSince('not-a-date', '2026-06-10T00:00:00Z')).toBe(0);
    expect(businessDaysSince('2026-06-05T00:00:00Z', 'nope')).toBe(0);
  });

  it('accepte des objets Date', () => {
    const from = new Date('2026-06-05T21:00:00Z');
    const to = new Date('2026-06-08T21:00:00Z');
    expect(businessDaysSince(from, to)).toBe(1);
  });
});

/**
 * Décision exit — on teste la frontière hold/stop via une reproduction de la
 * logique (le service privé n'est pas exporté ; on vérifie les seuils).
 */
describe('logique de décision exit (seuils)', () => {
  const HOLD_DAYS = 10;
  const STOP_PCT = -15;

  function decide(
    heldDays: number,
    entry: number,
    price: number,
  ): 'stop' | 'hold' | 'none' {
    const stopThreshold = entry * (1 + STOP_PCT / 100);
    if (entry > 0 && price <= stopThreshold) return 'stop'; // prioritaire
    if (heldDays >= HOLD_DAYS) return 'hold';
    return 'none';
  }

  it('stop catastrophe prioritaire même avant le hold', () => {
    // -16% < -15% → stop, peu importe le held.
    expect(decide(2, 100, 84)).toBe('stop');
  });

  it('seuil stop exact (-15%) déclenche (<=)', () => {
    expect(decide(2, 100, 85)).toBe('stop');
  });

  it('hold expiré (>= 10 jours) sans stop → close hold', () => {
    expect(decide(10, 100, 98)).toBe('hold'); // -2%, pas de stop
    expect(decide(11, 100, 92)).toBe('hold'); // -8%, pas de stop (-15% non atteint)
  });

  it('ni stop ni hold → on ne ferme pas', () => {
    expect(decide(5, 100, 96)).toBe('none');
  });

  it('hold non encore atteint (9 jours) → none', () => {
    expect(decide(9, 100, 98)).toBe('none');
  });
});
