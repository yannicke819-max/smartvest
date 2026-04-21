import { Module } from '@nestjs/common';
import { BrokersController } from './brokers.controller';
import { BrokersService } from './services/brokers.service';
import { BrokerSyncService } from './services/broker-sync.service';
import { BrokersAuditService } from './services/brokers-audit.service';
import { CredentialsVaultService } from './services/credentials-vault.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';

@Module({
  imports: [SupabaseModule, FeatureFlagsModule],
  controllers: [BrokersController],
  providers: [BrokersService, BrokerSyncService, BrokersAuditService, CredentialsVaultService],
  exports: [BrokersService, BrokerSyncService, CredentialsVaultService],
})
export class BrokersModule {}
