import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { MarketDataService } from './market-data.service';
import { QuoteRefreshJobResult } from '../dto/quote-refresh-result.dto';

@Injectable()
export class QuoteRefreshService {
  private readonly logger = new Logger(QuoteRefreshService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly marketData: MarketDataService,
  ) {}

  async runQuoteRefresh(): Promise<QuoteRefreshJobResult> {
    const startedAt = new Date().toISOString();
    const jobId = await this.createJob('quote_refresh');

    const assets = await this.marketData.getActiveSymbolsForRefresh();
    const assetsRequested = assets.length;

    let assetsSucceeded = 0;
    let assetsFailed = 0;

    try {
      const result = await this.marketData.refreshQuotes();
      assetsSucceeded = result.succeeded;
      assetsFailed = result.failed;
    } catch (err) {
      this.logger.error('runQuoteRefresh failed', (err as Error).message);
      assetsFailed = assetsRequested;
    }

    const completedAt = new Date().toISOString();
    await this.completeJob(jobId, assetsRequested, assetsSucceeded, assetsFailed);

    return {
      jobId,
      jobType: 'quote_refresh',
      provider: 'eodhd',
      assetsRequested,
      assetsSucceeded,
      assetsFailed,
      startedAt,
      completedAt,
      errors: [],
    };
  }

  async runBarRefresh(fromDate: string, toDate: string): Promise<QuoteRefreshJobResult> {
    const startedAt = new Date().toISOString();
    const jobId = await this.createJob('bar_refresh');

    const assets = await this.marketData.getActiveSymbolsForRefresh();
    const assetsRequested = assets.length;

    let assetsSucceeded = 0;
    let assetsFailed = 0;

    try {
      const result = await this.marketData.refreshDailyBars(fromDate, toDate);
      assetsSucceeded = result.succeeded;
      assetsFailed = result.failed;
    } catch (err) {
      this.logger.error('runBarRefresh failed', (err as Error).message);
      assetsFailed = assetsRequested;
    }

    const completedAt = new Date().toISOString();
    await this.completeJob(jobId, assetsRequested, assetsSucceeded, assetsFailed);

    return {
      jobId,
      jobType: 'bar_refresh',
      provider: 'eodhd',
      assetsRequested,
      assetsSucceeded,
      assetsFailed,
      startedAt,
      completedAt,
      errors: [],
    };
  }

  private async createJob(jobType: 'quote_refresh' | 'bar_refresh' | 'fx_refresh'): Promise<string> {
    if (!this.supabase.isReady()) return crypto.randomUUID();

    const { data, error } = await this.supabase
      .getClient()
      .from('market_data_jobs')
      .insert({ job_type: jobType, provider: 'eodhd', status: 'running', started_at: new Date().toISOString() })
      .select('id')
      .single();

    if (error || !data) {
      this.logger.warn('createJob insert failed', error?.message);
      return crypto.randomUUID();
    }
    return data.id as string;
  }

  private async completeJob(
    jobId: string,
    assetsRequested: number,
    assetsSucceeded: number,
    assetsFailed: number,
  ) {
    if (!this.supabase.isReady()) return;

    const status = assetsFailed === 0 ? 'done' : assetsSucceeded === 0 ? 'failed' : 'done';
    await this.supabase
      .getClient()
      .from('market_data_jobs')
      .update({
        status,
        assets_requested: assetsRequested,
        assets_succeeded: assetsSucceeded,
        assets_failed: assetsFailed,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }
}
