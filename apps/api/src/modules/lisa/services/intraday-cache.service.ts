/**
 * P19i — Intraday OHLCV cache (Supabase persistence).
 *
 * Used by `MultiTimeframePersistenceService` as **last-resort fallback** :
 *
 *   Yahoo (P19g) → EODHD intraday → IntradayCache (15 min stale) → null
 *
 * Quand Yahoo ET EODHD sont KO sur un ticker (rate-limit IP Fly, quota EODHD,
 * provider down, etc.), on lit la dernière série OHLCV connue dans
 * `lisa_intraday_cache` (write-on-success par les providers primaires).
 *
 * Si la série est < 15 min (TTL configurable) → return avec flag
 * `coverage='cache_stale'` côté UI badge dégradé orange. Sinon → null,
 * `coverage='none'`, badge rouge.
 *
 * Write-on-success : à chaque fetch réussi côté provider primaire (yahoo /
 * eodhd / binance), on upsert la série pour le prochain fallback éventuel.
 * Failure-tolerant : si l'INSERT/UPSERT échoue (Supabase down, FK, etc.),
 * on log debug et on continue — pas de rejet du happy path.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export interface CachedCandle {
  timestamp: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type CacheSource = 'yahoo' | 'eodhd' | 'eodhd_ticks' | 'binance';

export interface CachedSeries {
  symbol: string;
  source: CacheSource;
  candles: CachedCandle[];
  fetchedAt: number; // ms epoch
  /** Computed at read : âge en ms depuis fetched_at. */
  ageMs: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 min

@Injectable()
export class IntradayCacheService {
  private readonly logger = new Logger(IntradayCacheService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Stocke une série de candles pour un symbole donné.
   * Failure-tolerant : log debug et return false si Supabase échoue.
   */
  async write(symbol: string, source: CacheSource, candles: CachedCandle[]): Promise<boolean> {
    if (!this.supabase.isReady() || !candles || candles.length === 0) return false;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('lisa_intraday_cache')
        .upsert({
          symbol: symbol.toUpperCase(),
          source,
          candles,
          fetched_at: new Date().toISOString(),
        }, { onConflict: 'symbol' });
      if (error) {
        this.logger.debug(`[intraday-cache] write ${symbol} failed: ${error.message.slice(0, 100)}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.debug(`[intraday-cache] write ${symbol} threw: ${String(e).slice(0, 100)}`);
      return false;
    }
  }

  /**
   * Lit la série la plus récente pour un symbole, retourne null si absente
   * ou si plus vieille que TTL_MS (15 min). `ageMs` est calculé à la lecture.
   */
  async read(symbol: string): Promise<CachedSeries | null> {
    if (!this.supabase.isReady()) return null;
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_intraday_cache')
        .select('symbol, source, candles, fetched_at')
        .eq('symbol', symbol.toUpperCase())
        .maybeSingle();
      if (error) {
        this.logger.debug(`[intraday-cache] read ${symbol} error: ${error.message.slice(0, 100)}`);
        return null;
      }
      if (!data) return null;

      const fetchedAtMs = new Date(String(data.fetched_at)).getTime();
      const ageMs = Date.now() - fetchedAtMs;
      if (ageMs > TTL_MS) return null; // expired

      const candles = (data.candles as CachedCandle[]) ?? [];
      if (candles.length === 0) return null;

      return {
        symbol: String(data.symbol),
        source: data.source as CacheSource,
        candles,
        fetchedAt: fetchedAtMs,
        ageMs,
      };
    } catch (e) {
      this.logger.debug(`[intraday-cache] read ${symbol} threw: ${String(e).slice(0, 100)}`);
      return null;
    }
  }
}
