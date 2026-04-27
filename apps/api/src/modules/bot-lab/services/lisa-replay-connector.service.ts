import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import { JournalNormalizerService } from './journal-normalizer.service';
import { BotConnectorService } from './bot-connector.service';
import { EquityCurveService } from './equity-curve.service';
import { RegimeTaggerService } from './regime-tagger.service';
import { BotComparatorService } from './bot-comparator.service';
import type { BotDefinition, RawTradeImport, TradeDirection } from '../types/bot-lab.types';

/**
 * LisaReplayConnectorService — auto-import des trades fermés de Lisa
 * comme un bot externe "Lisa Live" pour analyse Bot Lab.
 *
 * Boucle vertueuse :
 *   Lisa trade → trades fermés en DB → ce service les copie dans
 *   bot_paper_trades → Bot Lab calcule métriques + extrait patterns →
 *   Lisa adopte les patterns → Lisa s'améliore → trades meilleurs →
 *   patterns affinés → ...
 *
 * Idempotent : ré-appelable à volonté, ne dupliquera pas les trades
 * (UNIQUE constraint sur bot_id + external_id = lisa_position.id).
 *
 * Auto-création du bot "Lisa Live" au 1er sync si inexistant. 1 bot par
 * (user, portfolio).
 */
@Injectable()
export class LisaReplayConnectorService {
  private readonly logger = new Logger(LisaReplayConnectorService.name);
  private static readonly LISA_BOT_NAME_PREFIX = 'Lisa Live';
  private static readonly LISA_BOT_TAG = 'auto-sync';

  constructor(
    private readonly supabase: SupabaseService,
    private readonly normalizer: JournalNormalizerService,
    private readonly connector: BotConnectorService,
    private readonly equityCurve: EquityCurveService,
    private readonly regimeTagger: RegimeTaggerService,
    private readonly comparator: BotComparatorService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // SYNC PRINCIPAL
  // ───────────────────────────────────────────────────────────────────

  /**
   * Sync les trades fermés Lisa de TOUS les portfolios simulation d'un user
   * vers les bots "Lisa Live" correspondants (1 bot par portfolio).
   *
   * Appelé par cron périodique + endpoint manuel.
   */
  async syncAllForUser(userId: string): Promise<{ syncedPortfolios: number; totalImported: number }> {
    // Récupère tous les portfolios simulation du user
    const { data: portfolios } = await this.supabase.getClient()
      .from('portfolios')
      .select('id, name')
      .eq('user_id', userId)
      .eq('is_simulation', true);

    if (!portfolios || portfolios.length === 0) {
      return { syncedPortfolios: 0, totalImported: 0 };
    }

    let totalImported = 0;
    let syncedPortfolios = 0;
    for (const p of portfolios) {
      try {
        const result = await this.syncForPortfolio(userId, p.id as string, p.name as string);
        if (result.imported > 0) {
          syncedPortfolios++;
          totalImported += result.imported;
        }
      } catch (e) {
        this.logger.warn(`syncForPortfolio failed for ${p.id}: ${String(e).slice(0, 100)}`);
      }
    }

    return { syncedPortfolios, totalImported };
  }

  /**
   * Sync les trades fermés Lisa d'un portfolio spécifique vers son bot
   * "Lisa Live".
   */
  async syncForPortfolio(
    userId: string,
    portfolioId: string,
    portfolioName?: string,
  ): Promise<{ imported: number; skipped: number; botId: string }> {
    // 1. Trouve ou crée le bot "Lisa Live" pour ce portfolio
    const bot = await this.findOrCreateBot(userId, portfolioId, portfolioName);

    // 2. Récupère les trades fermés Lisa qui n'ont pas encore été importés.
    //    Limite à 500 par batch pour éviter requêtes lourdes.
    const { data: lisaTrades } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, direction, entry_price, quantity, entry_notional_usd, entry_timestamp, exit_price, exit_timestamp, exit_reason, status, realized_pnl_usd, realized_pnl_pct')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .not('exit_timestamp', 'is', null)
      .order('exit_timestamp', { ascending: false })
      .limit(500);

    if (!lisaTrades || lisaTrades.length === 0) {
      return { imported: 0, skipped: 0, botId: bot.id };
    }

    // 3. Charge les detected_inputs des proposals pour récupérer VIX/regime
    //    au moment de l'entry. Optionnel — best-effort.
    const proposalContextMap = await this.loadProposalContexts(portfolioId);

    // 4. Transforme en format RawTradeImport
    const rawTrades: RawTradeImport[] = lisaTrades.map((t) => {
      const positionId = t.id as string;
      const ctx = proposalContextMap.get(positionId);

      const raw: RawTradeImport = {
        external_id: positionId, // garantit idempotence par lisa_position.id
        symbol: t.symbol as string,
        asset_class: t.asset_class as string,
        direction: t.direction as TradeDirection,
        entry_timestamp: t.entry_timestamp as string,
        entry_price: parseFloat(String(t.entry_price)),
        quantity: parseFloat(String(t.quantity)),
        entry_notional_usd: parseFloat(String(t.entry_notional_usd ?? 0)),
        exit_timestamp: t.exit_timestamp as string,
        exit_price: parseFloat(String(t.exit_price)),
        exit_reason: t.exit_reason as string ?? (t.status as string),
        net_pnl_usd: parseFloat(String(t.realized_pnl_usd ?? 0)),
      };

      // Enrichissement contextuel (VIX, regime) si dispo
      if (ctx) {
        if (ctx.vix != null) raw.vix_at_entry = ctx.vix;
        if (ctx.regime) raw.regime = ctx.regime;
      }

      return raw;
    });

    // 5. Insert via JournalNormalizer (idempotent)
    const result = await this.normalizer.normalizeAndInsert(bot.id, rawTrades);

    // 6. Si nouveaux trades, recalcule métriques (auto-recompute)
    if (result.inserted > 0) {
      try {
        await this.regimeTagger.tagBotTrades(bot.id);
        await this.equityCurve.refreshDaily(bot.id, parseFloat(bot.capitalBaseUsd));
        await this.comparator.refreshSessionMetrics(bot.id);
        await this.connector.updateBotStats(bot.id);
      } catch (e) {
        this.logger.warn(`Auto-recompute failed for bot ${bot.id.slice(0, 8)}: ${String(e).slice(0, 100)}`);
      }
    }

    this.logger.log(
      `[LISA_REPLAY] portfolio=${portfolioId.slice(0, 8)} bot=${bot.id.slice(0, 8)} ${result.inserted} new trades imported (${result.skipped} skipped)`,
    );

    return {
      imported: result.inserted,
      skipped: result.skipped,
      botId: bot.id,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────

  /**
   * Trouve le bot "Lisa Live" associé à un portfolio, ou le crée s'il
   * n'existe pas. 1 seul bot par (user, portfolio).
   */
  private async findOrCreateBot(
    userId: string,
    portfolioId: string,
    portfolioName?: string,
  ): Promise<BotDefinition> {
    // Cherche un bot existant : source_type=lisa_replay + source_metadata.portfolioId match
    const { data: existing } = await this.supabase.getClient()
      .from('bot_definitions')
      .select('*')
      .eq('user_id', userId)
      .eq('source_type', 'lisa_replay')
      .filter('source_metadata->>portfolioId', 'eq', portfolioId)
      .maybeSingle();

    if (existing) {
      return this.mapRow(existing);
    }

    // Lookup capital de référence du portfolio
    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('capital_usd')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    const capitalBase = cfg?.capital_usd
      ? parseFloat(String(cfg.capital_usd))
      : 10000;

    const name = portfolioName
      ? `${LisaReplayConnectorService.LISA_BOT_NAME_PREFIX} — ${portfolioName}`
      : `${LisaReplayConnectorService.LISA_BOT_NAME_PREFIX} — ${portfolioId.slice(0, 8)}`;

    const bot = await this.connector.createBot(userId, {
      name,
      description: 'Auto-sync des trades fermés Lisa pour analyse Bot Lab. Mis à jour automatiquement par le cron lisa-replay-sync.',
      sourceType: 'lisa_replay',
      sourceMetadata: {
        portfolioId,
        autoSync: true,
        firstSyncedAt: new Date().toISOString(),
      },
      capitalBaseUsd: capitalBase,
      tags: [LisaReplayConnectorService.LISA_BOT_TAG, 'lisa', 'auto'],
    });

    this.logger.log(`[LISA_REPLAY] Auto-created bot ${name} for portfolio ${portfolioId.slice(0, 8)}`);
    return bot;
  }

  /**
   * Charge le contexte (VIX, regime) au moment de chaque trade depuis
   * lisa_proposals.detected_inputs. Mappe par position_id.
   *
   * Best-effort : si la position n'a pas de proposal_id (legacy) ou pas
   * de detected_inputs, retourne map vide pour cette position.
   */
  private async loadProposalContexts(portfolioId: string): Promise<Map<string, { vix?: number; regime?: string }>> {
    const map = new Map<string, { vix?: number; regime?: string }>();

    // 1. Récupère les proposal_id des positions fermées + leur position id
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, proposal_id')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .not('proposal_id', 'is', null);

    if (!positions || positions.length === 0) return map;

    // 2. Charge les proposals correspondantes
    const proposalIds = Array.from(new Set(positions.map((p) => p.proposal_id as string).filter(Boolean)));
    if (proposalIds.length === 0) return map;

    const { data: proposals } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('id, detected_regime, detected_inputs')
      .in('id', proposalIds);

    if (!proposals) return map;

    const proposalCtxMap = new Map<string, { vix?: number; regime?: string }>();
    for (const p of proposals) {
      const ctx: { vix?: number; regime?: string } = {};
      const detectedRegime = p.detected_regime as string | null;
      if (detectedRegime) ctx.regime = detectedRegime;

      const detectedInputs = p.detected_inputs as Record<string, unknown> | null;
      if (detectedInputs?.vix != null) ctx.vix = Number(detectedInputs.vix);

      proposalCtxMap.set(p.id as string, ctx);
    }

    // 3. Map position_id → ctx via proposal_id
    for (const pos of positions) {
      const proposalId = pos.proposal_id as string | null;
      if (proposalId && proposalCtxMap.has(proposalId)) {
        map.set(pos.id as string, proposalCtxMap.get(proposalId)!);
      }
    }

    return map;
  }

  private mapRow(row: Record<string, unknown>): BotDefinition {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      portfolioId: (row.portfolio_id as string | null) ?? null,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      sourceType: row.source_type as 'lisa_replay',
      sourceMetadata: (row.source_metadata as Record<string, unknown> | null) ?? null,
      capitalBaseUsd: String(row.capital_base_usd),
      startDate: (row.start_date as string | null) ?? null,
      endDate: (row.end_date as string | null) ?? null,
      isActive: (row.is_active as boolean) ?? true,
      tags: (row.tags as string[]) ?? [],
      totalTrades: Number(row.total_trades ?? 0),
      totalRealizedPnlUsd: String(row.total_realized_pnl_usd ?? '0'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
