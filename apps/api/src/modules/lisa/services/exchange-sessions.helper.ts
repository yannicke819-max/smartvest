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
  HOLIDAYS_BY_SUFFIX,
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

  // Holiday check par exchange (extended 25/05/2026 — triple holiday detected).
  // Avant : NYSE-only. Maintenant : .US, .L/.LSE, .PA, .AS/.AMS, .MI, .MC/.BME,
  // .SW, .DE/.XETRA. Asia/.TO/.NSE pas couverts (calendriers complexes,
  // follow-up si besoin observé).
  const holidaySet = HOLIDAYS_BY_SUFFIX.get(suffix);
  if (holidaySet) {
    const localDateStr = getLocalDateString(date, session.tz);
    if (holidaySet.has(localDateStr)) return false;
  }

  // Hour/minute window check
  const local = getLocalHourMinute(date, session.tz);
  const localMin = toMinutes(local);
  const openMin = toMinutes(parseTimeString(session.open));
  const closeMin = toMinutes(parseTimeString(session.close));

  return localMin >= openMin && localMin < closeMin;
}

/**
 * PR #634 — Garde "skip appel EODHD" SÛRE pour gater les consommateurs de prix.
 *
 * Retourne `true` UNIQUEMENT quand le marché du ticker est **connu ET fermé**
 * (week-end, hors horaires de session DST-aware, OU jour férié de SA bourse).
 *
 * FAIL-OPEN volontaire (≠ isInExchangeSession qui est fail-closed) : tout ce
 * qu'on ne classe pas avec certitude comme equity-fermé renvoie `false` (= NE
 * PAS skip). Cela préserve l'invariant "100% fonctionnel" : on ne coupe jamais
 * un appel sur un actif always-on, un suffixe inconnu, ou un symbole sans
 * suffixe — on préfère un appel EODHD de trop qu'un prix manquant sur position.
 *
 *   - sans suffixe (BTCUSDT, AAPL legacy)      → false (fail-open)
 *   - always-on (.CC/.FOREX/.COMM/.INDX)       → false (24/7)
 *   - suffixe equity inconnu (pas dans EXCHANGE_SESSIONS) → false (fail-open)
 *   - equity connu en session                  → false (ouvert, ne pas skip)
 *   - equity connu hors session / WE / férié   → true  (fermé, skip OK)
 *
 * Fériés couverts : US (NYSE) + EU (LSE, Euronext, SIX, XETRA) via
 * HOLIDAYS_BY_SUFFIX. Asia/.TO/.NSE : week-end + horaires gardés, fériés non
 * couverts (fail-open sur leurs fériés → appel de trop ces jours-là, sans
 * risque de blocage). Cf. HOLIDAYS_BY_SUFFIX (follow-up calendriers Asia).
 */
export function isKnownMarketClosed(symbol: string, at: Date | string | number): boolean {
  if (!symbol) return false;
  const suffix = extractSuffix(symbol);
  if (suffix === null) return false;             // crypto Binance / legacy no-suffix → fail-open
  if (ALWAYS_ON_SUFFIXES.has(suffix)) return false; // crypto/fx/commodity/index → 24/7
  if (!EXCHANGE_SESSIONS[suffix]) return false;  // equity à suffixe inconnu → fail-open
  // Equity à suffixe CONNU : fermé = hors session (week-end + horaires + férié bourse).
  return !isInExchangeSession(symbol, at);
}

/**
 * PR #635 — Détecte UNIQUEMENT le cas "jour férié de la bourse du ticker"
 * (≠ week-end, ≠ hors-horaires). Complément ADDITIF aux gardes week-end/horaires
 * existantes (isMarketOpenForClass dans getCandles/getQuote, isMarketOpen dans
 * fetchLivePriceInner) : ces gardes ignorent les fériés → un jour férié EN
 * SÉANCE, l'appel EODHD passait (close EOD figé = gaspillage). Ce helper le
 * coupe SANS toucher au comportement horaire existant.
 *
 * Fail-open : suffixe sans calendrier (Asia/.TO/.NSE, inconnu), crypto/fx/
 * commodity, sans suffixe → false (ne PAS skip). Couvre US (NYSE) + EU
 * (LSE/Euronext/SIX/XETRA) via HOLIDAYS_BY_SUFFIX.
 */
export function isKnownMarketHoliday(symbol: string, at: Date | string | number): boolean {
  if (!symbol) return false;
  const suffix = extractSuffix(symbol);
  if (suffix === null) return false;
  const holidaySet = HOLIDAYS_BY_SUFFIX.get(suffix);
  if (!holidaySet) return false;            // pas de calendrier pour cette bourse → fail-open
  const session = EXCHANGE_SESSIONS[suffix];
  if (!session) return false;
  let date: Date;
  if (at instanceof Date) date = at;
  else if (typeof at === 'number') date = new Date(at < 1e10 ? at * 1000 : at);
  else date = new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  return holidaySet.has(getLocalDateString(date, session.tz));
}

/**
 * P19-EXT (25/05/2026) — Détecte si TOUTES les bourses majeures (US + UK + EU
 * + CH + DE) sont fermées pour férié à l'instant donné.
 *
 * Utilisé par AdaptiveSelectivity pour ne PAS dégrader trajectoryStatus en
 * HORS_TRAJECTOIRE quand aucun trading n'était possible (PnL négatif récent
 * s'explique alors par positions stagnantes sur holiday, pas par mauvaises
 * décisions). Sans ça, lundi 25/05/2026 triple-holiday aurait basculé en
 * HORS_TRAJECTOIRE injustement.
 *
 * Crypto exempt (always-on) — donc "all major equity markets closed" ne
 * signifie pas "trading impossible total".
 */
export function isAllMajorMarketsClosed(at: Date | string | number): boolean {
  // Symbols-types représentatifs des bourses principales pour stocks
  const majorSymbols = [
    'AAPL.US',    // NYSE / NASDAQ
    'VOD.L',      // LSE
    'NANO.PA',    // Euronext Paris
    'AMS.SW',     // SIX Swiss
    'SAP.XETRA',  // XETRA Frankfurt
  ];
  // Si AUCUN n'est ouvert, c'est un jour fermé universel.
  return majorSymbols.every((s) => !isInExchangeSession(s, at));
}

/**
 * Minutes restantes avant la fermeture de la session de l'exchange du ticker,
 * en TZ locale (DST-safe). Sert au force-close-before-close PAR BOURSE (vs le
 * bloc agrégé Asie 00:00-08:00 qui fermait les coréennes à 07:45 au lieu de 06:30).
 *
 * @returns
 *   - `number ≥ 0` : minutes jusqu'à close si l'instant est DANS la session.
 *   - `null` : pas de suffixe, suffixe inconnu, always-on (crypto/fx/commodity),
 *     weekend, ou hors session (déjà fermé / pas encore ouvert).
 *
 * Le caller distingue « approche de close » (valeur ≤ offset) de « hors session »
 * (null) selon son besoin.
 */
export function minutesToExchangeClose(symbol: string, at: Date | string | number): number | null {
  if (!symbol) return null;
  const suffix = extractSuffix(symbol);
  if (suffix === null) return null;
  if (ALWAYS_ON_SUFFIXES.has(suffix)) return null; // 24/7 → pas de close
  const session: ExchangeSession | undefined = EXCHANGE_SESSIONS[suffix];
  if (!session) return null;

  let date: Date;
  if (at instanceof Date) date = at;
  else if (typeof at === 'number') date = new Date(at < 1e10 ? at * 1000 : at);
  else date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;

  const weekday = getLocalWeekday(date, session.tz);
  if (weekday === 0 || weekday === 6) return null;

  const localMin = toMinutes(getLocalHourMinute(date, session.tz));
  const openMin = toMinutes(parseTimeString(session.open));
  const closeMin = toMinutes(parseTimeString(session.close));
  if (localMin < openMin || localMin >= closeMin) return null; // hors session
  return closeMin - localMin;
}

/**
 * Minutes écoulées depuis l'ouverture de la session de l'exchange du ticker,
 * en TZ locale (DST-safe). Miroir de minutesToExchangeClose, pour le gate
 * « opening buffer » (skip les N premières minutes après l'open).
 *
 * Le bloc agrégé MARKET_SESSION_HOURS.eu (open 08:00 UTC) est l'horaire d'HIVER ;
 * en été l'EU ouvre à 07:00 UTC → le buffer bloquait ~1h de trop. Ce helper
 * lit l'open réel par bourse via IANA TZ.
 *
 * @returns minutes ≥ 0 si DANS la session ; `null` si hors session / weekend /
 *   suffixe inconnu / always-on (crypto/fx).
 */
export function minutesSinceExchangeOpen(symbol: string, at: Date | string | number): number | null {
  if (!symbol) return null;
  const suffix = extractSuffix(symbol);
  if (suffix === null) return null;
  if (ALWAYS_ON_SUFFIXES.has(suffix)) return null;
  const session: ExchangeSession | undefined = EXCHANGE_SESSIONS[suffix];
  if (!session) return null;

  let date: Date;
  if (at instanceof Date) date = at;
  else if (typeof at === 'number') date = new Date(at < 1e10 ? at * 1000 : at);
  else date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;

  const weekday = getLocalWeekday(date, session.tz);
  if (weekday === 0 || weekday === 6) return null;

  const localMin = toMinutes(getLocalHourMinute(date, session.tz));
  const openMin = toMinutes(parseTimeString(session.open));
  const closeMin = toMinutes(parseTimeString(session.close));
  if (localMin < openMin || localMin >= closeMin) return null; // hors session
  return localMin - openMin;
}
