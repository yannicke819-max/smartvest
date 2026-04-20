import {
  Controller,
  Get,
  Post,
  Query,
  Headers,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import { MarketDataService } from './services/market-data.service';
import { QuoteRefreshService } from './services/quote-refresh.service';
import { ProviderRegistryService } from './services/provider-registry.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('market-data')
export class MarketDataController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly quoteRefresh: QuoteRefreshService,
    private readonly registry: ProviderRegistryService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('providers/health')
  async providerHealth(@Headers('authorization') auth: string) {
    await this.requireAuth(auth);
    const data = await this.registry.getHealth();
    return { ok: true, data };
  }

  @Get('quotes/latest')
  async latestQuotes(
    @Headers('authorization') auth: string,
    @Query('assetIds') assetIdsParam?: string,
  ) {
    await this.requireAuth(auth);
    const assetIds = assetIdsParam ? assetIdsParam.split(',').filter(Boolean) : undefined;
    const quotes = await this.marketData.getLatestQuotes(assetIds);
    return { ok: true, data: quotes };
  }

  @Post('refresh/quotes')
  async triggerQuoteRefresh(@Headers('authorization') auth: string) {
    await this.requireAuth(auth);
    const result = await this.quoteRefresh.runQuoteRefresh();
    return { ok: true, data: result };
  }

  @Post('refresh/bars')
  async triggerBarRefresh(
    @Headers('authorization') auth: string,
    @Body() body: { fromDate?: string; toDate?: string },
  ) {
    await this.requireAuth(auth);
    const today = new Date().toISOString().slice(0, 10);
    const fromDate = body.fromDate ?? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const toDate = body.toDate ?? today;
    const result = await this.quoteRefresh.runBarRefresh(fromDate, toDate);
    return { ok: true, data: result };
  }

  private async requireAuth(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
  }
}
