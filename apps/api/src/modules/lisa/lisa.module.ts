import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LisaController } from './lisa.controller';
import { LisaService } from './services/lisa.service';
import { LisaAutopilotService } from './services/lisa-autopilot.service';
import { DecisionLogService } from './services/decision-log.service';

@Module({
  imports: [SupabaseModule],
  controllers: [LisaController],
  providers: [LisaService, LisaAutopilotService, DecisionLogService],
  exports: [LisaService, DecisionLogService],
})
export class LisaModule {}
