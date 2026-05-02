/**
 * PR6.4 — Enrichment helper async pour shadow run.
 *
 * Enrichit GainersCandidateRaw avec les champs requis par BLOC 1 prefilter
 * réel (atrDailyRelative, ema50/200Daily, persistenceScore) en lisant :
 *   - `ohlcv_cache_daily` pour ATR + EMA (equity uniquement, mig 0078)
 *   - `MultiTimeframePersistenceService.analyze()` pour persistence multi-TF
 *
 * Crypto : `ohlcv_cache_daily` est equity-only par design → atr/ema restent
 * null + le caller utilise `SHADOW_BLOC1_CONFIG.shadowSkipNullFields=true`
 * pour passer les gates dégradées.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GainersCandidateRaw } from '../../gainers-scanner/domain/gainers-candidate.types';
import type { TopGainerCandidate } from '@smartvest/ai-analyst';
import type { MultiTimeframePersistenceService } from './multi-tf-persistence.service';
import { computeDailyIndicators, type DailyCandle } from './shadow-indicators.helper';
import { mapTopGainerToCandidateRaw } from './shadow-mapping.helper';

interface OhlcvCacheRow {
  bar_date: string;
  high: string | number;
  low: string | number;
  close: string | number;
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
 * Enrichit un TopGainerCandidate (legacy) en GainersCandidateRaw (V1) avec :
 *   - atrDailyRelative : ATR(14)/close depuis cache OHLC (equity uniquement)
 *   - ema50Daily, ema200Daily : EMA50/200 depuis cache (equity uniquement)
 *   - persistenceScore, persistenceCount : depuis mtfPersistence.analyze()
 *
 * Crypto : skip cache reads (equity-only par design). Reste null → caller doit
 * utiliser SHADOW_BLOC1_CONFIG.shadowSkipNullFields=true.
 *
 * Sequential async : 1 read DB + 1 mtfPersistence analyze par candidat.
 * Caller batch (concurrent) recommandé pour 215 symboles.
 */
export async function enrichShadowCandidate(
  candidate: TopGainerCandidate,
  supabase: SupabaseClient,
  mtfPersistence: MultiTimeframePersistenceService,
): Promise<GainersCandidateRaw> {
  const baseRaw = mapTopGainerToCandidateRaw(candidate);

  // ATR + EMA depuis cache (equity uniquement)
  if (baseRaw.market === 'equity') {
    const candles = await readDailyCandles(supabase, candidate.symbol, 200);
    if (candles) {
      const { atr14, ema50, ema200 } = computeDailyIndicators(candles);
      if (atr14 !== null && candidate.close > 0) {
        baseRaw.atrDailyRelative = atr14 / candidate.close;
      }
      baseRaw.ema50Daily = ema50;
      baseRaw.ema200Daily = ema200;
    }
  }

  // Persistence multi-TF (equity + crypto)
  try {
    const persistence = await mtfPersistence.analyze({
      symbol: candidate.symbol,
      exchange: candidate.exchange ?? null,
      currentPrice: candidate.close,
    });
    if (persistence) {
      baseRaw.persistenceScore = persistence.persistenceScore;
      baseRaw.persistenceCount = persistence.persistenceCount;
    }
  } catch {
    // mtfPersistence peut échouer (Yahoo down, EODHD quota). Ne bloque pas.
  }

  return baseRaw;
}
