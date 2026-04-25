import { Module } from '@nestjs/common';
import { OptimizerController } from './optimizer.controller';
import { OptimizerService } from './optimizer.service';
import { AutoApplyCronService } from './auto-apply-cron.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [OptimizerController],
  providers: [OptimizerService, AutoApplyCronService],
})
export class StrategyOptimizerModule {}
