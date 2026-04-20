export interface QuoteRefreshJobResult {
  jobId: string;
  jobType: 'quote_refresh' | 'bar_refresh' | 'fx_refresh';
  provider: string;
  assetsRequested: number;
  assetsSucceeded: number;
  assetsFailed: number;
  startedAt: string;
  completedAt: string;
  errors: Array<{ assetId: string; ticker: string; error: string }>;
}
