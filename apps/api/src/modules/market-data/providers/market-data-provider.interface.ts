import { InstrumentQuote } from '../dto/instrument-quote.dto';
import { PriceBar } from '../dto/price-bar.dto';

export interface ProviderAsset {
  assetId: string;
  ticker: string; // internal ticker
  providerTicker: string; // e.g. "AAPL.US" for EODHD
  currency: string;
}

export interface MarketDataProvider {
  readonly name: string;

  fetchQuotes(assets: ProviderAsset[]): Promise<InstrumentQuote[]>;
  fetchDailyBars(assets: ProviderAsset[], fromDate: string, toDate: string): Promise<PriceBar[]>;
}
