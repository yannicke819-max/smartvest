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
 * Bug #R10 + PR #337 — Blacklist statique de tickers EODHD confirmés inutiles :
 *   1. .NSE morts (HTTP 404 persistant ≥ 7j, mesure 15/05/2026, ~81k calls/7j gaspillés)
 *   2. Asia empty-response permanents (HTTP 200 + body vide, ~62k calls/7j gaspillés,
 *      0 prix jamais retourné sur 7j, 0 accept sur 30j) — mesure 17/05/2026
 *   3. Saigneur asia (222420.KQ : 102 SL / 0 TP sur 30j, PnL -$3582 = -$119/j) —
 *      blacklist proactive pour arrêt hémorragie immédiat
 *
 * À retirer si EODHD republie la data ou si un ticker prouve de la valeur via
 * audit manuel. Le `002900.KO` reste autorisé (seul .KO/.KQ rentable mesuré
 * sur 30j : +$177.51 / 33 % WR).
 */
export const DEAD_TICKERS_STATIC: ReadonlySet<string> = new Set<string>([
  // --- .NSE morts (R10 original, 9 tickers) ---
  'BHEL.NSE',
  'CESC.NSE',
  'GHCL.NSE',
  'HEG.NSE',
  'IGPL.NSE',
  'NESCO.NSE',
  'NITCO.NSE',
  'NOCIL.NSE',
  'SOTL.NSE',

  // --- Asia empty-response permanents (PR #337, 13 tickers) ---
  // Mesure 17/05/2026 : 4000-4750 calls/7j chacun, 100 % empty, 0 accept sur 30j.
  '000500.KO',
  '003550.KO',
  '005070.KO',
  '005300.KO',
  '016360.KO',
  '093370.KO',
  '039830.KQ',
  '045390.KQ',
  '047770.KQ',
  '059120.KQ',
  '088800.KQ',
  '094360.KQ',
  '200710.KQ',

  // --- Asia saigneur (PR #337, 1 ticker) ---
  // 222420.KQ : 102 SL / 0 TP sur 30j, PnL -$3582 (-$119/j). Arrêt hémorragie.
  '222420.KQ',

  // --- PR #355 (19/05/2026) — 31 tickers récurrents 404/empty 24h ---
  // Audit Supabase 19/05 9h30 : ~9000 calls gaspillés/24h (9% quota EODHD)
  // sur ces 31 tickers, 0 accept sauf résidus. R10 dynamic ne triggered pas
  // car les réponses sont majoritairement HTTP 200 + body empty (cf. fix
  // recordStrike empty-response simultané, eodhd-intraday.service.ts).
  // À retirer si EODHD republie data ou si audit manuel prouve valeur.
  // `002900.KO` volontairement conservé (preuve TP positive 30j).

  // Asia KOSPI/KOSDAQ (12 tickers, 70+ strikes/24h chacun)
  '003690.KO',
  '001450.KO',
  '080220.KQ',
  '066430.KQ',
  '412350.KQ',
  '274090.KQ',
  '211270.KQ',
  '027360.KQ',
  '036930.KQ',
  '446540.KQ',
  '032580.KQ',
  '092190.KQ',

  // Asia Shanghai/Shenzhen (4 tickers)
  '600500.SHG',
  '600578.SHG',
  '002421.SHE',
  '300259.SHE',

  // Asia saigneurs PnL négatif fort + 404 récurrent (4 tickers)
  // 295310.KQ : -$136 sur 7 positions, 4 SL dont -5.37% en 1.8min
  // 100790.KQ : -$153 sur 5 positions, 2 SL dont -7.69% en 14min
  // 321370.KQ : -$13.82 sur 6 positions, 17% rate 404
  // 601678.SHG : -$65.99 sur 2 positions
  '295310.KQ',
  '100790.KQ',
  '321370.KQ',
  '601678.SHG',

  // EU LSE saigneur + obscurs (4 tickers)
  // SCLP.LSE : -$170.74 sur 7 positions, penny stock pump-and-dump
  'SCLP.LSE',
  'PANR.LSE',
  'ABDN.LSE',
  'GAMA.LSE',

  // US/TO obscurs (7 tickers, calls élevés 0 accept)
  'ENPH.US',
  'PZZA.US',
  'TTGT.US',
  'AXTI.US',
  'BLDP.TO',
  'KEY.TO',
  'SDE.TO',

  // --- PR #363 (19/05/2026 19h UTC) — Double blacklist QW#6 + fetch-level ---
  // QW#6 (qw-6-symbol-blacklist.service.ts) bloque l'OUVERTURE de position via
  // env QW_6_SYMBOL_BLACKLIST mais NE STOPPE PAS le fetch EODHD intraday.
  // Conséquence : PODD/CGNX/ORA/QCOM/ST/PRU consomment ~65 calls/24h chacun
  // pour 0 position ouverte. Cette section les bloque AUSSI au niveau scanner
  // upstream (fetch-level) pour économiser ~700 calls EODHD/24h.
  // EXLS et 3 autres US ajoutés en plus (audit 19/05 19h UTC : 14 erreurs
  // 404/24h chacun, 0 accept, 0 ou 2 positions losing).
  // DXCM.US volontairement CONSERVÉ malgré 17 erreurs/24h : 1 accept 24h,
  // 1 TP / 0 SL sur 30j (+$20.58, productif) → bloquer serait perdre alpha.

  // QW#6 backlist (6 tickers) — déjà bloqués à l'OUVERTURE, ajout fetch-level
  // Audit 19/05/2026 19h UTC : 65-100 calls/24h chacun, 0 accept réel
  'PODD.US', // QW#6 + 14 err/24h, 65 calls/24h, 0 accept, 9 positions 30j 0 TP/4 SL (-$24)
  'CGNX.US', // QW#6 + tendance similaire PODD
  'ORA.US',  // QW#6
  'QCOM.US', // QW#6
  'ST.US',   // QW#6
  'PRU.US',  // QW#6

  // Saigneurs US non-QW#6 (audit 19/05 19h UTC, 0 accept/24h, 0 TP)
  'EXLS.US', // 14 err/24h, 69 calls/24h, 0 accept, 0 position 30j → pur gaspillage
  'CTSH.US', // 14 err/24h, 234 calls/24h, 2 accept, 2 positions 30j 0 TP/1 SL (-$24.86)
  'KBR.US',  // 13 err/24h, 256 calls/24h, 2 accept, 2 positions 30j 0 TP/1 SL (-$26.91)
]);

/**
 * @deprecated Utiliser `DEAD_TICKERS_STATIC`. Alias gardé pour backward-compat
 *   avec les callers existants (TickerBlacklistService, tests).
 */
export const DEAD_NSE_TICKERS: ReadonlySet<string> = DEAD_TICKERS_STATIC;

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
