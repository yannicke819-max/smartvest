/**
 * PR #295 — Pré-filtre amont pour les tickers US OTC "Foreign Ordinary".
 *
 * Symptôme observé prod 08/05/2026 20:28 UTC : 4 tickers (BRDCF.US, MGDDF.US,
 * SEMUF.US, MAKSF.US) ont déclenché la chaîne fallback complète
 * (yahoo → eodhd 1m → eodhd 5m → eodhd ticks → cache) pour terminer en
 * `coverage=none`. Aucun provider intraday gratuit ou payant ne couvre les
 * pink-sheet OTC US — la chaîne est gaspillée à chaque cycle.
 *
 * Heuristique :
 *   - Suffix `.US` (ou pas de suffix → traité comme US par défaut)
 *   - Root (avant le suffix) = exactement 5 lettres ET finit par 'F'
 *   - 5-letter ticker ending in F = convention Foreign Ordinary OTC
 *
 * Whitelist d'exceptions : si une mid-cap legit listée NYSE/NASDAQ matche le
 * pattern (cas rare mais possible), l'ajouter à `OTC_FOREIGN_ORDINARY_EXCEPTIONS`.
 *
 * Ce filtre est BORNÉ : il ne touche pas les tickers `.PA`, `.T`, `.HK`, etc.
 * (les marchés majeurs APAC/EU sont couverts par EODHD ALL-IN-ONE).
 *
 * Économie : ~6 API calls par ticker filtré par cycle. À 4 tickers OTC
 * détectés par cycle scanner, ~24 calls/cycle économisés. Plus important :
 * élimine la pollution shadow logger (`coverage=none` rows = bruit pour A/B
 * stats, comptabilisés à tort comme "fail" dans l'analyse Kelly).
 */

/**
 * Whitelist explicite des tickers 5-letter ending in F qui sont en réalité
 * listés sur NYSE/NASDAQ (donc couverts par EODHD intraday). Vide à
 * l'initialisation — à étendre si un cas legit est observé en prod.
 */
const OTC_FOREIGN_ORDINARY_EXCEPTIONS = new Set<string>([
  // Aucun cas connu à ce jour. Format attendu : 'XXXXX' (root sans .US).
]);

/**
 * Détecte si un ticker est probablement une OTC Foreign Ordinary US.
 *
 * @param symbol — ticker brut, ex: 'BRDCF.US' ou 'BRDCF' ou 'AAPL.US'
 * @returns true si le ticker matche le pattern OTC pink + n'est pas whitelisté
 */
export function isLikelyOtcForeignOrdinaryUS(symbol: string): boolean {
  if (!symbol) return false;
  const upper = symbol.toUpperCase().trim();

  // Ne filtre QUE les tickers US (suffix .US ou aucun suffix = US default).
  // Tout suffix non-.US (.T, .HK, .PA, .L, .AX, .DE, .KO, .KQ, ...) est
  // explicitement préservé : ces marchés sont des exchanges majeurs avec
  // intraday EODHD officiellement supporté.
  let root: string;
  if (upper.includes('.')) {
    const [rootPart, suffix] = upper.split('.', 2);
    if (suffix !== 'US') return false;
    root = rootPart;
  } else {
    root = upper;
  }

  // Pattern OTC Foreign Ordinary : exactement 5 lettres A-Z, dernière = F.
  if (root.length !== 5) return false;
  if (!/^[A-Z]{5}$/.test(root)) return false;
  if (!root.endsWith('F')) return false;

  // Whitelist override pour mid-caps legit qui matchent le pattern.
  if (OTC_FOREIGN_ORDINARY_EXCEPTIONS.has(root)) return false;

  return true;
}

/**
 * Filtre une liste de symboles, retire ceux probablement OTC Foreign Ordinary.
 * Retourne `{ kept, dropped }` pour permettre au caller de logger les drops.
 */
export function filterOutOtcForeignOrdinary<T extends { symbol: string }>(
  candidates: readonly T[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const c of candidates) {
    if (isLikelyOtcForeignOrdinaryUS(c.symbol)) {
      dropped.push(c);
    } else {
      kept.push(c);
    }
  }
  return { kept, dropped };
}
