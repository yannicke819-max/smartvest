import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { EodProvider } from './providers/eod/eod.provider';
import { MarketDataService } from './services/market-data.service';
import { QuoteRefreshService } from './services/quote-refresh.service';
import { MarketDataScheduler } from './schedulers/market-data.scheduler';
import { MarketDataController } from './market-data.controller';

@Module({
  imports: [SupabaseModule],
  providers: [EodProvider, MarketDataService, QuoteRefreshService, MarketDataScheduler],
  controllers: [MarketDataController],
  exports: [MarketDataService],
})
export class MarketDataModule {}
