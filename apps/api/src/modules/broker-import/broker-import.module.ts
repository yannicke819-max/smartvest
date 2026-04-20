import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BrokerImportController } from './broker-import.controller';
import { BrokerImportService } from './services/broker-import.service';
import { AssetMatcherService } from './services/asset-matcher.service';
import { PortfolioReconstitutionService } from './services/portfolio-reconstitution.service';
import { InteractiveBrokersParser } from './parsers/interactive-brokers.parser';
import { DegiroParser } from './parsers/degiro.parser';
import { ParserRegistry } from './parsers/parser-registry';

@Module({
  imports: [SupabaseModule],
  controllers: [BrokerImportController],
  providers: [
    BrokerImportService,
    AssetMatcherService,
    PortfolioReconstitutionService,
    InteractiveBrokersParser,
    DegiroParser,
    ParserRegistry,
  ],
  exports: [BrokerImportService, PortfolioReconstitutionService],
})
export class BrokerImportModule {}
