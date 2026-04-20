import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BrokerSyncService } from './services/broker-sync.service';
import { BrokerSyncController } from './broker-sync.controller';

@Module({
  imports: [SupabaseModule],
  providers: [BrokerSyncService],
  controllers: [BrokerSyncController],
  exports: [BrokerSyncService],
})
export class BrokerSyncModule {}
