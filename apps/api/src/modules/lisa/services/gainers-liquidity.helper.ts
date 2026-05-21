/**
 * Filtre liquidité dollar-volume (equity) — scanner Gainers live path.
 *
 * Contexte (21/05/2026) : les penny-stocks LSE/Euronext illiquides ont un spread
 * large → le SL se déclenche sur le bruit du spread, pas sur un vrai mouvement
 * (gros du -$1688 de pertes EU mesurées). On les vire avant l'ouverture via un
 * plancher de $-volume quotidien. Le prix seul est trompeur (LSE cote en pence :
 * RR.LSE "1205" = £12 ; MTL.LSE "14,25" = £0,14) — le $-volume ne ment pas.
 */

/** $-volume quotidien ≈ close × volume moyen (50j si dispo, sinon volume jour). */
export function dollarVolumeUsd(close: number, avgVol50d?: number, volume?: number): number {
  const shareVol = avgVol50d && avgVol50d > 0 ? avgVol50d : (volume ?? 0);
  return close > 0 && shareVol > 0 ? close * shareVol : 0;
}

/**
 * true si le candidat passe le plancher de liquidité.
 *   - minUsd <= 0 → gate désactivé (pass).
 *   - dollarVol <= 0 (volume indispo) → fail-open (pass) : on ne bloque pas un
 *     nom légitime sur un trou de données screener.
 *   - sinon → pass ssi dollarVol >= minUsd.
 */
export function passesLiquidityFloor(dollarVol: number, minUsd: number): boolean {
  if (minUsd <= 0) return true;
  if (dollarVol <= 0) return true;
  return dollarVol >= minUsd;
}
