/**
 * PR #296 — Helper pure pour vérifier si un instant donné tombe dans la
 * session active de l'exchange du ticker.
 *
 * Use case : avant le shadow simulator fetch (qui essaie 4 endpoints EODHD),
 * skip immédiatement les captures hors session. Économise ~6 API calls par
 * row hors session, et label `OFF_SESSION_CAPTURE` (vs `OFF_SESSION_STALE_DATA`
 * pour les rows pendant session où EODHD est juste stale).
 *
 * Conversion UTC → local TZ : `Intl.DateTimeFormat` avec IANA TZ. DST géré
 * nativement (March/November transitions US, March/October EU, etc.).
 *
 * Holidays NON gérés (scope future PR). Cf. exchange-sessions.config.ts.
 */

import {
  EXCHANGE_SESSIONS,
  ALWAYS_ON_SUFFIXES,
  NYSE_FULL_HOLIDAYS_2026,
  type ExchangeSession,
} from './exchange-sessions.config';

/**
 * Extrait le suffixe `.XXX` d'un ticker EODHD. Retourne null si pas de point.
 *   'AAPL.US' → '.US'
 *   '0700.HK' → '.HK'
 *   '600519.SHG' → '.SHG'
 *   'BTC-USD.CC' → '.CC'
 *   'BTCUSDT' → null  (no suffix = crypto Binance pair)
 *   'AAPL' → null     (treated as US default by EODHD but no suffix here)
 */
export function extractSuffix(symbol: string): string | null {
  if (!symbol) return null;
  const lastDot = symbol.lastIndexOf('.');
  if (lastDot === -1) return null;
  return symbol.slice(lastDot).toUpperCase();
}

/**
 * Détermine le jour de la semaine (0=dim, 1=lun, ..., 6=sam) pour un Date
 * dans la TZ locale spécifiée.
 *
 * `Intl.DateTimeFormat` avec `weekday: 'short'` retourne 'Sun', 'Mon', etc.
 * On map vers 0-6.
 */
function getLocalWeekday(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const day = fmt.format(date);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[day] ?? -1;
}

/**
 * Récupère l'heure et minute locales (HH, mm) dans la TZ spécifiée.
 *
 * Utilise `Intl.DateTimeFormat` qui gère DST automatiquement via IANA TZ.
 * Retourne { h: number, m: number } en 24h-format.
 */
function getLocalHourMinute(date: Date, tz: string): { h: number; m: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? -1);
  return { h, m };
}

/**
 * Récupère la date locale au format YYYY-MM-DD dans la TZ spécifiée.
 * Utilisé pour matcher contre NYSE_FULL_HOLIDAYS_2026.
 */
function getLocalDateString(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {  // 'en-CA' uses YYYY-MM-DD format
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/** Parse "HH:mm" → { h, m }. Hardcoded format trusted from config. */
function parseTimeString(s: string): { h: number; m: number } {
  const [hh, mm] = s.split(':');
  return { h: Number(hh), m: Number(mm) };
}

/** Convertit { h, m } en minutes depuis minuit pour comparaison numérique. */
function toMinutes({ h, m }: { h: number; m: number }): number {
  return h * 60 + m;
}

/**
 * Vérifie si un timestamp donné tombe pendant la session active de
 * l'exchange du ticker.
 *
 * @param symbol — ticker EODHD ('AAPL.US', '7203.T', 'BTC-USD.CC', ...)
 * @param at — timestamp à tester (Date | ISO string | epoch seconds | epoch ms)
 * @returns true si dans session, false sinon. Crypto/FX/commodities → true.
 *
 * Comportement :
 *   - Suffixe inconnu → `false` (conservatif, évite faux positifs)
 *   - Crypto/FX/commodities (.CC, .FOREX, .COMM, .INDX) → `true` toujours
 *   - Symbol sans suffixe (no dot) → `false` (pas dans table EODHD)
 *   - Weekend dans TZ locale → `false`
 *   - Hors window [open, close) en TZ locale → `false`
 */
export function isInExchangeSession(symbol: string, at: Date | string | number): boolean {
  if (!symbol) return false;

  const suffix = extractSuffix(symbol);
  if (suffix === null) return false;  // No suffix = treated as US by EODHD but unsafe to assume

  // Always-on classes (crypto, FX, commodities, indices)
  if (ALWAYS_ON_SUFFIXES.has(suffix)) return true;

  const session: ExchangeSession | undefined = EXCHANGE_SESSIONS[suffix];
  if (!session) return false;  // Unknown suffix → conservative false

  // Normalize `at` to Date
  let date: Date;
  if (at instanceof Date) {
    date = at;
  } else if (typeof at === 'number') {
    // Distinguish epoch seconds vs ms : seconds < 10_000_000_000
    date = new Date(at < 1e10 ? at * 1000 : at);
  } else {
    date = new Date(at);
  }
  if (Number.isNaN(date.getTime())) return false;

  // Weekend check in exchange local TZ
  const weekday = getLocalWeekday(date, session.tz);
  if (weekday === 0 || weekday === 6) return false;  // Sun / Sat

  // Holiday check (NYSE-only v1, applies to .US and .TO which mostly aligns)
  if (suffix === '.US' || suffix === '.TO') {
    const localDateStr = getLocalDateString(date, session.tz);
    if (NYSE_FULL_HOLIDAYS_2026.has(localDateStr)) return false;
  }

  // Hour/minute window check
  const local = getLocalHourMinute(date, session.tz);
  const localMin = toMinutes(local);
  const openMin = toMinutes(parseTimeString(session.open));
  const closeMin = toMinutes(parseTimeString(session.close));

  return localMin >= openMin && localMin < closeMin;
}
