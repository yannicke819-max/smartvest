import { Module } from '@nestjs/common';
import { BrokersController } from './brokers.controller';
import { BrokersService } from './services/brokers.service';
import { BrokerSyncService } from './services/broker-sync.service';
import { BrokersAuditService } from './services/brokers-audit.service';
import { CredentialsVaultService } from './services/credentials-vault.service';
import { IbkrSessionKeepAliveService } from './services/ibkr-session-keepalive.service';
import { PreExecutionGuardService } from './services/pre-execution-guard.service';
import { BrokerReconciliationService } from './services/broker-reconciliation.service';
import { RealCostCalibratorService } from './services/real-cost-calibrator.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [SupabaseModule, FeatureFlagsModule],
  controllers: [BrokersController],
  providers: [
    BrokersService,
    BrokerSyncService,
    BrokersAuditService,
    CredentialsVaultService,
    IbkrSessionKeepAliveService,
    PreExecutionGuardService,
    BrokerReconciliationService,
    RealCostCalibratorService,
  ],
  exports: [BrokersService, BrokerSyncService, CredentialsVaultService, PreExecutionGuardService],
})
export class BrokersModule {}
