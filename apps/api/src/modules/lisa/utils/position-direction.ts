/**
 * Bug #314 #M4 — Helper centralisé de direction de position.
 *
 * Contexte : `mechanical-trading.service.ts` utilisait `direction === 'long'`
 * strict à plusieurs endroits (checkStopTarget, checkReactiveSignals,
 * closePosition), alors que `paper-broker.service.ts` et
 * `risk-monitor.service.ts` reconnaissent aussi `long_call` / `long_put`.
 * Conséquence : une option (`direction='long_call'`) gérée par
 * mechanical-trading était interprétée comme SHORT → stop/target inversés
 * → perte garantie.
 *
 * Ce helper centralise la sémantique pour qu'elle soit cohérente partout
 * dans le module `lisa` (apps/api). Les services de `packages/ai-analyst`
 * (paper-broker, risk-monitor) ont déjà la logique correcte inline et ne
 * peuvent pas importer depuis apps/api (sens de dépendance) — voir audit
 * dans la PR #314 PR-B.
 *
 * Directions reconnues (cf. PaperPosition.direction zod enum) :
 *   long, short, long_call, long_put, short_call, short_put, pair_spread
 */

/**
 * `true` si la position est "longue" au sens P&L : profite d'une hausse du
 * sous-jacent. Couvre l'equity long ET les options longues (call/put achetés
 * — un long_put profite d'une baisse du sous-jacent, mais du point de vue de
 * la POSITION c'est un actif détenu dont la valeur monte ; mechanical-trading
 * applique les stop/target sur le prix de la position, pas du sous-jacent).
 *
 * Aligné sur paper-broker.service.ts:503 et risk-monitor.service.ts:191.
 */
export function isLongPosition(direction: string): boolean {
  return (
    direction === 'long' ||
    direction === 'long_call' ||
    direction === 'long_put'
  );
}

/**
 * `true` si la position est "courte" : short equity ou options vendues.
 * Complément strict de `isLongPosition` pour les directions short.
 * `pair_spread` n'est ni long ni short au sens directionnel simple.
 */
export function isShortPosition(direction: string): boolean {
  return (
    direction === 'short' ||
    direction === 'short_call' ||
    direction === 'short_put'
  );
}
