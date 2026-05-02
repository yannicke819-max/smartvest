/**
 * Helper pur pour issue #193 — détecte la session courante (RTH / pre-market /
 * after-hours / crypto 24/7) à partir d'un timestamp ISO et d'une marketClass.
 *
 * Référence horaires equity US (Section 6 quater CLAUDE.md, ADR-005 §1bis) :
 *   PRE_MARKET   : 09:00 → 14:30 UTC (= 04:00-09:30 ET)
 *   RTH          : 14:30 → 21:00 UTC (= 09:30-16:00 ET)
 *   AFTER_HOURS  : 21:00 → 01:00 UTC (= 16:00-20:00 ET)
 *
 * Crypto : toujours CRYPTO_24_7. Equity hors heures listées : UNKNOWN
 * (typiquement weekend ou jour férié US).
 */

export type SessionLabel =
  | 'RTH'
  | 'PRE_MARKET'
  | 'AFTER_HOURS'
  | 'CRYPTO_24_7'
  | 'UNKNOWN';

/** Détermine la session à partir d'un timestamp ISO + market class. */
export function detectSession(
  timestamp: string,
  marketClass: 'equity' | 'crypto',
): SessionLabel {
  if (marketClass === 'crypto') return 'CRYPTO_24_7';

  let dt: Date;
  try {
    dt = new Date(timestamp);
    if (isNaN(dt.getTime())) return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }

  // Weekend : equity US fermé samedi-dimanche entiers
  const dayUtc = dt.getUTCDay();
  if (dayUtc === 0 || dayUtc === 6) return 'UNKNOWN';

  const minutesUtc = dt.getUTCHours() * 60 + dt.getUTCMinutes();

  // PRE_MARKET : 09:00 (540) → 14:30 (870) UTC
  if (minutesUtc >= 540 && minutesUtc < 870) return 'PRE_MARKET';
  // RTH : 14:30 (870) → 21:00 (1260) UTC
  if (minutesUtc >= 870 && minutesUtc < 1260) return 'RTH';
  // AFTER_HOURS : 21:00 (1260) → 24:00 (1440) UTC, OU 00:00 → 01:00 (60)
  if (minutesUtc >= 1260 || minutesUtc < 60) return 'AFTER_HOURS';

  // 01:00 → 09:00 UTC : marché US fermé (overnight)
  return 'UNKNOWN';
}
