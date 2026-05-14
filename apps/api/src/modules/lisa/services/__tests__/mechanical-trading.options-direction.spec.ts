/**
 * Bug #314 #M4 (PR-B) — Tests helper isLongPosition / isShortPosition centralisé
 * + vérification que mechanical-trading.checkStopTarget interprète une option
 * `long_call` / `long_put` dans le bon sens (LONG, pas SHORT).
 *
 * Avant le fix : mechanical-trading utilisait `direction === 'long'` strict →
 * une option (`direction='long_call'`) tombait dans la branche SHORT →
 * stop/target inversés → perte garantie.
 *
 * Pattern de test : le helper est une fonction pure → testée directement.
 * La logique checkStopTarget est reproduite en isolation (norme repo, cf.
 * mechanical-trading.batch-cap.spec.ts — service trop lourd en DI NestJS).
 */

import Decimal from 'decimal.js';
import { isLongPosition, isShortPosition } from '../../utils/position-direction';

describe('Bug #314 #M4 — isLongPosition helper', () => {
  it('reconnaît long / long_call / long_put comme LONG', () => {
    expect(isLongPosition('long')).toBe(true);
    expect(isLongPosition('long_call')).toBe(true);
    expect(isLongPosition('long_put')).toBe(true);
  });

  it('rejette short / short_call / short_put / pair_spread comme non-LONG', () => {
    expect(isLongPosition('short')).toBe(false);
    expect(isLongPosition('short_call')).toBe(false);
    expect(isLongPosition('short_put')).toBe(false);
    expect(isLongPosition('pair_spread')).toBe(false);
  });
});

describe('Bug #314 #M4 — isShortPosition helper', () => {
  it('reconnaît short / short_call / short_put comme SHORT', () => {
    expect(isShortPosition('short')).toBe(true);
    expect(isShortPosition('short_call')).toBe(true);
    expect(isShortPosition('short_put')).toBe(true);
  });

  it('rejette long / long_call / long_put / pair_spread comme non-SHORT', () => {
    expect(isShortPosition('long')).toBe(false);
    expect(isShortPosition('long_call')).toBe(false);
    expect(isShortPosition('long_put')).toBe(false);
    expect(isShortPosition('pair_spread')).toBe(false);
  });

  it('long et short sont mutuellement exclusifs sur les 6 directions directionnelles', () => {
    for (const dir of ['long', 'short', 'long_call', 'long_put', 'short_call', 'short_put']) {
      expect(isLongPosition(dir)).toBe(!isShortPosition(dir));
    }
  });
});

// ---------------------------------------------------------------------------
// Reproduction isolée de mechanical-trading.checkStopTarget hit logic (L1760)
// ---------------------------------------------------------------------------
function checkStopTargetHits(
  direction: string,
  currentPrice: number,
  stopLossPrice: number | null,
  takeProfitPrice: number | null,
): { hitStop: boolean; hitTarget: boolean } {
  const cur = new Decimal(currentPrice);
  const stopPrice = stopLossPrice != null ? new Decimal(stopLossPrice) : null;
  const tpPrice = takeProfitPrice != null ? new Decimal(takeProfitPrice) : null;
  // Logique exacte post-fix #M4 : isLongPosition(direction) au lieu de === 'long'.
  const isLong = isLongPosition(direction);
  const hitStop = !!stopPrice && (isLong ? cur.lte(stopPrice) : cur.gte(stopPrice));
  const hitTarget = !!tpPrice && (isLong ? cur.gte(tpPrice) : cur.lte(tpPrice));
  return { hitStop, hitTarget };
}

describe('Bug #314 #M4 — checkStopTarget direction options', () => {
  it('long_call : prix sous le stop → hitStop (sens LONG, pas inversé)', () => {
    // entry ~5, stop 4.5, tp 6. Prix tombe à 4.4 → stop touché.
    const { hitStop, hitTarget } = checkStopTargetHits('long_call', 4.4, 4.5, 6.0);
    expect(hitStop).toBe(true);
    expect(hitTarget).toBe(false);
  });

  it('long_call : prix au-dessus du target → hitTarget (sens LONG)', () => {
    const { hitStop, hitTarget } = checkStopTargetHits('long_call', 6.1, 4.5, 6.0);
    expect(hitStop).toBe(false);
    expect(hitTarget).toBe(true);
  });

  it('long_put : traité comme LONG (position détenue, stop sous le prix)', () => {
    const { hitStop, hitTarget } = checkStopTargetHits('long_put', 4.4, 4.5, 6.0);
    expect(hitStop).toBe(true);
    expect(hitTarget).toBe(false);
  });

  it('REGRESSION : avant le fix, long_call à 4.4 (sous stop 4.5) aurait été ' +
     'interprété SHORT → hitStop = cur.gte(stop) = false → stop manqué', () => {
    // Démonstration du bug : la logique strict `=== "long"` sur long_call.
    const buggyIsLong = ('long_call' as string) === 'long'; // false (le bug)
    const cur = new Decimal(4.4);
    const stop = new Decimal(4.5);
    const buggyHitStop = buggyIsLong ? cur.lte(stop) : cur.gte(stop);
    expect(buggyHitStop).toBe(false); // ← le stop n'aurait JAMAIS déclenché

    // Post-fix : le même scénario déclenche bien le stop.
    const fixed = checkStopTargetHits('long_call', 4.4, 4.5, 6.0);
    expect(fixed.hitStop).toBe(true);
  });

  it('short : prix au-dessus du stop → hitStop (sens SHORT préservé)', () => {
    // Pour un short, le stop est AU-DESSUS du prix d'entrée.
    const { hitStop } = checkStopTargetHits('short', 5.6, 5.5, 4.0);
    expect(hitStop).toBe(true);
  });

  it('equity long : comportement inchangé (rétro-compat)', () => {
    const { hitStop, hitTarget } = checkStopTargetHits('long', 4.4, 4.5, 6.0);
    expect(hitStop).toBe(true);
    expect(hitTarget).toBe(false);
  });
});
