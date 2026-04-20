import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ValuationModule } from '../valuation/valuation.module';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';

@Module({
  imports: [SupabaseModule, ValuationModule],
  providers: [AlertsService],
  controllers: [AlertsController],
  exports: [AlertsService],
})
export class AlertsModule {}
