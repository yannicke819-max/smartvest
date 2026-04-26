import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { LisaService } from './services/lisa.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { OptionBrokerService } from './services/option-broker.service';
import { NewsRankerService } from './services/news-ranker.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('lisa')
export class LisaController {
  constructor(
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly realtimePrice: RealtimePriceService,
    private readonly optionBroker: OptionBrokerService,
    private readonly newsRanker: NewsRankerService,
    private readonly enrichment: EodhdEnrichmentService,
    private readonly newsAggregator: NewsAggregatorService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * Inspecte le pipeline news pour un portfolio donné : fetch raw EODHD,
   * applique le ranker (relevance/impact/freshness/source/dedup), retourne
   * les buckets avec scoring détaillé. Sert à valider que Lisa reçoit bien
   * les news triées et à diagnostiquer les faux positifs.
   *
   *   GET /lisa/news-analysis/:portfolioId
   */
  @Get('news-analysis/:portfolioId')
  async getNewsAnalysis(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers); // auth check
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const heldSymbols = (positions ?? []).map((p) => p.symbol as string);

    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('profile')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const profile = (cfg?.profile as string) ?? 'long_term_investor';
    const halfLife = profile === 'hyper_active' ? 3
      : profile === 'active_trading' || profile === 'sniper_mode' ? 6
      : 12;

    const aggregate = await this.newsAggregator.aggregate(heldSymbols, 30);
    const ranked = this.newsRanker.rank(aggregate.items, heldSymbols, halfLife, 20);
    const buckets = this.newsRanker.bucket(ranked);

    return {
      portfolioId,
      profile,
      halfLifeHours: halfLife,
      heldSymbols,
      providersStatus: this.newsAggregator.status(),
      sourcesFetched: aggregate.sources,
      elapsedMs: aggregate.elapsedMs,
      counts: {
        rawFetched: aggregate.items.length,
        ranked: ranked.length,
        relevant: buckets.relevant.length,
        noise: buckets.noise.length,
        discarded: buckets.discarded.length,
      },
      relevant: buckets.relevant,
      noise: buckets.noise,
      discarded: buckets.discarded,
      briefingPreview: this.newsRanker.formatForBriefing(buckets),
    };
  }

  @Get('realtime/price-cache')
  getPriceCache() {
    return {
      wsConnected: this.realtimePrice.isConnected(),
      activeCryptoCount: this.realtimePrice.getActiveCryptoCount(),
      prices: this.realtimePrice.snapshot(),
      quota: this.realtimePrice.getQuotaStatus(),
    };
  }

  @Get('binance/balance')
  getBinanceBalance(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // throws si non authentifié
    return this.lisa.fetchBinanceBalance();
  }

  @Get('eodhd/stats')
  getEodhdStats(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.lisa.fetchEodhdStats();
  }

  @Get('claude/stats')
  getClaudeStats(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.lisa.fetchClaudeStats();
  }

  @Get('audit/verify/:portfolioId')
  async verifyAuditChain(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    // Note: ideally we'd check ownership here too, but DecisionLogService
    // only queries, so rely on RLS + service role filter implicitly.
    extractUserId(headers); // throws if not authenticated
    return this.decisionLog.verifyChain(portfolioId);
  }

  /**
   * Répare la chaîne de hash en utilisant la canonisation Node.js
   * (canonicalJson + canonicalTimestamp). À appeler quand le badge UI
   * indique "Hash chain corrompue" pour rétablir l'intégrité.
   *
   *   POST /lisa/audit/repair-chain/:portfolioId
   */
  @Post('audit/repair-chain/:portfolioId')
  async repairAuditChain(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    const repairResult = await this.decisionLog.repairChainCanonical(portfolioId);
    const verifyResult = await this.decisionLog.verifyChain(portfolioId);
    return {
      ...repairResult,
      verifiedAfterRepair: verifyResult,
    };
  }

  // ── Session config ──────────────────────────────────────────────────────────

  @Get('config/:portfolioId')
  getConfig(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getSessionConfig(extractUserId(headers), portfolioId);
  }

  @Post('config/:portfolioId')
  upsertConfig(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.lisa.upsertSessionConfig(extractUserId(headers), portfolioId, body as never);
  }

  // ── Proposal generation + approval ─────────────────────────────────────────

  @Post('proposals/:portfolioId/generate')
  @HttpCode(200)
  generateProposal(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('userFocus') userFocus?: string,
  ) {
    return this.lisa.generateProposal(extractUserId(headers), portfolioId, userFocus);
  }

  @Get('proposals/:portfolioId')
  listProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limit?: string,
  ) {
    return this.lisa.listProposals(extractUserId(headers), portfolioId, limit ? parseInt(limit, 10) : 20);
  }

  @Post('proposals/:proposalId/approve')
  @HttpCode(200)
  approveProposal(
    @Headers() headers: Record<string, string>,
    @Param('proposalId') proposalId: string,
  ) {
    return this.lisa.approveProposal(extractUserId(headers), proposalId);
  }

  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  rejectProposal(
    @Headers() headers: Record<string, string>,
    @Param('proposalId') proposalId: string,
    @Body('reason') reason: string,
  ) {
    return this.lisa.rejectProposal(extractUserId(headers), proposalId, reason ?? 'no reason provided');
  }

  // ── Positions + portfolio state ─────────────────────────────────────────────

  @Get('positions/:portfolioId')
  listPositions(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('openOnly') openOnly?: string,
  ) {
    return this.lisa.listPositions(extractUserId(headers), portfolioId, openOnly === 'true');
  }

  @Get('snapshot/:portfolioId')
  getCurrentSnapshot(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getCurrentSnapshot(extractUserId(headers), portfolioId);
  }

  @Get('snapshots/:portfolioId')
  getSnapshotHistory(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('window') window?: string,
  ) {
    const windowDays = window ? parseInt(window, 10) : 30;
    return this.lisa.getSnapshotHistory(extractUserId(headers), portfolioId, windowDays);
  }

  /**
   * Force la persistance d'un snapshot live immédiatement, sans attendre le
   * cron 5min. Utile pour debug ou pour rafraîchir le graphique à la demande.
   *
   *   POST /lisa/portfolio/:portfolioId/snapshot-now
   */
  @Post('portfolio/:portfolioId/snapshot-now')
  async forceSnapshot(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    await this.lisa.persistLivePortfolioSnapshot(portfolioId);
    return { ok: true, snapshotPersisted: true, at: new Date().toISOString() };
  }

  // ── Agent mécanique — statut temps réel ─────────────────────────────────────

  @Get('agent/:portfolioId')
  getAgentStatus(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getAgentStatus(extractUserId(headers), portfolioId);
  }

  // ── Decision log ────────────────────────────────────────────────────────────

  @Get('decisions/:portfolioId')
  getDecisionLog(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limit?: string,
  ) {
    return this.lisa.getDecisionLog(extractUserId(headers), portfolioId, limit ? parseInt(limit, 10) : 50);
  }

  // ── Risk monitoring + kill-switch ───────────────────────────────────────────

  @Post('risk-check/:portfolioId')
  @HttpCode(200)
  runRiskCheck(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.runRiskCheck(extractUserId(headers), portfolioId);
  }

  @Post('kill-switch/:portfolioId')
  @HttpCode(200)
  triggerKillSwitch(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('reason') reason: string,
  ) {
    return this.lisa.triggerKillSwitch(extractUserId(headers), portfolioId, reason ?? 'Manual user kill');
  }

  @Post('portfolio/:portfolioId/reset-simulation')
  @HttpCode(200)
  resetSimulation(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.resetSimulation(extractUserId(headers), portfolioId);
  }

  @Post('portfolio/:portfolioId/proposals/purge')
  @HttpCode(200)
  purgeOldProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body('olderThanHours') olderThanHours?: number,
  ) {
    return this.lisa.purgeOldProposals(
      extractUserId(headers),
      portfolioId,
      typeof olderThanHours === 'number' ? olderThanHours : 24,
    );
  }

  @Get('options/:portfolioId')
  async listOpenOptions(@Param('portfolioId') portfolioId: string) {
    const opens = await this.optionBroker.getOpenOptions(portfolioId);
    // Mark live pour chaque position
    return Promise.all(
      opens.map(async (o) => {
        const quote = await this.lisa.getLivePrice(o.underlying).catch(() => null);
        const spot = quote ? Number(quote.price) : Number(o.entry_underlying_price);
        const m = this.optionBroker.markOption(o, spot);
        return {
          id: o.id,
          underlying: o.underlying,
          asset_class: o.asset_class,
          kind: o.kind,
          strike: Number(o.strike),
          expiry: o.expiry,
          contracts: Number(o.contracts),
          premium_paid_usd: Number(o.premium_paid_usd),
          entry_underlying_price: Number(o.entry_underlying_price),
          entry_iv: Number(o.entry_iv),
          conviction_score: o.conviction_score != null ? Number(o.conviction_score) : null,
          current_underlying: spot,
          current_value_usd: m.value,
          pnl_usd: m.pnlUsd,
          pnl_pct: m.pnlPct,
          delta: m.delta,
        };
      }),
    );
  }
}
