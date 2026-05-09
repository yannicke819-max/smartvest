/**
 * PR #296 — Configuration des sessions exchange par suffixe ticker.
 *
 * Source de vérité : `vendor/eodhd-claude-skills/skills/eodhd-api/references/general/symbol-format.md`
 * complétée par les horaires officiels exchange. Toutes les heures sont en
 * **local exchange time** (NON UTC). La conversion UTC → local TZ est faite
 * automatiquement par `Intl.DateTimeFormat` avec IANA TZ → DST géré natif.
 *
 * NOTE : Ce mapping ne traite PAS les holidays (4 juillet, Christmas, Lunar
 * New Year, etc.). En v1, accepter qu'un fetch futile sur jour férié
 * produise `OFF_SESSION_STALE_DATA` au lieu de `OFF_SESSION_CAPTURE`. Volume
 * estimé : ~10 jours/an × ~50 captures/exchange = négligeable face aux
 * ~978 captures/12h normales. Ajout calendar package = scope PR future.
 *
 * NOTE 2 : Pas de support extended hours (pre/post market). Les outcomes
 * 60min basés sur la liquidité extended sont peu fiables (spreads larges,
 * vol limitée). On considère pre/post comme "off session" pour la sim.
 */

export interface ExchangeSession {
  /** IANA TZ name passée à `Intl.DateTimeFormat`. DST géré nativement. */
  readonly tz: string;
  /** Open time HH:mm en local exchange time. */
  readonly open: string;
  /** Close time HH:mm en local exchange time. */
  readonly close: string;
}

/**
 * Mapping suffixe ticker (incluant le point) → session exchange.
 *
 * Conventions EODHD officielles (cf. CLAUDE.md §EODHD API Reference) :
 *   - .US = NYSE/NASDAQ/AMEX (US equities)
 *   - .T = TSE Tokyo
 *   - .HK = HKEX (Hong Kong, leading zeros e.g. 0700.HK)
 *   - .KO = KOSPI (Korea main board)
 *   - .KQ = KOSDAQ (Korea junior)
 *   - .SHG = Shanghai Stock Exchange
 *   - .SHE = Shenzhen Stock Exchange
 *   - .AU = ASX (Australia)
 *   - .L / .LSE = London Stock Exchange
 *   - .PA = Euronext Paris
 *   - .DE / .XETRA = Frankfurt
 *   - .AS = Euronext Amsterdam
 *   - .SW = SIX Swiss Exchange
 *   - .TO = TSX Toronto
 */
export const EXCHANGE_SESSIONS: Readonly<Record<string, ExchangeSession>> = {
  '.US':    { tz: 'America/New_York',    open: '09:30', close: '16:00' },
  '.T':     { tz: 'Asia/Tokyo',          open: '09:00', close: '15:00' },
  '.HK':    { tz: 'Asia/Hong_Kong',      open: '09:30', close: '16:00' },
  '.KO':    { tz: 'Asia/Seoul',          open: '09:00', close: '15:30' },
  '.KQ':    { tz: 'Asia/Seoul',          open: '09:00', close: '15:30' },
  '.SHG':   { tz: 'Asia/Shanghai',       open: '09:30', close: '15:00' },
  '.SHE':   { tz: 'Asia/Shanghai',       open: '09:30', close: '15:00' },
  '.AU':    { tz: 'Australia/Sydney',    open: '10:00', close: '16:00' },
  '.L':     { tz: 'Europe/London',       open: '08:00', close: '16:30' },
  '.LSE':   { tz: 'Europe/London',       open: '08:00', close: '16:30' },
  '.PA':    { tz: 'Europe/Paris',        open: '09:00', close: '17:30' },
  '.AS':    { tz: 'Europe/Amsterdam',    open: '09:00', close: '17:30' },
  '.DE':    { tz: 'Europe/Berlin',       open: '09:00', close: '17:30' },
  '.XETRA': { tz: 'Europe/Berlin',       open: '09:00', close: '17:30' },
  '.SW':    { tz: 'Europe/Zurich',       open: '09:00', close: '17:30' },
  '.TO':    { tz: 'America/Toronto',     open: '09:30', close: '16:00' },
  '.NSE':   { tz: 'Asia/Kolkata',        open: '09:15', close: '15:30' },
  '.BSE':   { tz: 'Asia/Kolkata',        open: '09:15', close: '15:30' },
};

/**
 * Suffixes considérés "always-on" : crypto, FX, commodities. Pas de session
 * fermée → isInExchangeSession returns true par défaut.
 */
export const ALWAYS_ON_SUFFIXES: ReadonlySet<string> = new Set([
  '.CC',     // crypto EODHD
  '.FOREX',  // FX EODHD
  '.COMM',   // commodities EODHD
  '.INDX',   // indices (généralement always-quoted en intraday)
]);

/**
 * NYSE holidays — minimal subset des fermetures complètes (skip-list).
 * Support v1 uniquement pour US (.US, .TO suit globalement le calendrier US).
 * Format : 'YYYY-MM-DD' en local NY date.
 *
 * Limitations v1 :
 *   - Pas de support early-close (Christmas Eve, Black Friday)
 *   - Pas de support holidays Asia/EU exchanges
 *   - Maintenu manuellement (~10 dates/an, low-effort)
 *
 * Future PR : intégrer `date-holidays` package pour cover all exchanges.
 *
 * Source : NYSE official 2026 calendar (https://www.nyse.com/markets/hours-calendars).
 */
export const NYSE_FULL_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01',  // New Year's Day
  '2026-01-19',  // MLK Day (3rd Mon Jan)
  '2026-02-16',  // Presidents' Day (3rd Mon Feb)
  '2026-04-03',  // Good Friday
  '2026-05-25',  // Memorial Day (last Mon May)
  '2026-06-19',  // Juneteenth
  '2026-07-03',  // Independence Day observed (July 4 = Saturday → observed Friday)
  '2026-09-07',  // Labor Day (1st Mon Sept)
  '2026-11-26',  // Thanksgiving (4th Thu Nov)
  '2026-12-25',  // Christmas Day
]);
