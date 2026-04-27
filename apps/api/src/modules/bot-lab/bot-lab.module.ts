import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BotLabController } from './bot-lab.controller';
import { BotConnectorService } from './services/bot-connector.service';
import { JournalNormalizerService } from './services/journal-normalizer.service';

/**
 * Bot Profitability Lab — module R&D séparé du flow Lisa principal.
 *
 * Phase 1 (CE COMMIT) : foundations DB + types + CRUD + CSV import.
 * Phases 2-4 (à venir) : performance engine, pattern miner, transfer layer.
 *
 * Indépendance volontaire :
 *  - Pas d'import depuis modules/lisa
 *  - Pas de cron
 *  - Pas de modification du flow trading principal
 *  - Phase 4 (transfer layer) sera le seul lien — Lisa lit
 *    lisa_pattern_adoptions pour intégrer les patterns au briefing.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [BotLabController],
  providers: [
    BotConnectorService,
    JournalNormalizerService,
  ],
  exports: [
    BotConnectorService,
    JournalNormalizerService,
  ],
})
export class BotLabModule {}
