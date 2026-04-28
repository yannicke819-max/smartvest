/**
 * P4-B — Routing des sources de propositions selon `capital_discipline_mode`.
 *
 * En mode HARVEST (scalping intraday TP 2.5% / SL 1.5%), seuls les signaux
 * compatibles avec un horizon court doivent être consommés :
 *   - rebound_tp_scanner  : RSI oversold + reversal candle + volume confirm
 *   - mechanical_stops    : sortie déterministe TP/SL
 *
 * Les autres sources (narrative_stocktwits, momentum_breakout,
 * sentiment_macro) ont un horizon 1-4 semaines et génèrent des
 * proposal_failed quand stops -1.5% les ferme avant catalyseur.
 *
 * En mode INVESTMENT (buy-and-hold, stops -4%), toutes les sources sont
 * actives.
 *
 * Pure function — testable en isolation.
 */

export type DisciplineModeLike = 'DAILY_HARVEST' | 'NONE' | string | null | undefined;

export const HARVEST_PROPOSAL_SOURCES = [
  'rebound_tp_scanner',
  'mechanical_stops',
] as const;

export const INVESTMENT_PROPOSAL_SOURCES = [
  'rebound_tp_scanner',
  'momentum_breakout',
  'narrative_stocktwits',
  'sentiment_macro',
  'mechanical_stops',
] as const;

export type ProposalSource =
  | (typeof HARVEST_PROPOSAL_SOURCES)[number]
  | (typeof INVESTMENT_PROPOSAL_SOURCES)[number];

/**
 * Renvoie la liste des sources de propositions pour un mode donné.
 *
 *   'harvest' / 'DAILY_HARVEST'   → ['rebound_tp_scanner', 'mechanical_stops']
 *   'investment' / null / autres  → liste complète (5 sources)
 */
export function getProposalSources(mode: DisciplineModeLike): ProposalSource[] {
  if (isHarvestMode(mode)) {
    return [...HARVEST_PROPOSAL_SOURCES];
  }
  return [...INVESTMENT_PROPOSAL_SOURCES];
}

/**
 * Détecte si on est en mode harvest (court terme, narrative-free).
 * Accepte les deux conventions de nommage : DB stocke 'DAILY_HARVEST',
 * la spec ticket P4-B utilise 'harvest' lowercase. On supporte les deux.
 */
export function isHarvestMode(mode: DisciplineModeLike): boolean {
  if (typeof mode !== 'string') return false;
  const normalized = mode.toLowerCase();
  return normalized === 'harvest' || normalized === 'daily_harvest';
}

/**
 * Indique si la source `news_aggregator` (StockTwits + Reddit + Twitter +
 * EODHD news) doit être appelée pour ce mode. False en harvest pour
 * économiser les coûts API et éviter les biais narratifs.
 */
export function shouldRunNewsAggregator(mode: DisciplineModeLike): boolean {
  return !isHarvestMode(mode);
}
