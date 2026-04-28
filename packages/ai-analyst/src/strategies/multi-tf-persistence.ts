/**
 * P8-MULTI-TIMEFRAME-PERSISTENCE — Pure logic helper.
 *
 * Calcule la persistance multi-TF d'un candidat top gainer :
 *   - 6 timeframes : 1m, 5m, 10m, 15m, 30m, 1h
 *   - Pour chaque TF : changePctTF = (current - openAtTFAgo) / openAtTFAgo
 *   - persistenceScore = #TF positifs / #TF disponibles ∈ [0, 1]
 *
 * Pas d'I/O — la logique de fetch (Binance klines / EODHD intraday) est dans
 * le service backend. Ici on prend en entrée un mapping `pricesByTF` (prix
 * d'ouverture il y a N minutes) + le prix courant, et on retourne le vecteur
 * de persistance + le score.
 *
 * TF non disponible (ex : 1m sur EODHD plan equities sans intraday tier-1)
 * → null. Le score est normalisé sur les TFs disponibles uniquement.
 *
 * Sanity guards : prix invalides (NaN, ≤0) → null pour le TF concerné.
 */

export type Timeframe = '1m' | '5m' | '10m' | '15m' | '30m' | '1h';

export const ALL_TIMEFRAMES: readonly Timeframe[] = [
  '1m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
] as const;

/** Minutes correspondant à chaque TF (utilisé pour fetch les prix passés). */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '10m': 10,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

export interface PersistenceVector {
  /** Variation en % sur chaque TF. null si donnée non dispo. */
  tf1m: number | null;
  tf5m: number | null;
  tf10m: number | null;
  tf15m: number | null;
  tf30m: number | null;
  tf1h: number | null;
}

export interface PersistenceResult extends PersistenceVector {
  /** Compte de TFs positifs / TFs disponibles, ex "4/6". */
  persistenceCount: string;
  /** Ratio normalisé ∈ [0,1] basé sur TFs dispos. NaN si aucun TF dispo. */
  persistenceScore: number;
  /** Nombre de TFs strictement positifs (current > openAtTFAgo). */
  positiveCount: number;
  /** Nombre de TFs avec donnée non-null. */
  availableCount: number;
}

/**
 * Calcule changePctTF pour un timeframe à partir du prix actuel et du prix
 * d'ouverture il y a TIMEFRAME_MINUTES[tf] minutes. Retourne null si l'une
 * des valeurs est invalide.
 */
export function computeTfChangePct(
  currentPrice: number,
  priceAtTfAgo: number | null | undefined,
): number | null {
  if (priceAtTfAgo == null) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  if (!Number.isFinite(priceAtTfAgo) || priceAtTfAgo <= 0) return null;
  return ((currentPrice - priceAtTfAgo) / priceAtTfAgo) * 100;
}

/**
 * Construit le vecteur de persistance à partir du prix actuel + prix passés.
 * Les TFs absents du map (ou avec valeur null) sont reportés comme null.
 */
export function buildPersistenceVector(
  currentPrice: number,
  pricesByTfAgo: Partial<Record<Timeframe, number | null>>,
): PersistenceVector {
  return {
    tf1m: computeTfChangePct(currentPrice, pricesByTfAgo['1m']),
    tf5m: computeTfChangePct(currentPrice, pricesByTfAgo['5m']),
    tf10m: computeTfChangePct(currentPrice, pricesByTfAgo['10m']),
    tf15m: computeTfChangePct(currentPrice, pricesByTfAgo['15m']),
    tf30m: computeTfChangePct(currentPrice, pricesByTfAgo['30m']),
    tf1h: computeTfChangePct(currentPrice, pricesByTfAgo['1h']),
  };
}

/**
 * Applique la règle métier : `persistenceScore = positiveCount / availableCount`.
 * `availableCount = 0` → score=NaN (ne doit pas passer le gate).
 *
 * Un TF est considéré "positif" si changePctTF > 0 (strictement). Égalité à
 * 0 = neutre, compté en disponible mais pas en positif.
 */
export function computePersistenceScore(vec: PersistenceVector): PersistenceResult {
  let positive = 0;
  let available = 0;
  for (const tf of ALL_TIMEFRAMES) {
    const key = tfKey(tf);
    const v = vec[key];
    if (v == null) continue;
    available++;
    if (v > 0) positive++;
  }
  return {
    ...vec,
    positiveCount: positive,
    availableCount: available,
    persistenceCount: `${positive}/${available || 6}`,
    persistenceScore: available === 0 ? Number.NaN : positive / available,
  };
}

/**
 * Helper de bout-en-bout : prix courant + prices map → résultat complet.
 */
export function evaluatePersistence(
  currentPrice: number,
  pricesByTfAgo: Partial<Record<Timeframe, number | null>>,
): PersistenceResult {
  return computePersistenceScore(buildPersistenceVector(currentPrice, pricesByTfAgo));
}

/**
 * Pour un série de candles 1-min (ordre chronologique croissant), extrait
 * le prix d'ouverture (open) il y a N minutes en regardant la candle à
 * l'index `length - 1 - N` (inclusive de la candle courante).
 *
 * Si la série est trop courte → null pour ce TF. Pratique côté Binance où
 * `getKlines(BTCUSDT, '1m', 60)` donne directement 60 candles 1-min.
 */
export function extractPricesFromOneMinSeries(
  candles: Array<{ open: number; close?: number }>,
): Partial<Record<Timeframe, number | null>> {
  const len = candles.length;
  const pickOpen = (minutesAgo: number): number | null => {
    const idx = len - 1 - minutesAgo;
    if (idx < 0 || idx >= len) return null;
    const c = candles[idx];
    if (!c || !Number.isFinite(c.open) || c.open <= 0) return null;
    return c.open;
  };
  return {
    '1m': pickOpen(TIMEFRAME_MINUTES['1m']),
    '5m': pickOpen(TIMEFRAME_MINUTES['5m']),
    '10m': pickOpen(TIMEFRAME_MINUTES['10m']),
    '15m': pickOpen(TIMEFRAME_MINUTES['15m']),
    '30m': pickOpen(TIMEFRAME_MINUTES['30m']),
    '1h': pickOpen(TIMEFRAME_MINUTES['1h']),
  };
}

/**
 * Pour une série de candles 5-min (ordre chronologique croissant), extrait
 * le prix d'ouverture en aggrégeant le bon nombre de candles. 1m
 * non-disponible (résolution insuffisante) → null.
 */
export function extractPricesFromFiveMinSeries(
  candles: Array<{ open: number; close?: number }>,
): Partial<Record<Timeframe, number | null>> {
  const len = candles.length;
  const pickOpenAtCandlesAgo = (candlesAgo: number): number | null => {
    const idx = len - 1 - candlesAgo;
    if (idx < 0 || idx >= len) return null;
    const c = candles[idx];
    if (!c || !Number.isFinite(c.open) || c.open <= 0) return null;
    return c.open;
  };
  return {
    '1m': null, // 5-min granularité ne permet pas 1m
    '5m': pickOpenAtCandlesAgo(1),
    '10m': pickOpenAtCandlesAgo(2),
    '15m': pickOpenAtCandlesAgo(3),
    '30m': pickOpenAtCandlesAgo(6),
    '1h': pickOpenAtCandlesAgo(12),
  };
}

function tfKey(tf: Timeframe): keyof PersistenceVector {
  return (`tf${tf}` as keyof PersistenceVector);
}

/**
 * Résume un set de résultats par TF : combien de symboles sont positifs sur
 * chaque TF. Utile pour la réponse de l'endpoint persistance-snapshot
 * ("20 / 17 / 14 / 12 / 9 / 7" — réponse directe à la question user).
 */
export function summarizeByTf(
  results: Array<PersistenceResult>,
): Record<'oneMinute' | 'fiveMinutes' | 'tenMinutes' | 'fifteenMinutes' | 'thirtyMinutes' | 'oneHour', number> {
  const counts = {
    oneMinute: 0,
    fiveMinutes: 0,
    tenMinutes: 0,
    fifteenMinutes: 0,
    thirtyMinutes: 0,
    oneHour: 0,
  };
  for (const r of results) {
    if ((r.tf1m ?? 0) > 0) counts.oneMinute++;
    if ((r.tf5m ?? 0) > 0) counts.fiveMinutes++;
    if ((r.tf10m ?? 0) > 0) counts.tenMinutes++;
    if ((r.tf15m ?? 0) > 0) counts.fifteenMinutes++;
    if ((r.tf30m ?? 0) > 0) counts.thirtyMinutes++;
    if ((r.tf1h ?? 0) > 0) counts.oneHour++;
  }
  return counts;
}
