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
   * Le peuplement des baselines depuis EODHD/Binance est géré par un
   * process externe (pipeline ETL à brancher en PR-baseline-etl).
   */
  @Cron('0 1 * * *')
  async handleDailyBaselinesRefresh(): Promise<void> {
    this.logger.log('Daily volume baselines cache refresh started');
    await this.reloadCache();
  }

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
