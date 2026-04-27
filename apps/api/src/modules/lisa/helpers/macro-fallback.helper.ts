/**
 * Parsers pour les sources fallback macro (Yahoo Finance + Stooq).
 *
 * Pour les indicateurs VIX/DXY où EODHD `*.INDX` retourne fréquemment
 * `empty_price_field` en prod (cf. CLAUDE.md mécanique fetchCascade), on
 * étend la cascade avec deux providers gratuits sans clé API :
 *
 *   - **Yahoo Finance** chart endpoint (no-auth, JSON)
 *   - **Stooq** quote endpoint (no-auth, CSV)
 *
 * Les fonctions ci-dessous SONT PURES (no I/O) pour être testables sans
 * mock HTTP. Le caller (LisaService.fetchYahooQuote / fetchStooqQuote)
 * encapsule l'appel `fetch()` et délègue le parsing ici.
 *
 * Cf. PR fix/macro-vix-cascade-multi-provider (incident 27/04 — VIX
 * en fallback hardcoded car cascade EODHD-only insuffisante).
 */

/**
 * Parse la réponse JSON Yahoo Finance `/v8/finance/chart/{symbol}`.
 *
 * Shape attendu (extrait) :
 * ```
 * { chart: { result: [ { meta: { regularMarketPrice: 22.5 } } ] } }
 * ```
 *
 * Plusieurs paths sont essayés (compat versions API anciennes/nouvelles) :
 *   1. `chart.result[0].meta.regularMarketPrice` (préféré, frais)
 *   2. dernière valeur non-null de `chart.result[0].indicators.quote[0].close`
 *   3. dernière valeur non-null de `chart.result[0].indicators.adjclose[0].adjclose`
 *
 * Retourne null si :
 *   - structure invalide
 *   - aucun prix > 0 trouvé
 *   - réponse `chart.error != null`
 */
export function parseYahooChartResponse(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const chart = (json as Record<string, unknown>).chart as Record<string, unknown> | undefined;
  if (!chart || chart.error) return null;
  const result = chart.result as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(result) || result.length === 0) return null;

  const r0 = result[0];
  const meta = r0.meta as Record<string, unknown> | undefined;

  // Path 1 : meta.regularMarketPrice (le plus frais)
  const regular = meta ? Number(meta.regularMarketPrice) : NaN;
  if (Number.isFinite(regular) && regular > 0) return regular;

  // Path 2 : dernier close non-null dans indicators.quote[0].close[]
  const indicators = r0.indicators as Record<string, unknown> | undefined;
  const quoteArr = indicators?.quote as Array<Record<string, unknown>> | undefined;
  const closeArr = quoteArr?.[0]?.close as Array<number | null> | undefined;
  if (Array.isArray(closeArr)) {
    for (let i = closeArr.length - 1; i >= 0; i--) {
      const v = Number(closeArr[i]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }

  // Path 3 : adjclose dernière valeur (rare en intraday mais possible)
  const adjArr = indicators?.adjclose as Array<Record<string, unknown>> | undefined;
  const adjCloseArr = adjArr?.[0]?.adjclose as Array<number | null> | undefined;
  if (Array.isArray(adjCloseArr)) {
    for (let i = adjCloseArr.length - 1; i >= 0; i--) {
      const v = Number(adjCloseArr[i]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }

  return null;
}

/**
 * Parse la réponse CSV Stooq `/q/?s={symbol}&f=sd2t2ohlcv&h&e=csv`.
 *
 * Shape attendu (header + 1 ou plusieurs lignes data) :
 * ```
 * Symbol,Date,Time,Open,High,Low,Close,Volume
 * ^VIX,2026-04-27,15:30:00,22.10,22.85,21.90,22.65,N/D
 * ```
 *
 * Stratégie :
 *   1. Split par lignes
 *   2. Première ligne = header → identifier l'index de la colonne `Close`
 *   3. Lignes suivantes : on prend la DERNIÈRE ligne avec un Close numérique > 0
 *
 * Tolère :
 *   - retour windows-style (\r\n)
 *   - colonnes "N/D" / "-" (Stooq retourne ça quand pas de cotation)
 *   - lignes vides en fin
 *
 * Retourne null si la structure ne match pas ou aucun close valide.
 */
export function parseStooqCsvResponse(csv: string): number | null {
  if (!csv || typeof csv !== 'string') return null;
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const closeIdx = header.indexOf('close');
  if (closeIdx < 0) return null;

  // Prend la dernière ligne avec un close valide (la plus récente).
  for (let i = lines.length - 1; i >= 1; i--) {
    const cells = lines[i].split(',');
    const cell = (cells[closeIdx] ?? '').trim();
    if (!cell || cell === 'N/D' || cell === '-') continue;
    const v = Number(cell);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * Construit l'URL Yahoo Finance chart API pour un symbol.
 * Pas de clé requise. L'API accepte les User-Agent vides mais préfère un
 * navigateur — on utilise un UA générique pour éviter les 429.
 */
export function buildYahooChartUrl(symbol: string): string {
  const s = encodeURIComponent(symbol);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1d`;
}

/**
 * Construit l'URL Stooq quote CSV pour un symbol.
 * Symboles Stooq pour les cas critiques : `^vix`, `^dxy`, `^spx`, ...
 */
export function buildStooqCsvUrl(symbol: string): string {
  const s = encodeURIComponent(symbol.toLowerCase());
  return `https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcv&h&e=csv`;
}
