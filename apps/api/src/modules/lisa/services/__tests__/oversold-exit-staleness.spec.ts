/**
 * CHECK-IN 06/08/2026 — garde-fou de staleness sur le chemin de SORTIE oversold.
 *
 * Bug confirmé le 29/07 : 5 locks déclenchés en < 5 min après l'entrée, dont 3
 * aberrants (NOKIA.HE +7.13% en 26 s, MAERSK-B.CO +4.58% en 30 s, UCB.BR +7.73%
 * en 62 s). Tous EU sans couverture TwelveData, tous à 21:16 / 14:16 UTC juste
 * après le scan : position ouverte au close EOD puis « prix live » issu d'une
 * AUTRE séance → lock encaissé sur un prix qui n'existe plus.
 *
 * Le chemin MÉCANIQUE avait déjà `isFallbackSource` + sanity bound 30% ; le chemin
 * oversold consommait `getLivePrice` nu. Ce test verrouille l'alignement.
 */

import { OversoldMistralExitService } from '../oversold-mistral-exit.service';

type Guard = (source: string | undefined) => boolean;

function makeGuard(envValue?: string): Guard {
  // `config` et `isStaleOrFallback` sont privés : on passe par un cast opaque
  // plutôt que d'élargir la visibilité du service pour les besoins d'un test.
  const svc = Object.create(OversoldMistralExitService.prototype) as Record<string, unknown>;
  svc.config = { get: (k: string) => (k === 'OVERSOLD_EXIT_STALENESS_GUARD' ? envValue : undefined) };
  return (svc.isStaleOrFallback as Guard).bind(svc);
}

describe('oversold exit — garde-fou de staleness', () => {
  const isStale = makeGuard();

  it('rejette les sources fallback (prix hardcodé ou inconnu)', () => {
    expect(isStale('fallback')).toBe(true);
    expect(isStale('fallback_unknown')).toBe(true);
    expect(isStale('fallback_quota_cap')).toBe(true);
  });

  it('rejette les sources stale_* — LE cas du bug NOKIA.HE / MAERSK-B.CO / UCB.BR', () => {
    expect(isStale('stale_eodhd')).toBe(true);
    expect(isStale('stale_twelvedata')).toBe(true);
  });

  it('rejette une source absente (on ne ferme jamais sur une provenance inconnue)', () => {
    expect(isStale(undefined)).toBe(true);
    expect(isStale('')).toBe(true);
  });

  it('accepte les sources live légitimes', () => {
    expect(isStale('eodhd')).toBe(false);
    expect(isStale('twelvedata')).toBe(false);
    expect(isStale('binance_rest')).toBe(false);
  });

  it('peut être désactivé en urgence via OVERSOLD_EXIT_STALENESS_GUARD=false', () => {
    const off = makeGuard('false');
    expect(off('stale_eodhd')).toBe(false);
    expect(off(undefined)).toBe(false);
  });

  it('reste actif pour toute autre valeur que "false" (fail-safe)', () => {
    expect(makeGuard('true')('stale_eodhd')).toBe(true);
    expect(makeGuard('nimportequoi')('stale_eodhd')).toBe(true);
  });
});

describe('oversold exit — sanity bound 30%', () => {
  // Réplique de la règle appliquée dans evaluatePosition : un écart > 30% vs
  // l'entrée en un seul tick est presque toujours une corruption.
  const diverges = (price: number, entry: number) => Math.abs((price - entry) / entry) * 100 > 30;

  it('laisse passer un mouvement normal, même violent', () => {
    expect(diverges(101.5, 100)).toBe(false); // lock +1.5%
    expect(diverges(85, 100)).toBe(false); // stop catastrophe -15%
    expect(diverges(129, 100)).toBe(false); // +29% : rare mais plausible
  });

  it('bloque une divergence aberrante (cache pollué / séance décalée)', () => {
    expect(diverges(131, 100)).toBe(true);
    expect(diverges(50, 100)).toBe(true);
    expect(diverges(0.01, 100)).toBe(true);
  });
});
