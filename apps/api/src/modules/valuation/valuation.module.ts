import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ValuationService } from './valuation.service';
import { ValuationController } from './valuation.controller';

@Module({
  imports: [SupabaseModule],
  providers: [ValuationService],
  controllers: [ValuationController],
  exports: [ValuationService],
})
export class ValuationModule {}
