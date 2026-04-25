/**
 * Modèle de slippage déterministe pour rendre le paper plus réaliste.
 *
 * En réel, l'écart entre le prix vu par la stratégie et le prix d'exécution
 * vient de plusieurs sources :
 *   - latence (350 ms moyens entre signal et fill)
 *   - spread bid-ask
 *   - impact prix sur ordres > 0.1% du volume journalier
 *   - stops qui glissent en gap (overnight ou news)
 *
 * Pour la sim et le backtest on agrège tout ça en un coût plat de N bps
 * par trade. C'est volontairement PESSIMISTE — si une config est rentable
 * avec ce malus, elle est probablement rentable en réel. L'inverse n'est
 * pas garanti (les vrais marchés peuvent être pires que le modèle).
 *
 * Symétrique : payé à l'ouverture ET à la fermeture.
 */

export interface SlippageQuote {
  /** Prix d'exécution effectif, slippage inclus, dans le sens défavorable. */
  effectivePrice: number;
  /** Coût en USD du slippage seul. */
  slippageCostUsd: number;
}

/**
 * Applique un slippage de N bps DÉFAVORABLE :
 *  - long open  : prix monte (on paye plus cher)
 *  - long close : prix baisse (on reçoit moins)
 *  - short open : prix baisse (on vend moins cher)
 *  - short close: prix monte (on rachete plus cher)
 */
export function applySlippage(
  quotedPrice: number,
  quantity: number,
  side: 'open' | 'close',
  direction: 'long' | 'short',
  bps: number,
): SlippageQuote {
  const bpsRatio = bps / 10_000;
  // Sens défavorable : combine direction × side
  const isUnfavorableUp =
    (direction === 'long' && side === 'open') ||
    (direction === 'short' && side === 'close');
  const sign = isUnfavorableUp ? 1 : -1;
  const effectivePrice = quotedPrice * (1 + sign * bpsRatio);
  const slippageCostUsd = Math.abs(quotedPrice - effectivePrice) * Math.abs(quantity);
  return { effectivePrice, slippageCostUsd };
}

/**
 * Coût fee plat sur le notionnel (fees broker simulés).
 * Symétrique : payé à l'ouverture et à la fermeture.
 */
export function applyFee(notionalUsd: number, bps: number): number {
  return notionalUsd * (bps / 10_000);
}
