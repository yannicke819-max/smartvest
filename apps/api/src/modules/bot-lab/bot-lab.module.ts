import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BotLabController } from './bot-lab.controller';
import { BotConnectorService } from './services/bot-connector.service';
import { JournalNormalizerService } from './services/journal-normalizer.service';
import { PerformanceEngineService } from './services/performance-engine.service';
import { EquityCurveService } from './services/equity-curve.service';
import { RegimeTaggerService } from './services/regime-tagger.service';
import { BotComparatorService } from './services/bot-comparator.service';

/**
 * Bot Profitability Lab — module R&D séparé du flow Lisa principal.
 *
 * Phase 1 : foundations DB + types + CRUD + CSV import.
 * Phase 2 (CE COMMIT) : performance engine + equity curve + regime tagger
 *                     + comparator multi-bots.
 * Phases 3-4 (à venir) : pattern miner + transfer layer.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [BotLabController],
  providers: [
    BotConnectorService,
    JournalNormalizerService,
    // Phase 2
    PerformanceEngineService,
    EquityCurveService,
    RegimeTaggerService,
    BotComparatorService,
  ],
  exports: [
    BotConnectorService,
    JournalNormalizerService,
    PerformanceEngineService,
    EquityCurveService,
    RegimeTaggerService,
    BotComparatorService,
  ],
})
export class BotLabModule {}
