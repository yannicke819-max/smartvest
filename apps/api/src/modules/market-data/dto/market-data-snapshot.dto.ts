import { InstrumentQuote } from './instrument-quote.dto';
import { PriceBar } from './price-bar.dto';

/**
 * A point-in-time snapshot of all market data for a portfolio.
 * Combines latest quotes with most recent daily bars for full context.
 */
export interface MarketDataSnapshot {
  portfolioId: string;
  snapshotAt: string; // ISO timestamp
  provider: string;
  quotes: InstrumentQuote[];
  latestBars: PriceBar[];
  missingQuotes: string[]; // assetIds with no live quote
  stalePriceAssetIds: string[]; // assetIds where quote is older than staleThresholdMs
}
