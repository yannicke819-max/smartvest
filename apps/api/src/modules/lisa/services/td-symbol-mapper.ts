/**
 * PR #355 — Helper pur de mapping symbol EODHD → TwelveData.
 *
 * Centralisé pour éviter la duplication entre :
 *   - IntradayProviderRouter.convertToTdSymbol (dual-call quote/candles)
 *   - evaluateTwelveDataFilters (Supertrend US 30m)
 *   - Tout futur consommateur TD intraday/indicator
 *
 * Mapping :
 *   - Sans suffixe                  → ticker tel quel (US)
 *   - .US                           → ticker nu (AAPL.US → AAPL)
 *   - .L / .LSE                     → :LSE
 *   - .PA / .AS / .AMS              → :Euronext
 *   - .XETRA / .DE                  → :XETR
 *   - .SW                           → :SIX
 *   - .MI                           → :MIL
 *   - .TO                           → :TSX
 *   - .KO / .KQ                     → :KRX
 *   - .SHG                          → :SSE
 *   - .SHE                          → :SZSE
 *   - .HK                           → :HKEX
 *   - .T                            → :XTKS
 *   - .AU                           → :XASX
 *
 * Suffixe inconnu → null (caller décide : fallback EODHD, skip filter, etc.).
 *
 * Note : pour les paires crypto (BTCUSDT → BTC/USD) utiliser
 * TwelveDataService.binanceToTwelveDataCrypto (format différent).
 */

const SUFFIX_MAP: Record<string, string> = {
  US: '',
  L: ':LSE',
  LSE: ':LSE',
  PA: ':Euronext',
  AS: ':Euronext',
  AMS: ':Euronext',
  XETRA: ':XETR',
  DE: ':XETR',
  SW: ':SIX',
  MI: ':MIL',
  TO: ':TSX',
  KO: ':KRX',
  KQ: ':KRX',
  SHG: ':SSE',
  SHE: ':SZSE',
  HK: ':HKEX',
  T: ':XTKS',
  AU: ':XASX',
};

export function eodhdToTdSymbol(eodhdTicker: string): string | null {
  if (!eodhdTicker) return null;
  if (!eodhdTicker.includes('.')) return eodhdTicker;
  const [base, suffix] = eodhdTicker.split('.');
  if (!(suffix in SUFFIX_MAP)) return null;
  const tdSuffix = SUFFIX_MAP[suffix];
  return tdSuffix ? `${base}${tdSuffix}` : base;
}
