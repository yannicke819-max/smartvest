import { Module } from '@nestjs/common';
import { FundingController } from './funding.controller';
import { CashController } from './cash.controller';
import { TransfersService } from './services/transfers.service';
import { FundingAccountsService } from './services/funding-accounts.service';
import { FundingAuditService } from './services/funding-audit.service';
import { CashLedgerService } from './services/cash-ledger.service';
import { CashBalancesService } from './services/cash-balances.service';
import { CashReservationsService } from './services/cash-reservations.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [FundingController, CashController],
  providers: [
    TransfersService,
    FundingAccountsService,
    FundingAuditService,
    CashLedgerService,
    CashBalancesService,
    CashReservationsService,
  ],
  exports: [
    TransfersService,
    FundingAccountsService,
    FundingAuditService,
    CashLedgerService,
    CashBalancesService,
    CashReservationsService,
  ],
})
export class FundingModule {}
