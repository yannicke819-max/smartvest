/**
 * Cross-position correlation guard — service avec fetch + cache.
 *
 * Récupère 30 daily closes par symbole (cache 10 min mémoire) :
 *   - Crypto : BinanceMarketService.getKlines(sym, '1d', 30)
 *   - Equities : ohlcv_cache_daily (cron OhlcvCacheService 21:30 UTC)
 *
 * Délègue ensuite au pure helper assessCorrelationRisk pour le verdict.
 *
 * Default OFF (env-gated). Best-effort : tout échec fetch → skip pas reject
 * (on n'introduit pas un nouveau motif de blocage d'open par bug fetch).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { BinanceMarketService } from './binance-market.service';
import {
  assessCorrelationRisk,
  parseCorrelationGuardConfig,
  type CorrelationGuardConfig,
  type CorrelationAssessment,
  type OpenPositionPrices,
} from './correlation-guard.helper';

interface CachedSeries {
  prices: number[];
  asOf: number;
}

@Injectable()
export class CorrelationGuardService {
  private readonly logger = new Logger(CorrelationGuardService.name);
  private enabled = false;
  private cfg: CorrelationGuardConfig = { threshold: 0.70, minObservations: 10 };
  private cache = new Map<string, CachedSeries>();
  private readonly CACHE_TTL_MS = 10 * 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly binanceMarket: BinanceMarketService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('CORRELATION_GUARD_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.cfg = parseCorrelationGuardConfig({
      CORRELATION_GUARD_THRESHOLD: this.config.get<string>('CORRELATION_GUARD_THRESHOLD'),
      CORRELATION_GUARD_MIN_OBS: this.config.get<string>('CORRELATION_GUARD_MIN_OBS'),
    });
    if (this.enabled) {
      this.logger.log(`[correlation-guard] ENABLED — threshold=${this.cfg.threshold.toFixed(2)} minObs=${this.cfg.minObservations}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Évalue si l'ouverture d'une nouvelle position serait trop corrélée aux
   * positions déjà ouvertes. Retourne assessment ; le caller décide.
   *
   * Best-effort : tout échec fetch → return { reject: false, reason: 'fetch_error' }.
   */
  async assessNewPosition(
    candidate: { symbol: string; assetClass: string },
    openPositions: Array<{ symbol: string; assetClass: string }>,
  ): Promise<CorrelationAssessment> {
    if (!this.enabled) {
      return { reject: false, reason: 'guard_disabled', avgCorr: null, maxCorr: null, perPosition: [] };
    }
    if (openPositions.length === 0) {
      return { reject: false, reason: 'no_open_positions', avgCorr: null, maxCorr: null, perPosition: [] };
    }
    try {
      const candidatePrices = await this.fetchDailyCloses(candidate.symbol, candidate.assetClass);
      if (candidatePrices.length < this.cfg.minObservations + 1) {
        return {
          reject: false,
          reason: `candidate_insufficient_data (${candidatePrices.length} prices)`,
          avgCorr: null, maxCorr: null, perPosition: [],
        };
      }
      const openPrices: OpenPositionPrices[] = [];
      for (const op of openPositions) {
        const prices = await this.fetchDailyCloses(op.symbol, op.assetClass);
        if (prices.length >= this.cfg.minObservations + 1) {
          openPrices.push({ symbol: op.symbol, prices });
        }
      }
      return assessCorrelationRisk(candidatePrices, openPrices, this.cfg);
    } catch (e) {
      this.logger.warn(`[correlation-guard] exception ${candidate.symbol}: ${String(e).slice(0, 150)}`);
      return { reject: false, reason: 'fetch_exception', avgCorr: null, maxCorr: null, perPosition: [] };
    }
  }

  /**
   * Fetch ~30 daily closes pour un symbole, source-aware.
   * Crypto → Binance API (cache interne service 2min)
   * Equities → ohlcv_cache_daily (cron daily 21:30 UTC, max 60 bars/ticker)
   * Cache local additionnel 10min pour limiter les appels redondants sur le même cycle.
   */
  private async fetchDailyCloses(symbol: string, assetClass: string): Promise<number[]> {
    const cacheKey = `${symbol}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_TTL_MS) {
      return cached.prices;
    }
    let prices: number[] = [];
    try {
      if (assetClass.startsWith('crypto')) {
        const candles = await this.binanceMarket.getKlines(symbol, '1d', 30);
        prices = (candles ?? []).map((c) => c.close).filter((p) => Number.isFinite(p) && p > 0);
      } else {
        // Equities → ohlcv_cache_daily, dernières 30 bars
        const { data } = await this.supabase.getClient()
          .from('ohlcv_cache_daily')
          .select('close, bar_date')
          .eq('ticker', symbol)
          .order('bar_date', { ascending: false })
          .limit(30);
        // Ordre ASC pour respecter la convention "récent en dernier" du helper
        prices = ((data ?? []) as Array<{ close: number }>)
          .map((r) => Number(r.close))
          .filter((p) => Number.isFinite(p) && p > 0)
          .reverse();
      }
    } catch (e) {
      this.logger.debug(`[correlation-guard] fetch ${symbol} (${assetClass}) failed: ${String(e).slice(0, 100)}`);
    }
    this.cache.set(cacheKey, { prices, asOf: Date.now() });
    return prices;
  }
}
