import { Module } from '@nestjs/common';
import { SniperController } from './sniper.controller';
import { SniperService } from './sniper.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [SupabaseModule, FeatureFlagsModule],
  controllers: [SniperController],
  providers: [SniperService],
  exports: [SniperService],
})
export class SniperModule {}
