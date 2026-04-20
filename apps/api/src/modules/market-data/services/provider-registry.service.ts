import { Injectable, Logger } from '@nestjs/common';
import { MarketDataProvider, ProviderAsset } from '../providers/market-data-provider.interface';
import { InstrumentQuote } from '../dto/instrument-quote.dto';
import { PriceBar } from '../dto/price-bar.dto';
import { EodProvider } from '../providers/eod/eod.provider';
import { ManualProvider } from '../providers/manual.provider';
import { SupabaseService } from '../../supabase/supabase.service';

export interface ProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'down';
  lastCheckedAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
}

/**
 * Registry of market-data providers with ordered priority for failover.
 * Priority order: EOD > Manual (fallback).
 *
 * fetchQuotes() / fetchDailyBars() attempt each provider in order until one returns
 * a non-empty result. Health is logged after each attempt.
 */
@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);
  private readonly providers: MarketDataProvider[];

  constructor(
    private readonly supabase: SupabaseService,
    eod: EodProvider,
    manual: ManualProvider,
  ) {
    // Priority: EOD primary, manual as no-op fallback
    this.providers = [eod, manual];
  }

  listProviders(): string[] {
    return this.providers.map((p) => p.name);
  }

  async fetchQuotesWithFailover(assets: ProviderAsset[]): Promise<InstrumentQuote[]> {
    for (const provider of this.providers) {
      const t0 = Date.now();
      try {
        const quotes = await provider.fetchQuotes(assets);
        const latency = Date.now() - t0;
        if (quotes.length > 0) {
          await this.recordHealth(provider.name, 'quote', 'healthy', latency, null);
          return quotes;
        }
        await this.recordHealth(provider.name, 'quote', 'degraded', latency, 'Aucune cotation renvoyée');
      } catch (err) {
        const latency = Date.now() - t0;
        await this.recordHealth(provider.name, 'quote', 'down', latency, (err as Error).message);
      }
    }
    return [];
  }

  async fetchDailyBarsWithFailover(
    assets: ProviderAsset[],
    fromDate: string,
    toDate: string,
  ): Promise<PriceBar[]> {
    for (const provider of this.providers) {
      const t0 = Date.now();
      try {
        const bars = await provider.fetchDailyBars(assets, fromDate, toDate);
        const latency = Date.now() - t0;
        if (bars.length > 0) {
          await this.recordHealth(provider.name, 'bar', 'healthy', latency, null);
          return bars;
        }
        await this.recordHealth(provider.name, 'bar', 'degraded', latency, 'Aucune barre renvoyée');
      } catch (err) {
        const latency = Date.now() - t0;
        await this.recordHealth(provider.name, 'bar', 'down', latency, (err as Error).message);
      }
    }
    return [];
  }

  async getHealth(): Promise<ProviderHealth[]> {
    if (!this.supabase.isReady()) {
      return this.providers.map((p) => ({
        provider: p.name,
        status: 'healthy',
        lastCheckedAt: null,
        lastError: null,
        latencyMs: null,
      }));
    }

    // Fetch the most recent health check per provider
    const results: ProviderHealth[] = [];
    for (const p of this.providers) {
      const { data } = await this.supabase
        .getClient()
        .from('market_data_provider_health')
        .select('*')
        .eq('provider', p.name)
        .order('checked_at', { ascending: false })
        .limit(1);
      const latest = data?.[0];
      results.push({
        provider: p.name,
        status: (latest?.status as ProviderHealth['status']) ?? 'healthy',
        lastCheckedAt: (latest?.checked_at as string) ?? null,
        lastError: (latest?.error_message as string) ?? null,
        latencyMs: (latest?.latency_ms as number) ?? null,
      });
    }
    return results;
  }

  private async recordHealth(
    provider: string,
    checkType: 'quote' | 'bar' | 'fx',
    status: 'healthy' | 'degraded' | 'down',
    latencyMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      await this.supabase.getClient().from('market_data_provider_health').insert({
        provider,
        check_type: checkType,
        status,
        latency_ms: latencyMs,
        error_message: errorMessage,
      });
    } catch (err) {
      this.logger.warn(`recordHealth failed: ${(err as Error).message}`);
    }
  }
}
