/**
 * Bug #R9 / #R10 — Universe pre-filter (session + dead-ticker blacklist).
 *
 * Évite les fetches EODHD intraday inutiles AVANT la phase de fetch (le filtre
 * de session était historiquement appliqué APRÈS les fetches dans le scanner
 * top-gainers). Mesure 15/05/2026 : ~23k calls EODHD/jour gaspillés sur des
 * tickers Asia (.KO/.KQ/.SHE) hors session + ~11.5k calls/jour sur 9 tickers
 * .NSE morts qui répondent en HTTP 404 depuis 7+ jours.
 *
 * Pure fonctions — aucune dépendance NestJS. Tests live dans
 * `__tests__/session-filter.spec.ts`.
 *
 * Out of scope :
 *   - Persistance Supabase des strikes 404 (cf. TickerBlacklistService côté apps/api).
 *   - Réécriture de `isMarketOpen` dans le scanner (back-compat préservée).
 */

export type MarketSessionClass = 'us' | 'eu' | 'asia' | 'crypto';

/**
 * Plages horaires UTC par classe de marché. Dupliqué volontairement du scanner
 * pour ne pas mélanger la migration. Lun-Ven uniquement pour US/EU/Asia.
 */
export const MARKET_SESSION_HOURS: Record<
  Exclude<MarketSessionClass, 'crypto'>,
  { openUtcMin: number; closeUtcMin: number }
> = {
  us:   { openUtcMin: 14 * 60 + 30, closeUtcMin: 21 * 60 },
  eu:   { openUtcMin:  8 * 60,      closeUtcMin: 16 * 60 + 30 },
  asia: { openUtcMin:  0,           closeUtcMin:  8 * 60 },
};

/**
 * True si la classe est ouverte à `now` UTC. `crypto` est toujours `true`.
 * Week-end fermé pour US/EU/Asia.
 */
export function isMarketOpenForClass(cls: MarketSessionClass, now: Date): boolean {
  if (cls === 'crypto') return true;
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { openUtcMin, closeUtcMin } = MARKET_SESSION_HOURS[cls];
  return min >= openUtcMin && min < closeUtcMin;
}

/**
 * Mapping suffixe ticker → classe de marché. Source : CLAUDE.md §EODHD +
 * vendor/eodhd-claude-skills/skills/eodhd-api/references/general/symbol-format.md.
 *
 * Tickers Binance (USDT/USDC pair) → 'crypto' via match BTCUSDT/ETHUSDT/etc.
 * Tickers sans `.` → présumés US (legacy EODHD format SYMBOL only).
 *
 * Retourne `null` quand le marché ne peut pas être déterminé — le caller doit
 * traiter ce cas explicitement (par défaut le pre-filter laisse passer).
 */
export function marketForSymbol(symbol: string): MarketSessionClass | null {
  if (!symbol) return null;
  const upper = symbol.toUpperCase();
  // Crypto majors Binance : 10 paires whitelistées dans le scanner.
  if (/^(BTC|ETH|BNB|SOL|XRP|ADA|AVAX|DOT|LINK|POL|MATIC|DOGE|TRX)(USDT|USDC|USD|BUSD)$/.test(upper)) {
    return 'crypto';
  }
  if (upper.endsWith('-USD.CC') || upper.endsWith('.CC')) return 'crypto';
  if (!upper.includes('.')) return 'us';
  const suffix = upper.split('.').pop()!;
  // US + Canada (NYSE/NASDAQ/TSX hours align)
  if (['US', 'NYSE', 'NASDAQ', 'TO', 'V'].includes(suffix)) return 'us';
  // EU (Euronext, LSE, XETRA, SIX, etc.)
  if (['LSE', 'L', 'PA', 'XETRA', 'DE', 'F', 'SW', 'MI', 'MC', 'BME', 'AS', 'AMS', 'BR', 'LS', 'VI', 'HE', 'ST', 'CO', 'OL', 'IC', 'WS', 'IR'].includes(suffix)) return 'eu';
  // Asia (TSE, HKEX, KRX, SSE/SZSE, India, ASX)
  if (['T', 'TSE', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'SS', 'SZ', 'AU', 'AX', 'NSE', 'BSE', 'TW', 'JK', 'BK', 'SI'].includes(suffix)) return 'asia';
  // FOREX / commodities → pas de session class (24/5)
  if (['FOREX', 'COMM', 'INDX'].includes(suffix)) return null;
  return null;
}

/**
 * Bug #R10 — Blacklist statique de tickers .NSE morts confirmés HTTP 404
 * depuis 7+ jours (mesure 15/05/2026, ~81 000 calls EODHD gaspillés sur cette
 * fenêtre seule). Ces tickers ne reviennent pas — soit délistés EODHD, soit
 * symbol convention NSE différente. À retirer si EODHD republie la data.
 */
export const DEAD_NSE_TICKERS: ReadonlySet<string> = new Set<string>([
  'BHEL.NSE',
  'CESC.NSE',
  'GHCL.NSE',
  'HEG.NSE',
  'IGPL.NSE',
  'NESCO.NSE',
  'NITCO.NSE',
  'NOCIL.NSE',
  'SOTL.NSE',
]);

export interface FilterOptions {
  now: Date;
  /** Active la blacklist statique `DEAD_NSE_TICKERS`. Default `true`. */
  staticBlacklistEnabled?: boolean;
  /**
   * Hook auto-blacklist dynamique (strikes 404 sur fenêtre 24h). Le caller
   * (TickerBlacklistService) fournit la callback ; retourne `true` si le
   * ticker doit être skip ce cycle.
   */
  isDynamicallyBlacklisted?: (symbol: string) => boolean;
  /**
   * Universe per-portfolio toggle. Default tous ouverts. Permet au caller
   * d'appliquer le toggle UI (universeUs/universeEu/universeAsia/universeCrypto)
   * dans le même passage pré-fetch sans rescanner la liste deux fois.
   */
  universeAllowed?: Partial<Record<MarketSessionClass, boolean>>;
}

export interface FilterResult {
  /** Tickers qui doivent être fetchés (marché ouvert + non blacklistés). */
  kept: string[];
  /** Tickers droppés par classe à cause de session fermée. */
  droppedSessionClosed: Record<MarketSessionClass, string[]>;
  /** Tickers droppés par blacklist statique DEAD_NSE_TICKERS. */
  droppedStaticBlacklist: string[];
  /** Tickers droppés par auto-blacklist dynamique (404 strikes). */
  droppedDynamicBlacklist: string[];
  /** Tickers droppés par universe toggle (us=false / asia=false…). */
  droppedUniverseToggle: string[];
  /** Tickers laissés passer faute de mapping marché (warn debug only). */
  passedUnknownMarket: string[];
}

/**
 * Applique session-filter + blacklist sur une liste de tickers, BEFORE tout
 * appel EODHD intraday. Pas d'I/O — pure function.
 *
 * Convention :
 *   1. Statique blacklist (DEAD_NSE_TICKERS) coupe en premier — c'est mort,
 *      pas la peine d'évaluer la session.
 *   2. Auto-blacklist dynamique en deuxième.
 *   3. Universe toggle utilisateur (universeUs=false → drop tous les us_*).
 *   4. Session check (asia closed at 11:40 UTC → drop .KO/.KQ/.SHE/etc).
 *   5. Unknown market → kept (conservateur, on ne casse rien).
 */
export function filterTickersForFetch(
  symbols: readonly string[],
  options: FilterOptions,
): FilterResult {
  const result: FilterResult = {
    kept: [],
    droppedSessionClosed: { us: [], eu: [], asia: [], crypto: [] },
    droppedStaticBlacklist: [],
    droppedDynamicBlacklist: [],
    droppedUniverseToggle: [],
    passedUnknownMarket: [],
  };

  const staticEnabled = options.staticBlacklistEnabled !== false;
  const universe = options.universeAllowed ?? {};

  for (const symbol of symbols) {
    if (staticEnabled && DEAD_NSE_TICKERS.has(symbol.toUpperCase())) {
      result.droppedStaticBlacklist.push(symbol);
      continue;
    }
    if (options.isDynamicallyBlacklisted?.(symbol)) {
      result.droppedDynamicBlacklist.push(symbol);
      continue;
    }
    const cls = marketForSymbol(symbol);
    if (cls == null) {
      result.passedUnknownMarket.push(symbol);
      result.kept.push(symbol);
      continue;
    }
    if (universe[cls] === false) {
      result.droppedUniverseToggle.push(symbol);
      continue;
    }
    if (!isMarketOpenForClass(cls, options.now)) {
      result.droppedSessionClosed[cls].push(symbol);
      continue;
    }
    result.kept.push(symbol);
  }
  return result;
}

/**
 * Format de log structuré pour le scanner :
 *   `[SESSION_FILTER] skipped 17 asia, 0 us, 9 nse_blacklisted (saved ~26 EODHD calls)`
 *
 * `multiplierPerSymbol` = nb d'appels EODHD typiques par ticker en aval
 * (ex : mtfPersistence appelle `getCandles` 1× pour 5m → multiplier=1 ; si
 * downstream fetch aussi 1m candles → multiplier=2). Default 1.
 */
export function formatFilterLog(
  result: FilterResult,
  multiplierPerSymbol = 1,
): string {
  const parts: string[] = [];
  for (const cls of ['us', 'eu', 'asia', 'crypto'] as const) {
    const n = result.droppedSessionClosed[cls].length;
    if (n > 0) parts.push(`${n} ${cls}`);
  }
  if (result.droppedStaticBlacklist.length > 0) {
    parts.push(`${result.droppedStaticBlacklist.length} nse_blacklisted`);
  }
  if (result.droppedDynamicBlacklist.length > 0) {
    parts.push(`${result.droppedDynamicBlacklist.length} auto_blacklisted`);
  }
  if (result.droppedUniverseToggle.length > 0) {
    parts.push(`${result.droppedUniverseToggle.length} universe_toggle`);
  }
  const skippedTotal =
    Object.values(result.droppedSessionClosed).reduce((s, arr) => s + arr.length, 0)
    + result.droppedStaticBlacklist.length
    + result.droppedDynamicBlacklist.length
    + result.droppedUniverseToggle.length;
  const savedCalls = skippedTotal * multiplierPerSymbol;
  return `[SESSION_FILTER] skipped ${parts.join(', ') || '0'} (saved ~${savedCalls} EODHD calls)`;
}
