import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { PerformanceModule } from '../performance/performance.module';
import { LisaController } from './lisa.controller';
import { LisaService } from './services/lisa.service';
import { LisaAutopilotService } from './services/lisa-autopilot.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { EodhdTechnicalService } from './services/eodhd-technical.service';
import { EodhdIntradayService } from './services/eodhd-intraday.service';
import { ExchangeHoursService } from './services/exchange-hours.service';
import { BinanceMarketService } from './services/binance-market.service';
import { EodhdMacroService } from './services/eodhd-macro.service';
import { MechanicalTradingService } from './services/mechanical-trading.service';

@Module({
  imports: [SupabaseModule, PerformanceModule],
  controllers: [LisaController],
  providers: [LisaService, LisaAutopilotService, DecisionLogService, RealtimePriceService, EodhdEnrichmentService, EodhdTechnicalService, EodhdIntradayService, ExchangeHoursService, BinanceMarketService, EodhdMacroService, MechanicalTradingService],
  exports: [LisaService, DecisionLogService, RealtimePriceService, EodhdTechnicalService, EodhdIntradayService, ExchangeHoursService, BinanceMarketService, EodhdMacroService],
})
export class LisaModule {}
