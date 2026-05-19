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

import { detectAssetClass, type TopGainerCandidate, type TopGainerAssetClass } from '@smartvest/ai-analyst';
import type { GainersCandidateRaw } from '../../gainers-scanner/domain/gainers-candidate.types';

/**
 * Mappe TopGainerAssetClass → 'equity' | 'crypto' attendu par V1.
 *
 * PR6.6.2 — Fallback sur detectAssetClass(symbol, exchange, marketCap) quand
 * `legacyAssetClass` est undefined. Cas critique : les raw candidates produits
 * par fetchBinanceGainers/mapEodhdRow ne set jamais `assetClass` (seul
 * selectTopGainers le fait downstream pour les top-N qui passent le filtre).
 * Sans ce fallback, BTCUSDT/ETHUSDT/etc. tombaient en `equity` → fail
 * LIQUIDITY_FLOOR alors que crypto majors devraient passer.
 */
function mapAssetClass(
  legacyAssetClass: TopGainerAssetClass | undefined,
  symbol: string,
  exchange: string | null | undefined,
  marketCap: number | null,
): 'equity' | 'crypto' {
  const cls = legacyAssetClass ?? detectAssetClass(symbol, exchange, marketCap);
  if (cls === 'crypto_major' || cls === 'crypto_alt') return 'crypto';
  return 'equity';
}

/**
 * PR #362 — Résout la classe d'actif détaillée (9 classes) requise par le
 * composite scorer per-class data-driven. Garantit qu'`assetClass` n'est
 * jamais undefined dans le `GainersCandidateRaw` produit.
 */
function resolveDetailedAssetClass(
  legacyAssetClass: TopGainerAssetClass | undefined,
  symbol: string,
  exchange: string | null | undefined,
  marketCap: number | null,
): TopGainerAssetClass {
  return legacyAssetClass ?? detectAssetClass(symbol, exchange, marketCap);
}

/**
 * Convertit un TopGainerCandidate (legacy scanner) en GainersCandidateRaw (V1).
 * Champs manquants → null/défauts pour permettre BLOC 1 prefilter d'évaluer
 * en mode dégradé (skip gates basés sur null).
 *
 * PR6.6.3 — Volume USD :
 *   - Equity (EODHD) : `volume` = nombre de shares → × close → USD ✅
 *   - Crypto (Binance) : `volume` = `t.quoteVolume` qui est DÉJÀ en USDT (≈USD).
 *     Multiplier par close donne un nombre absurde (USD²). Fix : skip × close
 *     pour crypto.
 */
export function mapTopGainerToCandidateRaw(
  candidate: TopGainerCandidate & { score?: number; assetClass?: TopGainerAssetClass },
): GainersCandidateRaw {
  const market = mapAssetClass(
    candidate.assetClass,
    candidate.symbol,
    candidate.exchange,
    candidate.marketCap ?? null,
  );
  const detailedAssetClass = resolveDetailedAssetClass(
    candidate.assetClass,
    candidate.symbol,
    candidate.exchange,
    candidate.marketCap ?? null,
  );
  const isCrypto = market === 'crypto';
  return {
    symbol: candidate.symbol,
    market,
    assetClass: detailedAssetClass,
    exchange: candidate.exchange ?? 'UNKNOWN',
    close: candidate.close,
    open: candidate.close, // single-tick fallback
    high: candidate.high,
    low: candidate.close, // fallback
    vol24hUsd: isCrypto ? candidate.volume : candidate.volume * candidate.close,
    medianDailyVolUsd20d: isCrypto ? candidate.avgVol50d : candidate.avgVol50d * candidate.close,
    marketCapUsd: candidate.marketCap,
    atrDailyRelative: null,
    changePct1m: candidate.changePct,
    persistenceScore: null,
    persistenceCount: null,
    ema50Daily: null,
    ema200Daily: null,
  };
}
