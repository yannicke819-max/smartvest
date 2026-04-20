import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataProvider, ProviderAsset } from '../market-data-provider.interface';
import { InstrumentQuote } from '../../dto/instrument-quote.dto';
import { PriceBar } from '../../dto/price-bar.dto';
import { EodRealtimeQuote, EodEodBar } from './eod-types';
import { normalizeEodRealtimeQuote, normalizeEodBar } from './eod-normalizer';

const BASE_URL = 'https://eodhd.com/api';

@Injectable()
export class EodProvider implements MarketDataProvider {
  readonly name = 'eodhd';
  private readonly logger = new Logger(EodProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('EODHD_API_KEY') ?? 'demo';
  }

  async fetchQuotes(assets: ProviderAsset[]): Promise<InstrumentQuote[]> {
    if (assets.length === 0) return [];

    const results: InstrumentQuote[] = [];
    const errors: string[] = [];

    // EOD real-time endpoint: one call per ticker
    await Promise.allSettled(
      assets.map(async (asset) => {
        try {
          const url = `${BASE_URL}/real-time/${encodeURIComponent(asset.providerTicker)}?api_token=${this.apiKey}&fmt=json`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const raw: EodRealtimeQuote = await res.json();
          results.push(normalizeEodRealtimeQuote(raw, asset));
        } catch (err) {
          errors.push(`${asset.ticker}: ${(err as Error).message}`);
        }
      }),
    );

    if (errors.length > 0) {
      this.logger.warn(`fetchQuotes errors: ${errors.join(', ')}`);
    }
    return results;
  }

  async fetchDailyBars(
    assets: ProviderAsset[],
    fromDate: string,
    toDate: string,
  ): Promise<PriceBar[]> {
    if (assets.length === 0) return [];

    const results: PriceBar[] = [];
    const errors: string[] = [];

    await Promise.allSettled(
      assets.map(async (asset) => {
        try {
          const url =
            `${BASE_URL}/eod/${encodeURIComponent(asset.providerTicker)}` +
            `?api_token=${this.apiKey}&fmt=json&from=${fromDate}&to=${toDate}&period=d`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bars: EodEodBar[] = await res.json();
          for (const bar of bars) {
            results.push(normalizeEodBar(bar, asset));
          }
        } catch (err) {
          errors.push(`${asset.ticker}: ${(err as Error).message}`);
        }
      }),
    );

    if (errors.length > 0) {
      this.logger.warn(`fetchDailyBars errors: ${errors.join(', ')}`);
    }
    return results;
  }
}
