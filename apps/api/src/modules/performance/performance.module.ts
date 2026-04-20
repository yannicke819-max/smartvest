import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ValuationModule } from '../valuation/valuation.module';
import { PerformanceService } from './performance.service';
import { PerformanceController } from './performance.controller';

@Module({
  imports: [SupabaseModule, ValuationModule],
  providers: [PerformanceService],
  controllers: [PerformanceController],
  exports: [PerformanceService],
})
export class PerformanceModule {}
