import { Module } from '@nestjs/common';
import { HyperTradingController } from './hyper-trading.controller';
import { HyperTradingProfileService } from './services/hyper-trading-profile.service';
import { HyperTradingAuditService } from './services/hyper-trading-audit.service';
import { HyperTradingPolicyEngine } from './services/hyper-trading-policy-engine.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [SupabaseModule, FeatureFlagsModule],
  controllers: [HyperTradingController],
  providers: [HyperTradingProfileService, HyperTradingAuditService, HyperTradingPolicyEngine],
  exports: [HyperTradingProfileService, HyperTradingAuditService, HyperTradingPolicyEngine],
})
export class HyperTradingModule {}
