import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BotLabController } from './bot-lab.controller';
import { BotConnectorService } from './services/bot-connector.service';
import { JournalNormalizerService } from './services/journal-normalizer.service';
import { PerformanceEngineService } from './services/performance-engine.service';
import { EquityCurveService } from './services/equity-curve.service';
import { RegimeTaggerService } from './services/regime-tagger.service';
import { BotComparatorService } from './services/bot-comparator.service';
import { PatternMinerService } from './services/pattern-miner.service';
import { PatternAdoptionService } from './services/pattern-adoption.service';
import { PatternBriefingService } from './services/pattern-briefing.service';

/**
 * Bot Profitability Lab — module R&D séparé du flow Lisa principal.
 *
 * Phase 1 : foundations DB + types + CRUD + CSV import.
 * Phase 2 : performance engine + equity curve + regime tagger + comparator.
 * Phase 3 : pattern miner — clustering setups + scoring robustesse.
 * Phase 4 (CE COMMIT) : transfer layer vers Lisa via lisa_pattern_adoptions.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [BotLabController],
  providers: [
    BotConnectorService,
    JournalNormalizerService,
    PerformanceEngineService,
    EquityCurveService,
    RegimeTaggerService,
    BotComparatorService,
    PatternMinerService,
    // Phase 4 — Transfer Layer
    PatternAdoptionService,
    PatternBriefingService,
  ],
  exports: [
    BotConnectorService,
    JournalNormalizerService,
    PerformanceEngineService,
    EquityCurveService,
    RegimeTaggerService,
    BotComparatorService,
    PatternMinerService,
    // Phase 4 — exposés pour lisa.module
    PatternAdoptionService,
    PatternBriefingService,
  ],
})
export class BotLabModule {}
