import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ValuationModule } from '../valuation/valuation.module';
import { SimulationsService } from './simulations.service';
import { SimulationsController } from './simulations.controller';

@Module({
  imports: [SupabaseModule, ValuationModule],
  providers: [SimulationsService],
  controllers: [SimulationsController],
  exports: [SimulationsService],
})
export class SimulationsModule {}
