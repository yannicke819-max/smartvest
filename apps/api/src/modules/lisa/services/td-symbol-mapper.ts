/**
 * PR #355 — Helper pur de mapping symbol EODHD → TwelveData.
 *
 * Centralisé pour éviter la duplication entre :
 *   - IntradayProviderRouter.convertToTdSymbol (dual-call quote/candles)
 *   - evaluateTwelveDataFilters (Supertrend US 30m)
 *   - Tout futur consommateur TD intraday/indicator
 *
 * Mapping validé en live le 19/05/2026 contre time_series API + symbol_search :
 *   - Sans suffixe / .US           → ticker nu (AAPL.US → AAPL)
 *   - .L / .LSE                    → :LSE   ✓ validé live
 *   - .PA / .AS / .AMS             → :Euronext ✓ validé live
 *   - .XETRA / .DE                 → :XETR  ✓ validé live
 *   - .SW                          → :SIX   ✓ validé live
 *   - .TO                          → :TSX   (doc TD officielle)
 *   - .KO / .KQ                    → :KRX   ✓ validé live (KOSDAQ/KOSPI fusionnés)
 *   - .SHG                         → :SSE   ✓ validé live
 *   - .SHE                         → :SZSE  ✓ validé live
 *
 * Suffixes non supportés sur le plan TD Pro actuel (add-ons payants requis) :
 *   - .MI  (Milan)       → null → fallback EODHD
 *   - .T   (Tokyo JPX)   → null → fallback EODHD
 *   - .HK  (HKEX)        → null → fallback EODHD
 *   - .AU  (ASX)         → null → fallback EODHD
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
  TO: ':TSX',
  KO: ':KRX',
  KQ: ':KRX',
  SHG: ':SSE',
  SHE: ':SZSE',
};

/**
 * Suffixes EODHD pointant vers des exchanges non supportés sur le plan
 * TwelveData Pro actuel (add-ons payants non souscrits). Retournent null
 * explicitement pour signaler "fallback EODHD" sans tenter d'appel TD
 * voué à un 404/403.
 *
 * Validation live 19/05/2026 :
 *   - .MI  : ENEL:MIL / MTA / XMIL tous 404
 *   - .T   : 7203:JPX / TSE / Tokyo / bare tous 404
 *   - .HK  : 0700:HKEX 404 (add-on payant)
 *   - .AU  : BHP:XASX → "You are not authorized to access XASX data. Add-on required."
 *
 * À retirer de ce Set si les add-ons TD correspondants sont souscrits.
 */
const UNSUPPORTED_TD_SUFFIXES: ReadonlySet<string> = new Set(['MI', 'T', 'HK', 'AU']);

export function eodhdToTdSymbol(eodhdTicker: string): string | null {
  if (!eodhdTicker) return null;
  if (!eodhdTicker.includes('.')) return eodhdTicker;
  const [base, suffix] = eodhdTicker.split('.');
  if (UNSUPPORTED_TD_SUFFIXES.has(suffix)) return null;
  if (!(suffix in SUFFIX_MAP)) return null;
  const tdSuffix = SUFFIX_MAP[suffix];
  return tdSuffix ? `${base}${tdSuffix}` : base;
}

/**
 * Mapping suffix EODHD → BCXE suffix character (Cboe Europe Equities).
 *
 * Cboe Europe est un MTF pan-européen qui agrège les cotations de toutes les
 * places EU en true real-time (<1 sec). TwelveData expose ce flux via l'exchange
 * code `BCXE` avec un encoding par suffix indiquant la place de cotation primaire.
 *
 * Mapping découvert empiriquement via `GET /stocks?exchange=BCXE` (3065 stocks,
 * 19 pays). Le ticker est le symbole de base + 1 lettre de suffix :
 *   - VOD.LSE       → VODl (LSE / UK / GBX)
 *   - EZJ.LSE       → EZJl
 *   - AF.PA         → AFp  (Euronext Paris / FR / EUR)
 *   - AMS.SW        → AMSz (SIX Swiss / CH / CHF)
 *   - SAP.XETRA     → SAPd (XETRA / DE / EUR)
 *   - ENI.MI        → ENIm (Borsa Italiana / IT / EUR)
 *
 * Activation : nécessite l'add-on "Cboe Europe Equities" sur le compte TD.
 * Gratuit en self-cert "non-professional" (retail individual investor).
 * Tant que non activé : appel 404 "Not authorized to access BCXE data" → null
 * remonté → caller fallback gracieux sur EODHD real-time (15-20 min delayed).
 */
const BCXE_SUFFIX_MAP: Record<string, string> = {
  // UK
  L: 'l', LSE: 'l',
  // France (Euronext Paris)
  PA: 'p',
  // Netherlands (Euronext Amsterdam)
  AS: 'a', AMS: 'a',
  // Belgium (Euronext Brussels)
  BR: 'b',
  // Ireland (Euronext Dublin)
  IR: 'i',
  // Germany (XETRA / Frankfurt)
  XETRA: 'd', DE: 'd', F: 'd',
  // Italy (Borsa Italiana — MTF Cboe Europe couvre)
  MI: 'm',
  // Spain (BME)
  MC: 'e',
  // Switzerland (SIX)
  SW: 'z',
  // Sweden
  ST: 's',
  // Norway
  OL: 'o',
  // Denmark
  CO: 'c',
  // Finland
  HE: 'h',
  // Austria
  VI: 'v',
  // Portugal
  LS: 'u',
  // Poland
  WA: 'w',
  // Hungary
  BUD: 't',
  // Czech Republic
  PR: 'k',
};

export interface CboeEuropeMapping {
  symbol: string;
  mic_code: 'BCXE';
}

/**
 * Convertit un ticker EODHD vers le format Cboe Europe BCXE.
 * @returns `null` si suffix non couvert par BCXE (ex: .US, .KO, .HK, .T)
 */
export function eodhdToCboeEuropeSymbol(eodhdTicker: string): CboeEuropeMapping | null {
  if (!eodhdTicker || !eodhdTicker.includes('.')) return null;
  const [base, suffix] = eodhdTicker.split('.');
  if (!base || !(suffix in BCXE_SUFFIX_MAP)) return null;
  const suffixChar = BCXE_SUFFIX_MAP[suffix];
  return { symbol: `${base}${suffixChar}`, mic_code: 'BCXE' };
}

