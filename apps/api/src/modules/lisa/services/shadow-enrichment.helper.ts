/**
 * PR6.4 + PR6.6 — Enrichment helper async pour shadow run.
 *
 * Enrichit GainersCandidateRaw avec les champs requis par BLOC 1 prefilter
 * réel (atrDailyRelative, ema50/200Daily, persistenceScore) en lisant :
 *   - `ohlcv_cache_daily` pour ATR + EMA (equity, mig 0078)
 *   - `BinanceMarketService.getKlines(symbol, '1d', 200)` pour ATR + EMA (crypto, PR6.6)
 *   - `MultiTimeframePersistenceService.analyze()` pour persistence multi-TF
 *     + pathQuality.overallEfficiency utilisé comme path_eff réel (PR6.6)
 *
 * Retourne `{ raw, pathEff }` où pathEff vient de mtfPersistence (P9-UX) ou
 * null si pas dispo (caller utilise default 0.5%).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GainersCandidateRaw } from '../../gainers-scanner/domain/gainers-candidate.types';
import type { TopGainerCandidate } from '@smartvest/ai-analyst';
import type { MultiTimeframePersistenceService } from './multi-tf-persistence.service';
import type { BinanceMarketService } from './binance-market.service';
import { computeDailyIndicators, type DailyCandle } from './shadow-indicators.helper';
import { mapTopGainerToCandidateRaw } from './shadow-mapping.helper';

interface OhlcvCacheRow {
  bar_date: string;
  high: string | number;
  low: string | number;
  close: string | number;
}

export interface EnrichResult {
  raw: GainersCandidateRaw;
  /** Path efficiency P9-UX overall ∈ [0, 1] ; null si pas dispo. */
  pathEff: number | null;
}

/**
 * Lit les N dernières bougies daily depuis ohlcv_cache_daily pour un ticker.
 * Retourne null si moins de `minBars` bougies disponibles (signal de cache stale ou
 * symbole non couvert).
 */
export async function readDailyCandles(
  supabase: SupabaseClient,
  ticker: string,
  minBars = 200,
): Promise<DailyCandle[] | null> {
  const { data, error } = await supabase
    .from('ohlcv_cache_daily')
    .select('bar_date, high, low, close')
    .eq('ticker', ticker)
    .order('bar_date', { ascending: false })
    .limit(minBars);

  if (error || !data || data.length < minBars) return null;

  // Inverse pour ordre chronologique ascending (la plus récente en dernier)
  return data
    .map((r): DailyCandle => {
      const row = r as unknown as OhlcvCacheRow;
      return {
        high: typeof row.high === 'string' ? parseFloat(row.high) : row.high,
        low: typeof row.low === 'string' ? parseFloat(row.low) : row.low,
        close: typeof row.close === 'string' ? parseFloat(row.close) : row.close,
      };
    })
    .reverse();
}

/**
 * PR6.6 — Lit 200 bougies daily Binance pour un symbole crypto.
 * Format eodhd → binance : BTC-USD.CC → BTCUSDT.
 */
export async function readBinanceDailyCandles(
  binance: BinanceMarketService,
  cryptoSymbol: string,
  minBars = 200,
): Promise<DailyCandle[] | null> {
  const m = cryptoSymbol.match(/^([A-Z0-9]+)-USD\.CC$/);
  if (!m) return null;
  const binanceSymbol = `${m[1]}USDT`;
  const candles = await binance.getKlines(binanceSymbol, '1d', minBars);
  if (!candles || candles.length < minBars) return null;
  return candles.map((c): DailyCandle => ({ high: c.high, low: c.low, close: c.close }));
}

/**
 * Enrichit un TopGainerCandidate (legacy) en GainersCandidateRaw (V1) avec :
 *   - atrDailyRelative : ATR(14)/close depuis cache OHLC equity OU Binance klines crypto
 *   - ema50Daily, ema200Daily : EMA50/200 idem
 *   - persistenceScore, persistenceCount : depuis mtfPersistence.analyze()
 *
 * PR6.6 : crypto enrichi via BinanceMarketService.getKlines (1d × 200).
 * PR6.6 : path_eff réel = mtfPersistence.pathQuality.overallEfficiency.
 *
 * Sequential async : 1 read DB/Binance + 1 mtfPersistence analyze par candidat.
 * Caller batch (concurrent) recommandé pour 215 symboles.
 */
export async function enrichShadowCandidate(
  candidate: TopGainerCandidate,
  supabase: SupabaseClient,
  mtfPersistence: MultiTimeframePersistenceService,
  binance?: BinanceMarketService,
): Promise<EnrichResult> {
  const baseRaw = mapTopGainerToCandidateRaw(candidate);

  // ATR + EMA depuis cache (equity) ou Binance klines (crypto, PR6.6)
  let dailyCandles: DailyCandle[] | null = null;
  if (baseRaw.market === 'equity') {
    dailyCandles = await readDailyCandles(supabase, candidate.symbol, 200);
  } else if (baseRaw.market === 'crypto' && binance) {
    dailyCandles = await readBinanceDailyCandles(binance, candidate.symbol, 200);
  }

  if (dailyCandles) {
    const { atr14, ema50, ema200 } = computeDailyIndicators(dailyCandles);
    if (atr14 !== null && candidate.close > 0) {
      baseRaw.atrDailyRelative = atr14 / candidate.close;
    }
    baseRaw.ema50Daily = ema50;
    baseRaw.ema200Daily = ema200;
  }

  // Persistence multi-TF (equity + crypto) + path_eff réel
  let pathEff: number | null = null;
  try {
    const persistence = await mtfPersistence.analyze({
      symbol: candidate.symbol,
      exchange: candidate.exchange ?? null,
      currentPrice: candidate.close,
    });
    if (persistence) {
      baseRaw.persistenceScore = persistence.persistenceScore;
      baseRaw.persistenceCount = persistence.persistenceCount;
      // PR6.6 : extract overall path efficiency for shadow path_eff réel
      pathEff = persistence.pathQuality?.overallEfficiency ?? null;
    }
  } catch {
    // mtfPersistence peut échouer (Yahoo down, EODHD quota). Ne bloque pas.
  }

  return { raw: baseRaw, pathEff };
}

