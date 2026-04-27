import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { BotConnectorService } from './services/bot-connector.service';
import { JournalNormalizerService } from './services/journal-normalizer.service';
import { PerformanceEngineService } from './services/performance-engine.service';
import { EquityCurveService } from './services/equity-curve.service';
import { RegimeTaggerService } from './services/regime-tagger.service';
import { BotComparatorService } from './services/bot-comparator.service';
import { PatternMinerService } from './services/pattern-miner.service';
import type { BotDefinitionDraft, PatternStatus } from './types/bot-lab.types';

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
    private readonly perfEngine: PerformanceEngineService,
    private readonly equityCurve: EquityCurveService,
    private readonly regimeTagger: RegimeTaggerService,
    private readonly comparator: BotComparatorService,
    private readonly patternMiner: PatternMinerService,
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

  // ───────────────────────────────────────────────────────────────────
  // PHASE 2 — METRICS / EQUITY / COMPARE
  // ───────────────────────────────────────────────────────────────────

  /** Métriques composite d'un bot (Sharpe, Sortino, MaxDD, etc.). */
  @Get('bots/:botId/metrics')
  async getMetrics(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    extractUserId(headers);
    const summary = await this.perfEngine.computeSummary(botId);
    return { summary };
  }

  /** Courbe equity jour par jour. */
  @Get('bots/:botId/equity-curve')
  async getEquityCurve(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    extractUserId(headers);
    const curve = await this.equityCurve.getCurve(botId);
    return { curve };
  }

  /** Métriques par session (regime / VIX bucket / asset class). */
  @Get('bots/:botId/sessions')
  async getSessionMetrics(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    extractUserId(headers);
    const sessions = await this.comparator.getSessionMetrics(botId);
    return { sessions };
  }

  /**
   * Recompute pipeline complet : tag regime + equity curve + session metrics.
   * À appeler après import CSV ou si données stale.
   */
  @Post('bots/:botId/recompute')
  @HttpCode(200)
  async recompute(
    @Headers() headers: Record<string, string>,
    @Param('botId') botId: string,
  ) {
    const userId = extractUserId(headers);
    const bot = await this.connector.getBot(userId, botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);

    const tagged = await this.regimeTagger.tagBotTrades(botId);
    const equity = await this.equityCurve.refreshDaily(botId, parseFloat(bot.capitalBaseUsd));
    await this.comparator.refreshSessionMetrics(botId);
    await this.connector.updateBotStats(botId);

    return {
      tagged: tagged.tagged,
      totalTrades: tagged.total,
      daysGenerated: equity.daysGenerated,
      finalEquity: equity.finalEquity,
      finalCumulPnl: equity.finalCumulPnl,
    };
  }

  /** Comparator multi-bots côte à côte. Query : ?botIds=a,b,c */
  @Get('compare')
  async compareBots(
    @Headers() headers: Record<string, string>,
    @Query('botIds') botIdsCsv: string,
  ) {
    extractUserId(headers);
    if (!botIdsCsv) throw new Error('botIds query param requis (CSV)');
    const botIds = botIdsCsv.split(',').map((s) => s.trim()).filter(Boolean);
    if (botIds.length === 0) throw new Error('Au moins 1 bot id requis');
    if (botIds.length > 5) throw new Error('Max 5 bots par compare');

    const entries = await this.comparator.compareBots(botIds);
    return { entries };
  }

  // ───────────────────────────────────────────────────────────────────
  // PHASE 3 — PATTERN MINER
  // ───────────────────────────────────────────────────────────────────

  /**
   * Trigger le mining cross-bots pour le user.
   * Analyse tous les bots actifs, clusters les trades par signature
   * (asset_class + direction + vix_bucket), score robustesse + composite.
   */
  @Post('patterns/mine')
  @HttpCode(200)
  async minePatterns(
    @Headers() headers: Record<string, string>,
  ) {
    const userId = extractUserId(headers);
    const result = await this.patternMiner.mineFromUserBots(userId);
    return result;
  }

  /**
   * Liste les patterns du user, triés par composite score décroissant.
   * Query : ?status=candidate|validated|rejected|deprecated (optionnel)
   */
  @Get('patterns')
  async listPatterns(
    @Headers() headers: Record<string, string>,
    @Query('status') status?: string,
  ) {
    const userId = extractUserId(headers);
    const validStatuses: PatternStatus[] = ['candidate', 'validated', 'rejected', 'deprecated'];
    const filterStatus = status && validStatuses.includes(status as PatternStatus)
      ? status as PatternStatus
      : undefined;
    const patterns = await this.patternMiner.listPatterns(userId, filterStatus);
    return { patterns };
  }
}
