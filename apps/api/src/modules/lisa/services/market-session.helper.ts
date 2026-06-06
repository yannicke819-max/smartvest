/**
 * Helpers de session de marché (horaires UTC US/EU/Asia) — PURS, testables.
 *
 * Extraits pour le live-price / price-warmer : on skip l'appel EODHD real-time
 * quand le marché EQUITY est fermé (la quote serait l'EOD close gelé ; la
 * re-tirer en boucle = gaspillage de quota — constaté weekend 06/06 ~6k calls/h
 * sur 9 positions equity figées). Le scanner gainers garde sa propre copie
 * locale (non touché ici pour limiter le blast radius ; même logique).
 */
export type MarketSessionClass = 'us' | 'eu' | 'asia';

// Fenêtres LARGES (couvrent été ET hiver) pour ne JAMAIS skip un marché ouvert.
export const MARKET_SESSION_HOURS: Record<MarketSessionClass, { openUtcMin: number; closeUtcMin: number }> = {
  us: { openUtcMin: 13 * 60 + 30, closeUtcMin: 21 * 60 }, // 13:30-21:00 UTC (EDT+EST)
  eu: { openUtcMin: 7 * 60, closeUtcMin: 16 * 60 + 30 }, // 07:00-16:30 UTC
  asia: { openUtcMin: 0, closeUtcMin: 8 * 60 }, // 00:00-08:00 UTC
};

/** Marché ouvert maintenant (UTC), Lun-Ven uniquement. Crypto 24/7 → géré ailleurs. */
export function isMarketOpen(cls: MarketSessionClass, now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0=dim, 6=sam
  if (day === 0 || day === 6) return false;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { openUtcMin, closeUtcMin } = MARKET_SESSION_HOURS[cls];
  return min >= openUtcMin && min < closeUtcMin;
}

const US_SUFFIXES = new Set(['US']);
const EU_SUFFIXES = new Set([
  'LSE', 'L', 'PA', 'AS', 'XETRA', 'DE', 'F', 'BR', 'MI', 'MC', 'SW', 'ST',
  'HE', 'OL', 'CO', 'LS', 'VI', 'IR', 'MA', 'AT', 'WA',
]);
const ASIA_SUFFIXES = new Set([
  'T', 'HK', 'KO', 'KQ', 'SHG', 'SHE', 'AU', 'TW', 'SI', 'KS', 'NS', 'BO', 'JK', 'BK',
]);

/**
 * Mappe un SYMBOLE (par son suffixe) vers sa session de marché.
 * null pour : crypto (BTCUSDT sans suffixe, *.CC), forex (*.FOREX), indices
 * (*.INDX), commodities (*.COMM) ET tout suffixe inconnu.
 *
 * FAIL-OPEN volontaire : on ne "ferme" (skip EODHD) que ce qu'on classe avec
 * certitude comme equity US/EU/Asia. Suffixe non listé → null → JAMAIS gaté
 * (on préfère un appel EODHD de trop qu'un prix manquant sur une position).
 */
export function sessionClassForSymbol(symbol: string): MarketSessionClass | null {
  const dot = symbol.lastIndexOf('.');
  if (dot < 0) return null; // ex BTCUSDT (paire Binance) → null
  const suf = symbol.slice(dot + 1).toUpperCase();
  if (US_SUFFIXES.has(suf)) return 'us';
  if (EU_SUFFIXES.has(suf)) return 'eu';
  if (ASIA_SUFFIXES.has(suf)) return 'asia';
  return null;
}
