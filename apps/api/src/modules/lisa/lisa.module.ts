import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LisaController } from './lisa.controller';
import { LisaService } from './services/lisa.service';
import { LisaAutopilotService } from './services/lisa-autopilot.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { MechanicalTradingService } from './services/mechanical-trading.service';

@Module({
  imports: [SupabaseModule],
  controllers: [LisaController],
  providers: [LisaService, LisaAutopilotService, DecisionLogService, RealtimePriceService, EodhdEnrichmentService, MechanicalTradingService],
  exports: [LisaService, DecisionLogService, RealtimePriceService],
})
export class LisaModule {}
