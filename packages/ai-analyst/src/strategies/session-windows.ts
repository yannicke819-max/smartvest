/**
 * P4-A — Helpers session-window pure.
 *
 * Check si une heure UTC tombe dans la fenêtre [open, close] d'une bourse.
 * Pure function, testable sans I/O.
 */

export interface SessionWindow {
  /** Heure ouverture UTC, format "HH:MM". */
  openUtc: string;
  /** Heure clôture UTC, format "HH:MM". */
  closeUtc: string;
}

/**
 * Vérifie si `now` (Date) tombe dans la fenêtre. Compare en minutes UTC.
 * Si openUtc > closeUtc (cas pathologique cross-midnight), retourne false
 * — les bourses utilisées ne traversent jamais minuit UTC.
 */
export function isWithinSession(now: Date, win: SessionWindow): boolean {
  const o = parseHm(win.openUtc);
  const c = parseHm(win.closeUtc);
  if (o === null || c === null) return false;
  if (o >= c) return false; // cross-midnight non supporté
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= o && m <= c;
}

/**
 * Concatène les tickers de toutes les watchlists actives à `now`.
 * Tickers dédupliqués — un même ticker dans plusieurs bourses (théorique,
 * surtout pour les ADR cross-listés) compte une seule fois.
 *
 * Si aucune watchlist active : fallback sur la liste US fournie pour
 * couvrir les heures hors-marché US (after-hours, pre-market) où le cron
 * peut quand même calculer les RSI sur les bars cached.
 */
export function aggregateActiveWatchlists(
  watchlists: Array<{
    name: string;
    exchange: string;
    sessionOpenUtc: string | null;
    sessionCloseUtc: string | null;
    tickers: string[];
  }>,
  now: Date,
  fallbackUsTickers?: string[],
): { active: string[]; activeExchanges: string[] } {
  const dedup = new Set<string>();
  const exchanges = new Set<string>();
  for (const wl of watchlists) {
    if (!wl.sessionOpenUtc || !wl.sessionCloseUtc) continue;
    if (!isWithinSession(now, { openUtc: wl.sessionOpenUtc, closeUtc: wl.sessionCloseUtc })) {
      continue;
    }
    for (const t of wl.tickers) dedup.add(t);
    exchanges.add(wl.exchange);
  }
  if (dedup.size === 0 && fallbackUsTickers) {
    for (const t of fallbackUsTickers) dedup.add(t);
    exchanges.add('US_AFTERHOURS');
  }
  return {
    active: Array.from(dedup),
    activeExchanges: Array.from(exchanges),
  };
}

function parseHm(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
