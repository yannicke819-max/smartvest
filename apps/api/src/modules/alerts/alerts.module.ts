import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ValuationModule } from '../valuation/valuation.module';
import { AlertsService } from './alerts.service';
import { AlertRulesService } from './alert-rules.service';
import { AlertsController } from './alerts.controller';

@Module({
  imports: [SupabaseModule, ValuationModule],
  providers: [AlertsService, AlertRulesService],
  controllers: [AlertsController],
  exports: [AlertsService, AlertRulesService],
})
export class AlertsModule {}
