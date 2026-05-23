/**
 * Trailing-stop break-even — récupère le giveback MFE → exit.
 *
 * Constat data 15j (23/05/2026, n=20 stops avec peak_pre_exit) :
 *   - MFE mean +0.48% atteint AVANT exit
 *   - PnL mean -1.98% à l'exit
 *   - Giveback +2.38% par trade → ~$529 cumulés laissés sur la table
 *
 * Stratégie : dès que la position touche `entry × (1 + activationPct)`, on remonte
 * le stop à `entry × (1 + lockPct)` pour ne plus reperdre la totalité du gain.
 * Asymétrique : lockPct petit (couvre frais ~0.05%) sécurise la position en
 * "presque breakeven" sans sortir prématurément. Si peak continue de monter,
 * une variante future (Phase D2) pourra trailing au peak - X%.
 *
 * Fonction PURE : pas d'I/O, testable trivialement.
 * Renvoie le nouveau stop_loss_price OU null si pas d'update à faire.
 */

export function computeBreakEvenStopUpdate(args: {
  isLong: boolean;
  entry: number;
  /** Pic favorable observé (long = max, short = min). Inclut le prix courant. */
  peak: number;
  /** Stop courant en DB (null = pas de stop configuré). */
  currentStop: number | null;
  /** Seuil de déclenchement (long = +X%, short = -X%). Default suggéré 0.003 (0.3%). */
  activationPct: number;
  /** Niveau verrouillé après activation (long = +Y%, short = -Y%). Default 0.0005. */
  lockPct: number;
}): number | null {
  const { isLong, entry, peak, currentStop, activationPct, lockPct } = args;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(peak) || peak <= 0) return null;
  if (!Number.isFinite(activationPct) || activationPct <= 0) return null;
  if (!Number.isFinite(lockPct)) return null;

  if (isLong) {
    const activationPrice = entry * (1 + activationPct);
    const lockPrice = entry * (1 + lockPct);
    // Pas encore atteint le seuil d'activation
    if (peak < activationPrice) return null;
    // Le stop est déjà au lock ou au-dessus → rien à faire (évite log spam à chaque tick)
    if (currentStop !== null && currentStop >= lockPrice) return null;
    return lockPrice;
  }

  // SHORT mirror : le pic favorable est le min observé
  const activationPrice = entry * (1 - activationPct);
  const lockPrice = entry * (1 - lockPct);
  if (peak > activationPrice) return null;
  if (currentStop !== null && currentStop <= lockPrice) return null;
  return lockPrice;
}
