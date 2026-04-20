import { Module } from '@nestjs/common';
import { FundingController } from './funding.controller';
import { TransfersService } from './services/transfers.service';
import { FundingAccountsService } from './services/funding-accounts.service';
import { FundingAuditService } from './services/funding-audit.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [FundingController],
  providers: [TransfersService, FundingAccountsService, FundingAuditService],
  exports: [TransfersService, FundingAccountsService, FundingAuditService],
})
export class FundingModule {}
