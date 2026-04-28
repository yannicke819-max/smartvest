import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { LisaService } from './services/lisa.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { OptionBrokerService } from './services/option-broker.service';
import { NewsRankerService } from './services/news-ranker.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { SupabaseService } from '../supabase/supabase.service';
import { DailySessionService } from './services/daily-session.service';
import { ProfitSweepService } from './services/profit-sweep.service';
import { MacroModeService, type MacroMode } from './services/macro-mode.service';
import {
  OperatingModeService,
  OPERATING_MODES,
  type OperatingMode,
} from './services/operating-mode.service';
import { TopGainersScannerService } from './services/top-gainers-scanner.service';
import { MultiTimeframePersistenceService } from './services/multi-tf-persistence.service';
import { summarizeByTf, type PersistenceResult } from '@smartvest/ai-analyst';
import type { DailyHarvestConfig, CapitalDisciplineMode } from './types/capital-discipline.types';

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
    private readonly dailySession: DailySessionService,
    private readonly profitSweep: ProfitSweepService,
    private readonly macroMode: MacroModeService,
    private readonly operatingMode: OperatingModeService,
    private readonly topGainersScanner: TopGainersScannerService,
    private readonly mtfPersistence: MultiTimeframePersistenceService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // MACRO MODE — INVESTMENT vs HARVEST
  // ─────────────────────────────────────────────────────────────────

  /**
   * Détecte le mode macro courant + retourne la config active.
   */
  @Get('macro-mode/:portfolioId')
  async detectMacroMode(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    const mode = await this.macroMode.detectMode(portfolioId);
    return { mode };
  }

  /**
   * Applique un preset macro mode sur la config du portfolio.
   * Body : { mode: 'INVESTMENT' | 'HARVEST' }
   */
  @Post('macro-mode/:portfolioId')
  async applyMacroMode(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { mode: MacroMode },
  ) {
    const userId = extractUserId(headers);
    if (body.mode !== 'INVESTMENT' && body.mode !== 'HARVEST') {
      throw new Error('mode doit être INVESTMENT ou HARVEST');
    }
    const result = await this.macroMode.applyMacroMode(userId, portfolioId, body.mode);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // P7-MODE-GAINERS-BADGE — toggle 3-modes opératoires (UI badge)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Lit le mode opératoire courant depuis lisa_session_configs.strategy_mode.
   * Source de vérité du badge UI (investment / harvest / gainers).
   */
  @Get('mode/:portfolioId')
  async getOperatingMode(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    const mode = await this.operatingMode.getMode(portfolioId);
    return { mode };
  }

  /**
   * Bascule le mode opératoire. Body : `{ mode: 'investment'|'harvest'|'gainers' }`.
   *
   * Side-effects :
   *  - investment / harvest : applique le preset MacroMode complet
   *  - gainers              : autopilot_enabled forcé, kill-switch désarmé
   *
   * Garde-fou : gainers exige capital ≥ $1000.
   * Audit : ligne mode_change_log écrite (best effort).
   */
  @Post('mode/:portfolioId')
  @HttpCode(200)
  async setOperatingMode(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { mode?: unknown; reason?: unknown },
  ) {
    const userId = extractUserId(headers);
    const mode = body?.mode;
    if (typeof mode !== 'string' || !OPERATING_MODES.includes(mode as OperatingMode)) {
      throw new BadRequestException(
        `mode invalide : attendu un de ${OPERATING_MODES.join('|')}`,
      );
    }
    const userAgent = headers['user-agent'] ?? headers['User-Agent'];
    const reason = typeof body?.reason === 'string' ? (body.reason as string) : undefined;
    return this.operatingMode.applyMode(userId, portfolioId, mode as OperatingMode, {
      userAgent,
      reason,
    });
  }

  /**
   * Mini-tile temps réel pour le badge Gainers actif :
   *   - countdown vers prochain scan (basé sur SCAN_INTERVAL_MINUTES + lastTickAt)
   *   - positions ouvertes / max
   *   - PnL session UTC (réalisé + latent best-effort)
   *   - 3 derniers candidats vus au dernier tick
   *
   * Polling 30s côté UI.
   */
  @Get('gainers-status/:portfolioId')
  async getGainersStatus(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);

    const intervalMinutes = this.topGainersScanner.getScanIntervalMinutes();
    const lastTick = this.topGainersScanner.getLastTickAt();
    let nextTickInSeconds: number;
    if (lastTick) {
      const elapsedMs = Date.now() - lastTick.getTime();
      const periodMs = intervalMinutes * 60 * 1000;
      nextTickInSeconds = Math.max(0, Math.floor((periodMs - elapsedMs) / 1000));
    } else {
      // Le premier tick n'a pas tourné — countdown indicatif depuis maintenant.
      nextTickInSeconds = intervalMinutes * 60;
    }

    const supabase = this.supabase.getClient();

    const { count: openCount } = await supabase
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);

    const { data: closedToday } = await supabase
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'closed')
      .gte('exit_timestamp', startOfDayUtc.toISOString());

    const sessionPnlUsd = (closedToday ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.realized_pnl_usd ?? '0')) || 0),
      0,
    );

    // Derniers candidats : top 3 du dernier tick (decision passed/opened, ordre score desc).
    const { data: lastLog } = await supabase
      .from('top_gainers_log')
      .select('symbol, change_pct, score, decision, captured_at')
      .in('decision', ['passed', 'opened'])
      .order('captured_at', { ascending: false })
      .limit(20);

    let lastCandidates: Array<{ symbol: string; changePct: number; score: number }> = [];
    if (lastLog && lastLog.length > 0) {
      const latestCapturedAt = lastLog[0].captured_at;
      lastCandidates = lastLog
        .filter((r) => r.captured_at === latestCapturedAt)
        .slice(0, 3)
        .map((r) => ({
          symbol: String(r.symbol),
          changePct: parseFloat(String(r.change_pct ?? '0')) || 0,
          score: parseFloat(String(r.score ?? '0')) || 0,
        }));
    }

    return {
      nextTickInSeconds,
      intervalMinutes,
      openPositions: openCount ?? 0,
      maxPositions: 3,
      sessionPnlUsd,
      lastCandidates,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // P8-MULTI-TIMEFRAME-PERSISTENCE — snapshot endpoint
  // ─────────────────────────────────────────────────────────────────

  /**
   * Réponse littérale à la question utilisateur :
   * « 20 valeurs en hausse depuis 1min — combien sont aussi en hausse
   *   depuis 5/10/15/30/60 minutes ? »
   *
   * topN priorité query string > DB > env > default(20). Range [5, 100].
   * markets : CSV optionnel (crypto, us, eu, asia). Défaut = tous.
   *
   * Cache 30s côté MultiTimeframePersistenceService → safe à appeler depuis
   * un poll UI.
   */
  @Get('gainers-persistence-snapshot/:portfolioId')
  async getGainersPersistenceSnapshot(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('topN') topNRaw?: string,
    @Query('markets') marketsRaw?: string,
  ) {
    extractUserId(headers);

    const topN = await this.resolveTopN(portfolioId, topNRaw);
    const allowedMarkets = parseMarkets(marketsRaw);

    const allCandidates = await this.topGainersScanner.fetchAllCandidates();
    const filtered = allowedMarkets
      ? allCandidates.filter((c) => allowedMarkets.has(classifyMarket(c.exchange)))
      : allCandidates;

    // Top par changePct desc — la "hausse depuis 1min" est approximée par
    // le change_p journalier des sources (EODHD : 1d ; Binance : 24h).
    // Le signal multi-TF live couvre les TFs courts (1m/5m/...) en phase 2.
    const top = [...filtered]
      .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
      .slice(0, topN);

    const persistenceMap = await this.mtfPersistence.analyzeBatch(
      top.map((c) => ({
        symbol: c.symbol,
        exchange: c.exchange,
        currentPrice: c.close,
      })),
    );

    const results: PersistenceResult[] = [];
    const candidatesOut = top.map((c) => {
      const r = persistenceMap.get(c.symbol.toUpperCase());
      if (r) results.push(r);
      return {
        symbol: c.symbol,
        market: c.exchange ?? 'unknown',
        tf1m: r?.tf1m ?? null,
        tf5m: r?.tf5m ?? null,
        tf10m: r?.tf10m ?? null,
        tf15m: r?.tf15m ?? null,
        tf30m: r?.tf30m ?? null,
        tf1h: r?.tf1h ?? null,
        persistenceScore: r ? (Number.isNaN(r.persistenceScore) ? null : r.persistenceScore) : null,
        persistenceCount: r?.persistenceCount ?? null,
      };
    });

    const summary = summarizeByTf(results);

    // Best-effort log dans gainers_persistence_log (audit historique 7j).
    void this.persistSnapshotLog(topN, allowedMarkets, candidatesOut, summary).catch(() => null);

    return {
      capturedAt: new Date().toISOString(),
      topN,
      marketsScanned: allowedMarkets ? Array.from(allowedMarkets) : ['all'],
      candidates: candidatesOut,
      summary,
    };
  }

  private async resolveTopN(portfolioId: string, raw: string | undefined): Promise<number> {
    // 1. Query string
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 5 && n <= 100) return n;
      throw new BadRequestException(`topN doit être entre 5 et 100 (reçu: ${raw})`);
    }
    // 2. DB
    const { data } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('gainers_persistence_top_n')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    if (data?.gainers_persistence_top_n != null) {
      const n = Number(data.gainers_persistence_top_n);
      if (Number.isFinite(n) && n >= 5 && n <= 100) return n;
    }
    // 3. Env
    const envRaw = process.env.GAINERS_PERSISTENCE_TOP_N;
    if (envRaw) {
      const n = parseInt(envRaw, 10);
      if (Number.isFinite(n) && n >= 5 && n <= 100) return n;
    }
    // 4. Default
    return 20;
  }

  private async persistSnapshotLog(
    topN: number,
    markets: Set<string> | null,
    candidates: unknown[],
    summary: Record<string, number>,
  ): Promise<void> {
    await this.supabase.getClient().from('gainers_persistence_log').insert({
      top_n: topN,
      markets_scanned: markets ? Array.from(markets) : ['all'],
      snapshot_json: { candidates },
      summary,
    });
  }

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

  // ─────────────────────────────────────────────────────────────────
  // DAILY_HARVEST endpoints (Phase 4)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Récupère l'état complet du mode DAILY_HARVEST pour un portfolio :
   *  - mode courant (NONE / DAILY_HARVEST)
   *  - config si active
   *  - session du jour (créée si absente)
   *  - vault (secured profit balance)
   *  - progress calculé
   *
   * Retourne mode='NONE' + autres champs null si le portfolio n'est pas en DAILY_HARVEST.
   */
  @Get('daily-harvest/:portfolioId')
  async getDailyHarvest(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers); // validation auth

    const { data: cfgRow } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('capital_discipline_mode, daily_harvest_config')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    const mode = (cfgRow?.capital_discipline_mode as CapitalDisciplineMode | undefined) ?? 'NONE';
    const config = cfgRow?.daily_harvest_config as DailyHarvestConfig | null;

    if (mode !== 'DAILY_HARVEST' || !config) {
      return { mode: 'NONE' as const, config: null, session: null, vault: null, progress: null, cumulativeStats: null };
    }

    const session = await this.dailySession.createOrGetTodaySession(portfolioId, config);
    const vault = await this.dailySession.getSecuredBalance(portfolioId);
    const progress = this.dailySession.computeProgress(session, config);
    const cumulativeStats = await this.dailySession.getCumulativeStats(portfolioId, config.timezone);

    return { mode, config, session, vault, progress, cumulativeStats };
  }

  /**
   * Update la config DAILY_HARVEST.
   * Body : { mode: CapitalDisciplineMode, config?: DailyHarvestConfig }
   * - mode='NONE' désactive le mode (config nulle)
   * - mode='DAILY_HARVEST' active avec la config fournie
   */
  @Post('daily-harvest/:portfolioId/config')
  async updateDailyHarvestConfig(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { mode: CapitalDisciplineMode; config?: DailyHarvestConfig },
  ) {
    extractUserId(headers);

    const update: Record<string, unknown> = {
      capital_discipline_mode: body.mode,
      updated_at: new Date().toISOString(),
    };
    if (body.mode === 'DAILY_HARVEST' && body.config) {
      update.daily_harvest_config = body.config;
    } else if (body.mode === 'NONE') {
      update.daily_harvest_config = null;
    }

    const { error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update(update)
      .eq('portfolio_id', portfolioId);

    if (error) throw new Error(`Update failed: ${error.message}`);
    return { ok: true, mode: body.mode };
  }

  /**
   * Sweep manuel — déclenche un transfert vers le vault à la demande user.
   * Body : { amountUsd: number, reason: string }
   */
  @Post('daily-harvest/:portfolioId/manual-sweep')
  @HttpCode(200)
  async manualSweep(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { amountUsd: number; reason?: string },
  ) {
    extractUserId(headers);

    const { data: cfgRow } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('capital_discipline_mode, daily_harvest_config')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (cfgRow?.capital_discipline_mode !== 'DAILY_HARVEST') {
      throw new Error('Mode DAILY_HARVEST non actif');
    }
    const config = cfgRow.daily_harvest_config as DailyHarvestConfig;
    const session = await this.dailySession.createOrGetTodaySession(portfolioId, config);

    const result = await this.profitSweep.sweepManual(
      session,
      body.amountUsd,
      body.reason ?? 'Sweep manuel via UI',
    );
    return result;
  }

  /**
   * Liste l'historique des sessions journalières (pour graphique long-terme).
   */
  @Get('daily-harvest/:portfolioId/history')
  async getDailyHarvestHistory(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limit?: string,
  ) {
    extractUserId(headers);
    const sessions = await this.dailySession.listRecentSessions(
      portfolioId,
      limit ? Math.min(90, parseInt(limit, 10)) : 30,
    );
    return { sessions };
  }

  /**
   * P2-D — Telemetry P&L journalier vs objectif fixe $100/jour.
   *
   *   GET /lisa/daily-pnl/:portfolioId
   *
   * Retourne :
   *   { realized, latent, target: 100, achievementPct, drift }
   *
   * realized       = closes UTC du jour depuis lisa_positions
   * latent         = unrealizedPnlUsd live snapshot
   * achievementPct = (realized + latent) / target × 100, clamp [0, 999]
   * drift          = realized + latent - target (peut être négatif)
   */
  @Get('daily-pnl/:portfolioId')
  async getDailyPnl(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    const userId = extractUserId(headers);
    return this.lisa.getDailyPnl(userId, portfolioId);
  }
}

// ─────────────────────────────────────────────────────────────────
// P8 — Helpers locaux pour le snapshot endpoint (markets filter)
// ─────────────────────────────────────────────────────────────────

const MARKET_GROUPS: Record<string, string> = {
  US: 'us',
  NYSE: 'us',
  NASDAQ: 'us',
  AMEX: 'us',
  TO: 'us',
  LSE: 'eu',
  XETRA: 'eu',
  PA: 'eu',
  SW: 'eu',
  MI: 'eu',
  MC: 'eu',
  BME: 'eu',
  AS: 'eu',
  AMS: 'eu',
  TSE: 'asia',
  HK: 'asia',
  AU: 'asia',
  KO: 'asia',
  NSE: 'asia',
  BSE: 'asia',
  BINANCE: 'crypto',
};

function classifyMarket(exchange: string | undefined | null): string {
  if (!exchange) return 'unknown';
  return MARKET_GROUPS[exchange.toUpperCase()] ?? 'unknown';
}

function parseMarkets(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const allowed = new Set(['crypto', 'us', 'eu', 'asia']);
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s));
  if (list.length === 0) return null;
  return new Set(list);
}
