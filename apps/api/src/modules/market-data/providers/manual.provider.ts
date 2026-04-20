import { Injectable } from '@nestjs/common';
import { MarketDataProvider, ProviderAsset } from './market-data-provider.interface';
import { InstrumentQuote } from '../dto/instrument-quote.dto';
import { PriceBar } from '../dto/price-bar.dto';

/**
 * ManualProvider is a no-op fallback used when no external provider is available.
 * It never returns any data — its role is to keep the registry populated for health checks.
 */
@Injectable()
export class ManualProvider implements MarketDataProvider {
  readonly name = 'manual';

  async fetchQuotes(_assets: ProviderAsset[]): Promise<InstrumentQuote[]> {
    return [];
  }

  async fetchDailyBars(_assets: ProviderAsset[], _from: string, _to: string): Promise<PriceBar[]> {
    return [];
  }
}
