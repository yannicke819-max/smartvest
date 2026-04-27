import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { BotConnectorService } from './services/bot-connector.service';
import { JournalNormalizerService } from './services/journal-normalizer.service';
import type { BotDefinitionDraft } from './types/bot-lab.types';

/**
 * BotLabController — API du module Bot Profitability Lab.
 *
 * Phase 1 endpoints :
 *  - CRUD bots
 *  - Upload CSV
 *  - Liste trades d'un bot
 *
 * Phases 2-4 ajouteront :
 *  - Métriques (Sharpe, etc.)
 *  - Comparator multi-bots
 *  - Patterns + transfer layer
 */
@Controller('bot-lab')
export class BotLabController {
  constructor(
    private readonly connector: BotConnectorService,
    private readonly normalizer: JournalNormalizerService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // BOT CRUD
  // ───────────────────────────────────────────────────────────────────

  @Get('bots')
  async listBots(
    @Headers() headers: Record<string, string>,
    @Query('active_only') activeOnly?: string,
  ) {
    const userId = extractUserId(headers);
    const bots = await this.connector.listBots(userId, activeOnly === 'true');
    return { bots };
  }

  @Get('bots/:botId')
  async getBot(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    const userId = extractUserId(headers);
    const bot = await this.connector.getBot(userId, botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);
    return { bot };
  }

  @Post('bots')
  async createBot(
    @Headers() headers: Record<string, string>,
    @Body() body: BotDefinitionDraft,
  ) {
    const userId = extractUserId(headers);
    const bot = await this.connector.createBot(userId, body);
    return { bot };
  }

  @Post('bots/:botId')
  async updateBot(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
    @Body() body: Partial<BotDefinitionDraft>,
  ) {
    const userId = extractUserId(headers);
    await this.connector.updateBot(userId, botId, body);
    return { ok: true };
  }

  @Delete('bots/:botId')
  @HttpCode(200)
  async deleteBot(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    const userId = extractUserId(headers);
    await this.connector.deleteBot(userId, botId);
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────
  // CSV IMPORT
  // ───────────────────────────────────────────────────────────────────

  /**
   * Upload CSV de trades pour un bot.
   * Body : { csv: string }
   *
   * Le CSV doit contenir au minimum (header obligatoire) :
   *   symbol, direction, entry_timestamp, entry_price
   *
   * Optionnel :
   *   quantity, entry_notional_usd, exit_timestamp, exit_price, exit_reason,
   *   asset_class, external_id, entry_cost_usd, exit_cost_usd, net_pnl_usd
   *
   * Idempotent : un même external_id n'est inséré qu'une fois.
   */
  @Post('bots/:botId/import-csv')
  async importCsv(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
    @Body() body: { csv: string },
  ) {
    const userId = extractUserId(headers);
    if (!body.csv || body.csv.length === 0) {
      throw new Error('CSV vide ou manquant');
    }
    const result = await this.connector.importCsv(userId, botId, body.csv);
    return result;
  }

  // ───────────────────────────────────────────────────────────────────
  // TRADES
  // ───────────────────────────────────────────────────────────────────

  @Get('bots/:botId/trades')
  async listTrades(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
    @Query('limit') limit?: string,
  ) {
    extractUserId(headers); // validation
    const trades = await this.normalizer.listTrades(
      botId,
      limit ? Math.min(1000, parseInt(limit, 10)) : 100,
    );
    return { trades };
  }
}
