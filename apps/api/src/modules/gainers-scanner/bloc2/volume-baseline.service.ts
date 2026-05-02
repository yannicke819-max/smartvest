/**
 * BLOC 2 — Volume baseline service (ADR-005).
 *
 * Charge et met en cache la médiane du volume dollar sur 20j depuis
 * gainers_volume_baselines. Cron quotidien 01:00 UTC.
 *
 * Note : le refresh des baselines depuis EODHD/Binance est un TODO
 * dépendant de l'intégration des flux de données externes. Pour l'instant,
 * le service expose get/upsert — le caller externe peuple la table.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';

export interface VolumeBaselineRow {
  symbol: string;
  exchange: string;
  assetClass: 'equity' | 'crypto';
  windowDays: number;
  medianDollarVolume: number;
  lastNonzeroAt: string | null;
  updatedAt: string;
}

export interface UpsertBaselineInput {
  symbol: string;
  exchange: string;
  assetClass: 'equity' | 'crypto';
  medianDollarVolume: number;
  lastNonzeroAt?: string | null;
}

@Injectable()
export class VolumeBaselineService {
  private readonly logger = new Logger(VolumeBaselineService.name);
  /** Cache en mémoire : clé = `${symbol}::${exchange}` */
  private cache = new Map<string, number>();
  private cacheLoadedAt: Date | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  private cacheKey(symbol: string, exchange: string): string {
    return `${symbol}::${exchange}`;
  }

  /**
   * Retourne la médiane du volume dollar 20j pour un symbole.
   * Lit depuis le cache mémoire chargé au dernier cron/boot.
   * null si baseline absente (candidat non encore baseliné).
   */
  getBaseline(symbol: string, exchange: string): number | null {
    return this.cache.get(this.cacheKey(symbol, exchange)) ?? null;
  }

  /** Upsert d'une ou plusieurs baselines en DB. */
  async upsertBaselines(rows: UpsertBaselineInput[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.supabase
      .getClient()
      .from('gainers_volume_baselines')
      .upsert(
        rows.map((r) => ({
          symbol: r.symbol,
          exchange: r.exchange,
          asset_class: r.assetClass,
          window_days: 20,
          median_dollar_volume: r.medianDollarVolume,
          last_nonzero_at: r.lastNonzeroAt ?? null,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'symbol,exchange' },
      );
    if (error) {
      this.logger.error(`upsertBaselines failed: ${error.message}`);
      throw error;
    }
  }

  /** Recharge le cache mémoire depuis la DB. */
  async reloadCache(): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_volume_baselines')
      .select('symbol, exchange, median_dollar_volume');
    if (error) {
      this.logger.error(`reloadCache failed: ${error.message}`);
      return;
    }
    this.cache.clear();
    for (const row of data ?? []) {
      this.cache.set(this.cacheKey(row.symbol, row.exchange), Number(row.median_dollar_volume));
    }
    this.cacheLoadedAt = new Date();
    this.logger.log(`Volume baseline cache loaded: ${this.cache.size} entries`);
  }

  /**
   * Cron quotidien 01:00 UTC — recharge le cache après la clôture US.
   *
   * Depuis BLOC 4.0 (PR5) : déclenche d'abord l'ETL `VolumeBaselineCalculatorService`
   * pour recalculer les médianes 20j depuis ohlcv_cache_daily (equity, déjà
   * alimenté par OhlcvCacheService 21:30 UTC) + Binance klines (crypto).
   * L'ETL est wired via setEtlRunner() au boot du module pour éviter une
   * dépendance circulaire (calculator → baseline service).
   */
  @Cron('0 1 * * *')
  async handleDailyBaselinesRefresh(): Promise<void> {
    this.logger.log('Daily volume baselines cron started');
    if (this.etlRunner) {
      try {
        await this.etlRunner();
      } catch (e) {
        this.logger.error(`[baseline-etl] runner failed: ${String(e).slice(0, 200)}`);
      }
    } else {
      this.logger.warn('[baseline-etl] no ETL runner registered — skipping calculation, cache reload only');
    }
    await this.reloadCache();
  }

  /** Wire l'ETL runner depuis le module (évite cycle DI). */
  setEtlRunner(runner: () => Promise<void>): void {
    this.etlRunner = runner;
  }
  private etlRunner: (() => Promise<void>) | null = null;

  /** Calcule le RVOL intraday cumulatif pour un candidat donné. */
  computeRvol(
    symbol: string,
    exchange: string,
    intradayVolUsd: number,
  ): number | null {
    const baseline = this.getBaseline(symbol, exchange);
    if (baseline === null || baseline === 0) return null;
    return intradayVolUsd / baseline;
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}
