export interface InstrumentQuote {
  assetId: string;
  ticker: string;
  price: string;
  currency: string;
  asOf: string; // ISO timestamp
  provider: string;
  marketState: 'open' | 'closed' | 'pre' | 'after' | 'unknown';
  previousClose: string | undefined;
  changeAbsolute: string | undefined;
  changePercent: string | undefined;
  rawPayload: Record<string, unknown> | undefined;
}
