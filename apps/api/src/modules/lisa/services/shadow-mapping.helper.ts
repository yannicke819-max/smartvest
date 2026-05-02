/**
 * Helper PR6.3 — mapping TopGainerCandidate (legacy scanner) → GainersCandidateRaw (V1).
 *
 * Champs manquants dans TopGainerCandidate (donc défaultés/nullés en V1) :
 *   - open, low : défaultés à close (single-tick, pas d'OHLC)
 *   - atrDailyRelative : null → BLOC 1 volatility_clamp gate skip si null
 *   - persistenceScore : null → BLOC 1 persistence gate skip si null
 *   - ema50Daily, ema200Daily : null → BLOC 1 trend filter set à TrendFilterKind.NONE
 *
 * Conséquence : shadow signals produits ne sont pas équivalents à un pipeline
 * V1 complet (BLOC 1 partiel + pas de BLOC 2 spread proxy ni BLOC 3 trigger).
 * C'est une PREMIÈRE PASSE pour démarrer le shadow run avec des données réelles.
 *
 * Plan prochaine évolution PR6.4 : enrichir le mapping avec :
 *   - Fetch candles daily (cache ohlcv_cache_daily) → ATR + EMA50/200
 *   - Persistence multi-TF via MultiTimeframePersistenceService (déjà inject)
 *   - BLOC 2 candles 1h pour spread proxy
 *   - BLOC 3 trigger detection sur candles 1m intraday
 */

import type { TopGainerCandidate, TopGainerAssetClass } from '@smartvest/ai-analyst';
import type { GainersCandidateRaw } from '../../gainers-scanner/domain/gainers-candidate.types';

/** Mappe TopGainerAssetClass → 'equity' | 'crypto' attendu par V1. */
function mapAssetClass(legacyAssetClass: TopGainerAssetClass | undefined): 'equity' | 'crypto' {
  if (!legacyAssetClass) return 'equity';
  if (legacyAssetClass === 'crypto_major' || legacyAssetClass === 'crypto_alt') return 'crypto';
  return 'equity';
}

/**
 * Convertit un TopGainerCandidate (legacy scanner) en GainersCandidateRaw (V1).
 * Champs manquants → null/défauts pour permettre BLOC 1 prefilter d'évaluer
 * en mode dégradé (skip gates basés sur null).
 */
export function mapTopGainerToCandidateRaw(
  candidate: TopGainerCandidate & { score?: number; assetClass?: TopGainerAssetClass },
): GainersCandidateRaw {
  return {
    symbol: candidate.symbol,
    market: mapAssetClass(candidate.assetClass),
    exchange: candidate.exchange ?? 'UNKNOWN',
    close: candidate.close,
    open: candidate.close, // single-tick fallback
    high: candidate.high,
    low: candidate.close, // fallback
    vol24hUsd: candidate.volume * candidate.close,
    medianDailyVolUsd20d: candidate.avgVol50d * candidate.close,
    marketCapUsd: candidate.marketCap,
    atrDailyRelative: null,
    changePct1m: candidate.changePct,
    persistenceScore: null,
    persistenceCount: null,
    ema50Daily: null,
    ema200Daily: null,
  };
}
