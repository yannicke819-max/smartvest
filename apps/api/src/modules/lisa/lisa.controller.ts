import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { LisaService } from './services/lisa.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { OptionBrokerService } from './services/option-broker.service';
import { NewsRankerService } from './services/news-ranker.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { SupabaseService } from '../supabase/supabase.service';
// PR #338 — UI Phase 5 N1+N2 (matrice TP/SL, QW activity, risk state)
import { AssetClassTpslService } from './services/asset-class-tpsl.service';
import { QuickWinsStatsService } from './services/quick-wins-stats.service';
import { RiskStateService } from './services/risk-state.service';
import { DailyCatalystBriefService } from './services/daily-catalyst-brief.service';
import { EventEngineService } from './services/event-engine.service';
import { DailySessionService } from './services/daily-session.service';
import { ProfitSweepService } from './services/profit-sweep.service';
import { MacroModeService, type MacroMode } from './services/macro-mode.service';
import {
  OperatingModeService,
  OPERATING_MODES,
  type OperatingMode,
} from './services/operating-mode.service';
import { TopGainersScannerService } from './services/top-gainers-scanner.service';
import { TradingStatsService } from './services/trading-stats.service';
import { GainersUserShadowService } from './services/gainers-user-shadow.service';
import { GainersAutoRelaxService } from './services/gainers-auto-relax.service';
import { PostSlBackfillService } from './services/post-sl-backfill.service';
import { MultiTimeframePersistenceService } from './services/multi-tf-persistence.service';
import { PersistenceProbabilityService } from './services/persistence-probability.service';
import { EodhdQuotaService } from './services/eodhd-quota.service';
import { PushNotificationsService, type PushSubscriptionPayload } from './services/push-notifications.service';
import { GeminiBudgetGuardService } from './services/gemini-budget-guard.service';
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
    private readonly persistenceProbability: PersistenceProbabilityService,
    private readonly quotaService: EodhdQuotaService,
    private readonly tradingStats: TradingStatsService,
    private readonly gainersUserShadow: GainersUserShadowService,
    private readonly gainersAutoRelax: GainersAutoRelaxService,
    private readonly postSlBackfill: PostSlBackfillService,
    private readonly assetClassTpsl: AssetClassTpslService,
    private readonly qwStats: QuickWinsStatsService,
    private readonly riskState: RiskStateService,
    private readonly dailyCatalystBrief: DailyCatalystBriefService,
    private readonly eventEngine: EventEngineService,
    private readonly pushNotifs: PushNotificationsService,
    private readonly geminiBudgetGuard: GeminiBudgetGuardService,
  ) {}

  // LISA refonte B.4.c — Web Push API VAPID endpoints.
  @Get('push/vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: this.pushNotifs.getPublicKey() };
  }

  @Post('push/subscribe')
  @HttpCode(200)
  pushSubscribe(
    @Headers() headers: Record<string, string>,
    @Body() body: PushSubscriptionPayload,
  ) {
    return this.pushNotifs.subscribe(extractUserId(headers), body);
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  pushUnsubscribe(
    @Headers() headers: Record<string, string>,
    @Body('endpoint') endpoint: string,
  ) {
    return this.pushNotifs.unsubscribe(extractUserId(headers), endpoint);
  }

  @Get('push/subscriptions')
  pushList(@Headers() headers: Record<string, string>) {
    return this.pushNotifs.listSubscriptions(extractUserId(headers));
  }

  // ─────────────────────────────────────────────────────────────────
  // PR #338 — UI Phase 5 N1+N2 endpoints
  // ─────────────────────────────────────────────────────────────────

  @Get('asset-class-tpsl')
  listAssetClassTpsl(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.assetClassTpsl.list();
  }

  @Patch('asset-class-tpsl/:assetClass')
  updateAssetClassTpsl(
    @Headers() headers: Record<string, string>,
    @Param('assetClass') assetClass: string,
    @Body() body: Record<string, unknown>,
  ) {
    extractUserId(headers);
    return this.assetClassTpsl.update(assetClass, body);
  }

  @Get('quick-wins/stats')
  qwStats24h(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.qwStats.stats24h();
  }

  @Get('quick-wins/recent')
  qwRecent(@Headers() headers: Record<string, string>, @Query('limit') limit?: string) {
    extractUserId(headers);
    const parsed = parseInt(limit ?? '50', 10);
    return this.qwStats.recent(Number.isFinite(parsed) ? parsed : 50);
  }

  /**
   * PR #524 — Compteur LLM temps réel pour /lisa UI panel.
   * Mêmes calculs que /admin/llm-cost-live mais user-auth scoped (pas d'admin token).
   * Aggrège gemini_ab_decisions (TRADER) ET llm_ab_shadow_decisions (4 autres sites)
   * → vue unifiée 4 providers × tous call sites.
   */
  @Get('llm-cost-live')
  async getLlmCostLive(
    @Headers() headers: Record<string, string>,
    @Query('hours') hours?: string,
  ): Promise<{
    since: string;
    until: string;
    total_cost_usd: number;
    total_cycles: number;
    providers: Record<string, { calls: number; cost_usd: number; avg_latency_ms: number | null }>;
    by_site: Array<{ call_site: string; cycles: number; cost_usd: number }>;
  }> {
    extractUserId(headers);

    const now = new Date();
    const since = hours
      ? new Date(now.getTime() - Math.min(168, Math.max(1, Number(hours))) * 3600_000)
      : new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');

    const stats: Record<string, { sum_cost: number; sum_lat: number; n_lat: number; n_calls: number }> = {
      'gemini-pro': { sum_cost: 0, sum_lat: 0, n_lat: 0, n_calls: 0 },
      'gemini-flash': { sum_cost: 0, sum_lat: 0, n_lat: 0, n_calls: 0 },
      'mistral-medium': { sum_cost: 0, sum_lat: 0, n_lat: 0, n_calls: 0 },
      'mistral-large': { sum_cost: 0, sum_lat: 0, n_lat: 0, n_calls: 0 },
    };
    const bySite = new Map<string, { cycles: number; cost: number }>();

    // 1. TRADER decisions (gemini_ab_decisions — colonnes typées)
    const { data: trader } = await this.supabase
      .getClient()
      .from('gemini_ab_decisions')
      .select('pro_cost_usd,flash_cost_usd,mistral_cost_usd,mistral_large_cost_usd,pro_latency_ms,flash_latency_ms,mistral_latency_ms,mistral_large_latency_ms')
      .gte('decided_at', since.toISOString())
      .limit(50_000);
    const traderRows = (trader ?? []) as unknown as Array<Record<string, unknown>>;
    let traderTotalCost = 0;
    for (const r of traderRows) {
      const accum = (key: string, cost: number, lat: number | null) => {
        if (cost > 0 || (key === 'gemini-pro')) {
          stats[key].n_calls += 1;
          stats[key].sum_cost += cost;
          traderTotalCost += cost;
          if (lat !== null && lat > 0) { stats[key].sum_lat += lat; stats[key].n_lat += 1; }
        }
      };
      accum('gemini-pro', Number(r.pro_cost_usd ?? 0), r.pro_latency_ms != null ? Number(r.pro_latency_ms) : null);
      accum('gemini-flash', Number(r.flash_cost_usd ?? 0), r.flash_latency_ms != null ? Number(r.flash_latency_ms) : null);
      accum('mistral-medium', Number(r.mistral_cost_usd ?? 0), r.mistral_latency_ms != null ? Number(r.mistral_latency_ms) : null);
      accum('mistral-large', Number(r.mistral_large_cost_usd ?? 0), r.mistral_large_latency_ms != null ? Number(r.mistral_large_latency_ms) : null);
    }
    bySite.set('trader_decision', { cycles: traderRows.length, cost: traderTotalCost });

    // 2. Other 4 sites (llm_ab_shadow_decisions — JSONB shadows array)
    const { data: shadow } = await this.supabase
      .getClient()
      .from('llm_ab_shadow_decisions')
      .select('call_site,applied_provider,applied_cost_usd,applied_latency_ms,shadows')
      .gte('decided_at', since.toISOString())
      .limit(50_000);
    const shadowRows = (shadow ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of shadowRows) {
      const site = String(r.call_site);
      const cost = Number(r.applied_cost_usd ?? 0);
      const lat = r.applied_latency_ms != null ? Number(r.applied_latency_ms) : null;
      // Fix 03/06/2026 — la mapping précédente attribuait `mistral-medium` à
      // `gemini-flash` (le check `.includes('pro')` était faux pour Mistral,
      // tombait sur le fallback gemini-flash). Conséquence : 928 calls Mistral
      // Medium = $0.751 attribués à Gemini Flash, UI montre Mistral à $0.
      const ap = String(r.applied_provider ?? '');
      const provider = ap.startsWith('mistral-large') ? 'mistral-large'
        : ap.startsWith('mistral') ? 'mistral-medium'
        : ap.includes('pro') ? 'gemini-pro'
        : 'gemini-flash';
      stats[provider].n_calls += 1;
      stats[provider].sum_cost += cost;
      if (lat !== null && lat > 0) { stats[provider].sum_lat += lat; stats[provider].n_lat += 1; }

      // Shadows array
      let siteCost = cost;
      for (const s of (r.shadows as Array<Record<string, unknown>>) ?? []) {
        const sp = String(s.provider ?? '');
        const sCost = Number(s.cost_usd ?? 0);
        const sLat = s.latency_ms != null ? Number(s.latency_ms) : null;
        if (sp.includes('flash')) {
          stats['gemini-flash'].n_calls += 1;
          stats['gemini-flash'].sum_cost += sCost;
          if (sLat !== null && sLat > 0) { stats['gemini-flash'].sum_lat += sLat; stats['gemini-flash'].n_lat += 1; }
        } else if (sp.includes('pro')) {
          stats['gemini-pro'].n_calls += 1;
          stats['gemini-pro'].sum_cost += sCost;
          if (sLat !== null && sLat > 0) { stats['gemini-pro'].sum_lat += sLat; stats['gemini-pro'].n_lat += 1; }
        } else if (sp === 'mistral-medium' || sp.startsWith('mistral-medium')) {
          stats['mistral-medium'].n_calls += 1;
          stats['mistral-medium'].sum_cost += sCost;
          if (sLat !== null && sLat > 0) { stats['mistral-medium'].sum_lat += sLat; stats['mistral-medium'].n_lat += 1; }
        } else if (sp === 'mistral-large' || sp.startsWith('mistral-large')) {
          stats['mistral-large'].n_calls += 1;
          stats['mistral-large'].sum_cost += sCost;
          if (sLat !== null && sLat > 0) { stats['mistral-large'].sum_lat += sLat; stats['mistral-large'].n_lat += 1; }
        }
        siteCost += sCost;
      }
      const prev = bySite.get(site) ?? { cycles: 0, cost: 0 };
      bySite.set(site, { cycles: prev.cycles + 1, cost: prev.cost + siteCost });
    }

    const providers: Record<string, { calls: number; cost_usd: number; avg_latency_ms: number | null }> = {};
    let totalCost = 0;
    for (const [k, s] of Object.entries(stats)) {
      if (s.n_calls === 0) continue;
      providers[k] = {
        calls: s.n_calls,
        cost_usd: Math.round(s.sum_cost * 10000) / 10000,
        avg_latency_ms: s.n_lat > 0 ? Math.round(s.sum_lat / s.n_lat) : null,
      };
      totalCost += s.sum_cost;
    }

    return {
      since: since.toISOString(),
      until: now.toISOString(),
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      total_cycles: traderRows.length + shadowRows.length,
      providers,
      by_site: Array.from(bySite.entries()).map(([call_site, v]) => ({
        call_site,
        cycles: v.cycles,
        cost_usd: Math.round(v.cost * 10000) / 10000,
      })),
    };
  }

  @Get('risk-state/:portfolioId')
  getRiskState(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    return this.riskState.portfolioRiskState(portfolioId);
  }

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

    // P9-UX — Cycle per-portfolio depuis DB (cache 30s). Fallback global si
    // la colonne n'existe pas (migration 0089 pas encore appliquée).
    const intervalMinutes = await this.topGainersScanner.getCycleMinutes(portfolioId);
    const lastScanMs = this.topGainersScanner.getLastScanForPortfolio(portfolioId);
    const lastTick = lastScanMs ? new Date(lastScanMs) : this.topGainersScanner.getLastTickAt();
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

    // Read TP/SL and maxPositions from DB (single read, reused below).
    const { data: cfgRow } = await supabase
      .from('lisa_session_configs')
      .select('gainers_default_tp_pct, gainers_default_sl_pct, max_open_positions, gainers_adaptive_enabled, gainers_adaptive_active, gainers_trajectory_status, gainers_trajectory_status_at, gainers_realised_7d_pct, gainers_target_7d_pct')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const tpPct = cfgRow?.gainers_default_tp_pct != null
      ? Math.max(0.1, Math.min(50, Number(cfgRow.gainers_default_tp_pct)))
      : 1.5;
    const slPct = cfgRow?.gainers_default_sl_pct != null
      ? Math.max(0.1, Math.min(20, Number(cfgRow.gainers_default_sl_pct)))
      : 1.0;
    const rrRatio = parseFloat((tpPct / slPct).toFixed(2));
    const maxPositions: number = cfgRow?.max_open_positions ?? 3;

    const { count: openCount } = await supabase
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);

    const { data: sessionClosedRows } = await supabase
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'closed')
      .gte('exit_timestamp', startOfDayUtc.toISOString());

    const sessionPnlUsd = (sessionClosedRows ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.realized_pnl_usd ?? '0')) || 0),
      0,
    );

    // PR Counters jour (Option B) — compteurs scanner activité.
    // Cache implicite via le poll UI 30s (chaque GET hit fresh DB mais coût
    // marginal vs 30s de service vie — 7 queries au pire).
    //
    // Sources :
    //   - Scannés today : count gainers_v1_shadow_signals depuis 00:00 UTC
    //   - Ouverts today : count paper_trades strategy='top_gainers_v1' opened_at >= today
    //   - Fermés today  : count + sum pnl_usd où closed_at >= today
    //   - Breakdown asset class : GROUP BY asset_class
    //   - History 7j : GROUP BY date_trunc('day') pour sparkline scannés
    const startOfDayUtcIso = startOfDayUtc.toISOString();
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

    // Q1 — Scannés aujourd'hui : count EXACT (head:true) + breakdown sans cap.
    // Bug rapporté user 16:15 UTC : compteur figé à 1000 car Supabase limite
    // .select() à 1000 rows par défaut sans pagination. Avec 10k+ shadow
    // signals/jour, le breakdown était calculé sur les 1000 dernières seulement
    // → somme exacte 1000 (qui ressemblait à du hardcode).
    //
    // Fix :
    //   - Count exact via { count: 'exact', head: true } (pas de fetch rows)
    //   - Breakdown : 4 head-counts parallèles par bucket (us/eu/asia/crypto)
    //     pour bypass le hard cap PostgREST 1000 rows. "other" = total - somme.
    const { count: scannedTodayCount } = await supabase
      .from('gainers_v1_shadow_signals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startOfDayUtcIso);
    const scannedToday = scannedTodayCount ?? 0;

    // PR Breakdown fix v2 — 4 head-counts par bucket asset_class.
    // Hard cap PostgREST 1000 rows empêche le fetch+aggregate côté client
    // (.limit(50000) silencieusement clamp à 1000). Solution : count exact
    // par bucket via OR filter sur asset_class préfixé OR exchange fallback.
    const scannedByAssetClass = await this.countByBucket(
      supabase,
      'gainers_v1_shadow_signals',
      [['gte', 'created_at', startOfDayUtcIso]],
      scannedToday,
    );

    const { data: scanned7dRows } = await supabase
      .from('gainers_v1_shadow_signals')
      .select('created_at')
      .gte('created_at', sevenDaysAgoIso)
      .order('created_at', { ascending: true })
      .limit(100000);
    const scanned7d = bucketByDay(scanned7dRows ?? [], 7);

    // PR #252 — Q2/Q3 lisent désormais lisa_positions (source de vérité après PR #250).
    //
    // Pré-PR #250 : scanner Gainers passait par lisa_proposals/approveProposal/
    // paper_trades. Endpoint lisait paper_trades pour "Gains du jour".
    // Post-PR #250 : scanner ouvre directement dans lisa_positions, mais
    // mechanical-trading ferme aussi via lisa_positions sans toucher paper_trades.
    // Conséquence : compteur "Fermés" + "Gains du jour" stuck à 0 + $0.00
    // alors qu'une position fermée TP rapportait +$23.20.
    //
    // Fix : query lisa_positions directement, marqueur Gainers Direct =
    // proposal_id IS NULL (migration 0120 instaure cette convention).

    // Q2 — Ouverts aujourd'hui (lisa_positions, proposal_id NULL = scanner direct)
    const { count: openedTodayCount } = await supabase
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .gte('entry_timestamp', startOfDayUtcIso);
    const openedToday = openedTodayCount ?? 0;

    const openedByAssetClass = await this.countByBucket(
      supabase,
      'lisa_positions',
      [
        ['eq', 'portfolio_id', portfolioId],
        ['is', 'proposal_id', null],
        ['gte', 'entry_timestamp', startOfDayUtcIso],
      ],
      openedToday,
    );

    // Q3 — Fermés aujourd'hui (status closed + exit_timestamp >= today)
    const { count: closedTodayCountExact } = await supabase
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .neq('status', 'open')
      .gte('exit_timestamp', startOfDayUtcIso);
    const closedToday = closedTodayCountExact ?? 0;

    // PnL : somme realized_pnl_usd des positions fermées aujourd'hui
    const { data: closedTodayPositions } = await supabase
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .neq('status', 'open')
      .gte('exit_timestamp', startOfDayUtcIso)
      .limit(10000);
    const closedTodayPnlUsd = (closedTodayPositions ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.realized_pnl_usd ?? '0')) || 0),
      0,
    );

    const closedByAssetClass = await this.countByBucket(
      supabase,
      'lisa_positions',
      [
        ['eq', 'portfolio_id', portfolioId],
        ['is', 'proposal_id', null],
        ['neq', 'status', 'open'],
        ['gte', 'exit_timestamp', startOfDayUtcIso],
      ],
      closedToday,
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

    // PR #246 + PR #252 — MTD (Month-To-Date) gains pour la carte « Gains du mois ».
    // Source : lisa_positions fermées depuis le 1er du mois UTC (proposal_id NULL
    // = scanner Gainers Direct, post-PR #250).
    const startOfMonthUtc = new Date();
    startOfMonthUtc.setUTCDate(1);
    startOfMonthUtc.setUTCHours(0, 0, 0, 0);
    const startOfMonthIso = startOfMonthUtc.toISOString();

    const { count: closedMtdCount } = await supabase
      .from('lisa_positions')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .neq('status', 'open')
      .gte('exit_timestamp', startOfMonthIso);
    const closedMtd = closedMtdCount ?? 0;

    const { data: closedMtdRows } = await supabase
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp')
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .neq('status', 'open')
      .gte('exit_timestamp', startOfMonthIso)
      .limit(10000);
    const closedMtdPnlUsd = (closedMtdRows ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.realized_pnl_usd ?? '0')) || 0),
      0,
    );

    // Best/worst day du mois (agrégation client par jour UTC).
    const dailyPnlMap = new Map<string, number>();
    for (const r of closedMtdRows ?? []) {
      const day = String(r.exit_timestamp).slice(0, 10); // YYYY-MM-DD
      const pnl = parseFloat(String(r.realized_pnl_usd ?? '0')) || 0;
      dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + pnl);
    }
    let bestDay: { date: string; pnl: number } | null = null;
    let worstDay: { date: string; pnl: number } | null = null;
    let winningDays = 0;
    let losingDays = 0;
    for (const [date, pnl] of dailyPnlMap.entries()) {
      if (!bestDay || pnl > bestDay.pnl) bestDay = { date, pnl };
      if (!worstDay || pnl < worstDay.pnl) worstDay = { date, pnl };
      if (pnl > 0) winningDays++;
      else if (pnl < 0) losingDays++;
    }

    // PR #258 — YTD (Year-To-Date) gains pour carte « Gains annuels ».
    // Reset uniquement au 1er janvier UTC. Conserve les gains mensuels au-delà
    // de la fin de mois.
    const startOfYearUtc = new Date();
    startOfYearUtc.setUTCMonth(0, 1);
    startOfYearUtc.setUTCHours(0, 0, 0, 0);
    const startOfYearIso = startOfYearUtc.toISOString();

    const { data: closedYtdRows } = await supabase
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp')
      .eq('portfolio_id', portfolioId)
      .is('proposal_id', null)
      .neq('status', 'open')
      .gte('exit_timestamp', startOfYearIso)
      .limit(50000);
    const closedYtdPnlUsd = (closedYtdRows ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.realized_pnl_usd ?? '0')) || 0),
      0,
    );
    const closedYtdCount = (closedYtdRows ?? []).length;

    // Aggrège par mois pour stats YTD (best/worst month)
    const monthlyPnlMap = new Map<string, number>();
    for (const r of closedYtdRows ?? []) {
      const month = String(r.exit_timestamp).slice(0, 7); // YYYY-MM
      const pnl = parseFloat(String(r.realized_pnl_usd ?? '0')) || 0;
      monthlyPnlMap.set(month, (monthlyPnlMap.get(month) ?? 0) + pnl);
    }
    let bestMonth: { month: string; pnl: number } | null = null;
    let worstMonth: { month: string; pnl: number } | null = null;
    let winningMonths = 0;
    let losingMonths = 0;
    for (const [month, pnl] of monthlyPnlMap.entries()) {
      if (!bestMonth || pnl > bestMonth.pnl) bestMonth = { month, pnl };
      if (!worstMonth || pnl < worstMonth.pnl) worstMonth = { month, pnl };
      if (pnl > 0) winningMonths++;
      else if (pnl < 0) losingMonths++;
    }

    return {
      nextTickInSeconds,
      intervalMinutes,
      openPositions: openCount ?? 0,
      maxPositions,
      tpPct,
      slPct,
      rrRatio,
      sessionPnlUsd,
      lastCandidates,
      // PR Counters jour (Option B)
      scannedToday,
      openedToday,
      closedToday,
      closedTodayPnlUsd,
      scannedByAssetClass,
      openedByAssetClass,
      closedByAssetClass,
      scanned7d,
      // PR #243 Adaptive Selectivity — exposition status pour bandeau UI
      adaptiveEnabled: cfgRow?.gainers_adaptive_enabled === true,
      adaptiveActive: cfgRow?.gainers_adaptive_active === true,
      trajectoryStatus: (cfgRow?.gainers_trajectory_status as
        | 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE' | null) ?? null,
      trajectoryStatusAt: cfgRow?.gainers_trajectory_status_at ?? null,
      realised7dPct: cfgRow?.gainers_realised_7d_pct != null
        ? Number(cfgRow.gainers_realised_7d_pct) : null,
      target7dPct: cfgRow?.gainers_target_7d_pct != null
        ? Number(cfgRow.gainers_target_7d_pct) : null,
      // PR #246 — Cartes Gains du jour / Gains du mois (mode-agnostique).
      mtdPnlUsd: closedMtdPnlUsd,
      mtdTradesCount: closedMtd,
      mtdSessionsCount: dailyPnlMap.size,
      mtdWinningDays: winningDays,
      mtdLosingDays: losingDays,
      mtdBestDay: bestDay,
      mtdWorstDay: worstDay,
      // PR #258 — Carte Gains annuels (YTD).
      ytdPnlUsd: closedYtdPnlUsd,
      ytdTradesCount: closedYtdCount,
      ytdMonthsCount: monthlyPnlMap.size,
      ytdWinningMonths: winningMonths,
      ytdLosingMonths: losingMonths,
      ytdBestMonth: bestMonth,
      ytdWorstMonth: worstMonth,
    };
  }

  /**
   * PR #258 — EODHD quota status pour UI badge.
   * Retourne le quota courant + auto-throttle thresholds + ETA exhaustion.
   */
  @Get('eodhd-quota')
  async getEodhdQuota(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // auth check
    return this.quotaService.getStatus();
  }

  // ─────────────────────────────────────────────────────────────────
  // PR #268 — Trading analytics + scaling readiness
  // ─────────────────────────────────────────────────────────────────

  /**
   * Calcule 5 critères de scaling readiness sur N jours :
   *   1. profitable_ratio  ≥ 80%
   *   2. avg_daily_pnl     ≥ $50
   *   3. pnl_volatility    ≤ 1.0 (stddev/mean)
   *   4. worst_day         ≥ -$50
   *   5. win_rate_7day     ≥ 65%
   *
   * Verdict : READY / CAUTION / NOT_READY / INSUFFICIENT_DATA.
   * Cache 60s.
   */
  @Get('analytics/trading-stats/:portfolioId')
  async getTradingStats(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('days') daysRaw?: string,
  ) {
    extractUserId(headers);
    const days = daysRaw != null ? parseInt(daysRaw, 10) : 30;
    return this.tradingStats.getStats(portfolioId, Number.isFinite(days) ? days : 30);
  }

  // ─────────────────────────────────────────────────────────────────
  // PR #265 — Sauvegardes nommées de config gainers
  // ─────────────────────────────────────────────────────────────────

  /** Liste les presets sauvegardés pour un portfolio. */
  @Get('gainers-config-presets/:portfolioId')
  async listGainersConfigPresets(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    const userId = extractUserId(headers);
    const { data, error } = await this.supabase.getClient()
      .from('gainers_config_presets')
      .select('id, name, settings, created_at, updated_at')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('updated_at', { ascending: false });
    if (error) throw new BadRequestException(`List presets failed: ${error.message}`);
    return { presets: data ?? [] };
  }

  /** Sauvegarde la config gainers courante sous un nom (upsert si nom existe). */
  @Post('gainers-config-presets/:portfolioId')
  async saveGainersConfigPreset(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { name: string },
  ) {
    const userId = extractUserId(headers);
    const name = (body?.name ?? '').trim();
    if (!name || name.length > 60) {
      throw new BadRequestException('Preset name must be 1-60 chars');
    }
    // Snapshot des champs gainers_* depuis lisa_session_configs
    const { data: cfg, error: cfgErr } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('gainers_default_tp_pct, gainers_default_sl_pct, gainers_position_pct, gainers_max_open_positions, gainers_max_per_cycle, gainers_cash_reserve_pct, gainers_cooldown_minutes, gainers_min_persistence_score, gainers_min_path_efficiency, gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto, gainers_p_win_gate_enabled, gainers_min_p_win, gainers_cycle_minutes, gainers_adaptive_enabled, gainers_rotation_stagnant_min_age_min, gainers_rotation_min_path_efficiency, gainers_capital_rotation_enabled, gainers_high_grading_enabled, gainers_rotation_min_score, gainers_top_pool_size, gainers_post_sl_cooldown_min, gainers_asia_strictness_boost, gainers_session_filter_enabled, gainers_force_close_before_close_enabled, gainers_force_close_offset_min, gainers_smart_close_enabled, gainers_smart_close_window_min, gainers_smart_close_min_profit_pct, capital_usd')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    if (cfgErr || !cfg) {
      throw new BadRequestException(`Config snapshot failed: ${cfgErr?.message ?? 'no config'}`);
    }
    const { data, error } = await this.supabase.getClient()
      .from('gainers_config_presets')
      .upsert({
        user_id: userId,
        portfolio_id: portfolioId,
        name,
        settings: cfg,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'portfolio_id,name' })
      .select('id, name, settings, created_at, updated_at')
      .single();
    if (error) throw new BadRequestException(`Save preset failed: ${error.message}`);
    return { preset: data };
  }

  /** Charge un preset et applique sa config sur le portfolio. */
  @Post('gainers-config-presets/:portfolioId/load')
  async loadGainersConfigPreset(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { name: string },
  ) {
    const userId = extractUserId(headers);
    const name = (body?.name ?? '').trim();
    if (!name) throw new BadRequestException('Preset name required');
    const { data: preset, error: getErr } = await this.supabase.getClient()
      .from('gainers_config_presets')
      .select('settings')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .eq('name', name)
      .maybeSingle();
    if (getErr || !preset) {
      throw new BadRequestException(`Preset "${name}" not found`);
    }
    const { error: updErr } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update(preset.settings)
      .eq('portfolio_id', portfolioId);
    if (updErr) throw new BadRequestException(`Apply preset failed: ${updErr.message}`);
    return { ok: true, applied: preset.settings };
  }

  /** Supprime un preset par nom. */
  @Post('gainers-config-presets/:portfolioId/delete')
  async deleteGainersConfigPreset(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { name: string },
  ) {
    const userId = extractUserId(headers);
    const name = (body?.name ?? '').trim();
    if (!name) throw new BadRequestException('Preset name required');
    const { error } = await this.supabase.getClient()
      .from('gainers_config_presets')
      .delete()
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .eq('name', name);
    if (error) throw new BadRequestException(`Delete preset failed: ${error.message}`);
    return { ok: true };
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
  // PR #259 — Cache response-level snapshot 5 min pour réduire la conso EODHD.
  // L'UI poll toutes les 60s mais 95% des requêtes successives sont identiques
  // (mêmes top tickers). Cache la réponse complète plutôt que de re-fetcher
  // mtfPersistence à chaque poll. TTL 5 min aligné avec le cycle scanner DB.
  private snapshotCache = new Map<string, { response: unknown; asOf: number }>();
  private static readonly SNAPSHOT_CACHE_TTL_MS = 5 * 60_000;

  @Get('gainers-persistence-snapshot/:portfolioId')
  async getGainersPersistenceSnapshot(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('topN') topNRaw?: string,
    @Query('markets') marketsRaw?: string,
  ) {
    extractUserId(headers);

    // PR #259 — Cache lookup per-portfolio + topN + markets key
    const cacheKey = `${portfolioId}:${topNRaw ?? 'default'}:${marketsRaw ?? 'all'}`;
    const cached = this.snapshotCache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < LisaController.SNAPSHOT_CACHE_TTL_MS) {
      return cached.response;
    }

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
        // P9-UX ADDENDUM — path quality / smoothness par TF
        pathQuality: r && 'pathQuality' in r && r.pathQuality
          ? {
              overallEfficiency: r.pathQuality.overallEfficiency,
              overallSmoothness: r.pathQuality.overallSmoothness,
              tf5m: r.pathQuality.tf5m,
              tf10m: r.pathQuality.tf10m,
              tf15m: r.pathQuality.tf15m,
              tf30m: r.pathQuality.tf30m,
              tf1h: r.pathQuality.tf1h,
            }
          : null,
        // P19y (29/04/2026) — Coverage source pour badge UI :
        //   - 'eodhd_1m' : intraday 1m natif EODHD (best, populates tf1m)
        //   - 'eodhd'    : intraday 5m EODHD (5 TFs ok, tf1m=null par design)
        //   - 'eodhd_ticks' : aggregated from /api/ticks (US-only)
        //   - 'yahoo'    : Yahoo Finance fallback (5m series)
        //   - 'binance'  : Binance crypto klines
        //   - 'cache_stale' : last-known < 15min stale
        //   - 'none'     : aucune source dispo (UI badge "—" + tooltip)
        // Permet UI d'afficher market_closed / illiquid / unsupported au lieu
        // de juste "—" qui est ambigu.
        coverage: r && 'coverage' in r ? r.coverage ?? 'none' : 'none',
        cacheAgeMs: r && 'cacheAgeMs' in r ? r.cacheAgeMs ?? null : null,
      };
    });

    const summary = summarizeByTf(results);

    // Best-effort log dans gainers_persistence_log (audit historique 7j).
    void this.persistSnapshotLog(topN, allowedMarkets, candidatesOut, summary).catch(() => null);

    const response = {
      capturedAt: new Date().toISOString(),
      topN,
      marketsScanned: allowedMarkets ? Array.from(allowedMarkets) : ['all'],
      candidates: candidatesOut,
      summary,
    };
    // PR #259 — Cache response 5 min
    this.snapshotCache.set(cacheKey, { response, asOf: Date.now() });
    return response;
  }

  // ─────────────────────────────────────────────────────────────────
  // P9 — empirical law endpoint
  // ─────────────────────────────────────────────────────────────────

  /**
   * Loi empirique P(win) par bucket persistenceCount + courbe logistic fittée.
   *
   *   GET /lisa/persistence-empirical-law?lookback_days=30&min_sample=20
   *
   * Réponse :
   * ```json
   * {
   *   "trainedOn": 487,
   *   "empiricalLaw": [{ persistenceCount: "4/6", n: 89, pWinObserved: 0.61, ... }],
   *   "fittedCurve": "logistic",
   *   "coefficients": { intercept: -1.8, persistenceCount: 0.62, ... },
   *   "aucRoc": 0.71,
   *   "accuracy": 0.68,
   *   "modelVersion": "v1730000000",
   *   "fallback": false
   * }
   * ```
   *
   * `fallback=true` si aucun modèle entraîné OU sample_size < 30.
   * Le caller UI affiche alors un disclaimer "modèle en bootstrap, fallback
   * sur seuil P8 dur".
   */
  @Get('persistence-empirical-law')
  async getPersistenceEmpiricalLaw(
    @Headers() headers: Record<string, string>,
    @Query('lookback_days') lookbackRaw?: string,
    @Query('min_sample') minSampleRaw?: string,
  ) {
    extractUserId(headers);
    const lookbackDays = clampInt(lookbackRaw, 1, 365, 30);
    const minSample = clampInt(minSampleRaw, 1, 1000, 20);
    const result = await this.persistenceProbability.getEmpiricalLaw({
      lookbackDays,
      minSample,
    });
    return {
      ...result,
      fittedCurve: result.coefficients ? 'logistic' : null,
      lookbackDays,
      minSample,
    };
  }

  /**
   * Refit manuel du modèle (bouton UI "Refit maintenant"). Retourne le
   * statut + version + métriques. Cron Sunday automatique en plus.
   */
  @Post('persistence-empirical-law/refit')
  @HttpCode(200)
  async refitPersistenceModel(
    @Headers() headers: Record<string, string>,
    @Body() body: { lookback_days?: number; include_shadow?: boolean },
  ) {
    extractUserId(headers);
    const lookbackDays = clampInt(
      body?.lookback_days != null ? String(body.lookback_days) : undefined,
      1, 365, 30,
    );
    // PR #281 — opt-in shadow data merge. Default false pour back-compat
    // (les anciens callers ne reçoivent que les paper_trades).
    const includeShadow = body?.include_shadow === true;
    return this.persistenceProbability.trainAndPersist({ lookbackDays, includeShadow });
  }

  /**
   * PR #280 — Regret cost summary par gate × grille TP/SL.
   *
   * Aggrège les rows `gainers_user_shadow_signals` par decision (accept,
   * reject_path_eff, reject_persistence, reject_cooldown, ...) × grille
   * (baseline_30m, baseline_60m, alt15_30m, alt15_60m), calcule bootstrap
   * CI 95% sur sim_pnl_pct, et donne un verdict GATE_TOO_STRICT /
   * GATE_HEALTHY / INCONCLUSIVE / INSUFFICIENT_DATA (n < 100).
   *
   * cumulative_regret_usd : positif = on rate de l'argent en moyenne sur
   * ce gate ; négatif = le gate sauve de l'argent sur ces rejets.
   */
  @Get('gainers-shadow-regret/:portfolioId')
  async getGainersShadowRegret(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('days') daysRaw?: string,
  ) {
    extractUserId(headers);
    const days = Math.max(1, Math.min(30, Number(daysRaw) || 7));
    return this.gainersUserShadow.getRegretSummary(portfolioId, days);
  }

  /**
   * PR #282 — Liste les proposals adaptive auto-relax pending.
   * Mode propose : applied=false, le user clique pour appliquer.
   * Mode auto : applied=true (auto-cron), affichage audit-only.
   */
  @Get('gainers-adaptive-proposals/:portfolioId')
  async listGainersAdaptiveProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limitRaw?: string,
  ) {
    extractUserId(headers);
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    return this.gainersAutoRelax.listPendingProposals(portfolioId, limit);
  }

  /**
   * PR #282 — Applique manuellement une proposal pending (mode propose).
   * UPDATE config DB + flag applied=true. Audit dans applied_by.
   */
  @Post('gainers-adaptive-proposals/:proposalId/apply')
  @HttpCode(200)
  async applyGainersAdaptiveProposal(
    @Headers() headers: Record<string, string>,
    @Param('proposalId') proposalId: string,
  ) {
    const userId = extractUserId(headers);
    return this.gainersAutoRelax.applyProposal(proposalId, userId);
  }

  /**
   * PR #292 — Backfill post_sl_path JSONB sur une position closed_stop.
   * Refetch EODHD 1m candles 30min post-SL + 5m candles 75min prior pour ATR(14).
   * Calcule rebound metrics, drawdown_in_atr_units, recovery thresholds.
   * Utile pour analyser si les SL sont des wicks vs vrais mouvements.
   */
  @Post('positions/:positionId/backfill-post-sl-path')
  @HttpCode(200)
  async backfillPostSlPath(
    @Headers() headers: Record<string, string>,
    @Param('positionId') positionId: string,
    @Query('force') forceRaw?: string,
  ) {
    extractUserId(headers);
    const force = forceRaw === 'true';
    return this.postSlBackfill.backfillOne(positionId, force);
  }

  /**
   * PR #292 — Backfill batch (par défaut 10 closed_stop pending).
   * Body : { limit?: number, portfolioId?: string }
   */
  @Post('positions/backfill-post-sl-path-batch')
  @HttpCode(200)
  async backfillPostSlPathBatch(
    @Headers() headers: Record<string, string>,
    @Body() body: { limit?: number; portfolioId?: string },
  ) {
    extractUserId(headers);
    const limit = Math.max(1, Math.min(50, Number(body?.limit) || 10));
    const opts: { limit: number; portfolioId?: string } = { limit };
    if (body?.portfolioId) opts.portfolioId = body.portfolioId;
    return this.postSlBackfill.backfillBatch(opts);
  }

  /**
   * PR #6 — User-facing read endpoint pour le dashboard auto-learning.
   * Retourne les N dernières insights (drift, threshold_proposal, ml_refit, etc.)
   * sur la fenêtre glissante. Pas de filtre par portfolio (insights globaux).
   */
  @Get('gainers/insights-recent')
  async getGainersInsightsRecent(
    @Headers() headers: Record<string, string>,
    @Query('since_days') sinceDaysStr?: string,
    @Query('limit') limitStr?: string,
    @Query('type') type?: string,
  ) {
    extractUserId(headers);
    const sinceDays = clampInt(sinceDaysStr, 1, 90, 30);
    const limit = clampInt(limitStr, 1, 200, 50);
    const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();
    let query = this.supabase
      .getClient()
      .from('gainers_insights_log')
      .select('id, created_at, insight_type, source, severity, summary, payload, status')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (type) query = query.eq('insight_type', type);
    const { data, error } = await query;
    if (error) {
      return { count: 0, insights: [], error: error.message };
    }
    return { count: (data ?? []).length, insights: data ?? [] };
  }

  /**
   * PR #6 — Historique des ajustements AutoTuner pour un portfolio user.
   * Filtre obligatoire par portfolioId user-scoped.
   */
  @Get('gainers/auto-tuner-history/:portfolioId')
  async getAutoTunerHistory(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('limit') limitStr?: string,
  ) {
    const userId = extractUserId(headers);
    // Vérifier ownership
    const { data: portfolio, error: pErr } = await this.supabase.getClient()
      .from('portfolios')
      .select('id')
      .eq('id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (pErr || !portfolio) {
      return { count: 0, history: [] };
    }
    const limit = clampInt(limitStr, 1, 200, 50);
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_threshold_history')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('applied_at', { ascending: false })
      .limit(limit);
    return {
      count: (data ?? []).length,
      history: data ?? [],
      error: error?.message ?? null,
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

  /**
   * PR Breakdown fix v2 — count exact par bucket asset_class via head-only.
   * Bypass le hard cap PostgREST 1000 rows en faisant 4 queries head:true
   * en parallèle, une par bucket (us/eu/asia/crypto). "other" = total -
   * somme des 4 buckets.
   *
   * Filters communs (eq/gte/etc.) appliqués à chaque sous-query identiquement.
   * Format filters : Array<['eq'|'gte'|'lte', column, value]>.
   *
   * Performance : 4 queries en parallèle, head:true → pas de fetch rows.
   * Très rapide (chacune < 100ms). Total ~200-300ms vs single 5000ms+ avec
   * pagination 50k rows.
   */
  private async countByBucket(
    supabase: ReturnType<SupabaseService['getClient']>,
    table: 'gainers_v1_shadow_signals' | 'paper_trades' | 'lisa_positions',
    filters: Array<['eq' | 'gte' | 'lte' | 'neq' | 'is', string, string | null]>,
    totalCount: number,
  ): Promise<{ us: number; eu: number; asia: number; crypto: number; other: number }> {
    // PR #252 — `lisa_positions` utilise `venue` au lieu de `exchange`. On adapte
    // l'OR filter selon la table pour matcher le bon nom de colonne. Les valeurs
    // sont identiques (mêmes codes exchange/venue).
    const exchangeCol = table === 'lisa_positions' ? 'venue' : 'exchange';
    const usOr = `asset_class.like.us_equity%,${exchangeCol}.in.(US,NYSE,NASDAQ,BATS,OTCQB,OTCMKTS,OTC,NMFQS)`;
    const euOr = `asset_class.eq.eu_equity,${exchangeCol}.in.(LSE,XETRA,PA,AS,AMS,MC,BME,MI,SW,BR)`;
    const asiaOr = `asset_class.eq.asia_equity,${exchangeCol}.in.(KO,KQ,KS,KE,T,TSE,HK,NSE,BSE,SHG,SHE,SS,SZ,AU,AX,TO)`;
    const cryptoOr = `asset_class.like.crypto%,${exchangeCol}.in.(BINANCE,CC,COINBASE)`;

    // Build base head-count query with filters appliqués via reduce
    const buildQ = (orFilter: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let qb: any = supabase.from(table).select('*', { count: 'exact', head: true });
      for (const [op, col, val] of filters) {
        if (op === 'eq') qb = qb.eq(col, val);
        else if (op === 'gte') qb = qb.gte(col, val);
        else if (op === 'lte') qb = qb.lte(col, val);
        else if (op === 'neq') qb = qb.neq(col, val);
        else if (op === 'is') qb = qb.is(col, val); // val=null → IS NULL
      }
      return qb.or(orFilter);
    };

    const [us, eu, asia, crypto] = await Promise.all([
      buildQ(usOr),
      buildQ(euOr),
      buildQ(asiaOr),
      buildQ(cryptoOr),
    ]);

    const usCount = (us as { count: number | null }).count ?? 0;
    const euCount = (eu as { count: number | null }).count ?? 0;
    const asiaCount = (asia as { count: number | null }).count ?? 0;
    const cryptoCount = (crypto as { count: number | null }).count ?? 0;
    const other = Math.max(0, totalCount - usCount - euCount - asiaCount - cryptoCount);

    return { us: usCount, eu: euCount, asia: asiaCount, crypto: cryptoCount, other };
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

  /**
   * Diagnostic read-only : invoque getLivePrice et renvoie le prix + la SOURCE.
   * Sert à vérifier le routing provider d'un symbole (ex: confirmer qu'un ticker
   * coréen `005930.KO` renvoie `source=twelvedata` et non `fallback_unknown`
   * AVANT d'activer le trading asiatique). Aucune écriture, aucune action de
   * trading — simple lecture du chemin de prix live.
   */
  @Get('debug/live-price/:symbol')
  async getDebugLivePrice(
    @Headers() headers: Record<string, string>,
    @Param('symbol') symbol: string,
  ) {
    extractUserId(headers); // throws si non authentifié
    const quote = await this.lisa.getLivePrice(symbol);
    return {
      symbol: quote.symbol,
      price: quote.price,
      source: quote.source,
      asOf: quote.asOf,
      // Aide à l'interprétation : true = source non fiable, stops/TP skippés.
      isFallback: quote.source.startsWith('fallback'),
    };
  }

  /**
   * Live snapshot des positions OUVERTES d'un portfolio : prix temps réel,
   * PnL non réalisé vs entry, source, distance TP/SL. Consommé par l'UI
   * (cartes positions ouvertes, poll ~30s). La tendance 5 min est calculée
   * côté frontend via ring buffer des polls successifs (évite de surcharger
   * EODHD avec un fetch candles par position à chaque poll).
   *
   * Read-only, aucune action de trading. Fail-soft par position : si le prix
   * live échoue, on renvoie source=fallback_unknown + price null (l'UI affiche
   * "—" sans casser la carte).
   */
  @Get('open-positions-live/:portfolioId')
  async getOpenPositionsLive(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers); // throws si non authentifié
    const { data, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, direction, entry_price, take_profit_price, stop_loss_price, entry_notional_usd, quantity, entry_timestamp')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (error) {
      return { positions: [], error: error.message, asOf: new Date().toISOString() };
    }
    const rows = data ?? [];
    const positions = await Promise.all(
      rows.map(async (p: Record<string, unknown>) => {
        const symbol = String(p.symbol);
        const entry = Number(p.entry_price);
        const qty = Number(p.quantity ?? 0);
        const dir = String(p.direction);
        const sign = dir === 'short' ? -1 : 1;
        let livePrice: number | null = null;
        let source = 'fallback_unknown';
        let asOf: string | null = null;
        try {
          const q = await this.lisa.getLivePrice(symbol);
          source = q.source;
          asOf = q.asOf;
          const px = Number(q.price);
          // source fallback/stale OU prix 0 → pas exploitable pour PnL live
          if (Number.isFinite(px) && px > 0 && !q.source.startsWith('fallback')) {
            livePrice = px;
          }
        } catch {
          /* fail-soft : livePrice reste null */
        }
        const pnlPct = livePrice !== null && entry > 0
          ? (((livePrice - entry) / entry) * 100) * sign
          : null;
        const pnlUsd = livePrice !== null && qty > 0
          ? (livePrice - entry) * qty * sign
          : null;
        const tp = p.take_profit_price != null ? Number(p.take_profit_price) : null;
        const sl = p.stop_loss_price != null ? Number(p.stop_loss_price) : null;
        // Distance restante vers TP / SL en % (depuis le prix live)
        const distToTpPct = livePrice !== null && tp !== null && livePrice > 0
          ? ((tp - livePrice) / livePrice) * 100 * sign
          : null;
        const distToSlPct = livePrice !== null && sl !== null && livePrice > 0
          ? ((livePrice - sl) / livePrice) * 100 * sign
          : null;
        return {
          id: String(p.id),
          symbol,
          direction: dir,
          entryPrice: entry,
          livePrice,
          source,
          asOf,
          stale: livePrice === null,
          pnlPct: pnlPct !== null ? Math.round(pnlPct * 100) / 100 : null,
          pnlUsd: pnlUsd !== null ? Math.round(pnlUsd * 100) / 100 : null,
          takeProfitPrice: tp,
          stopLossPrice: sl,
          distToTpPct: distToTpPct !== null ? Math.round(distToTpPct * 100) / 100 : null,
          distToSlPct: distToSlPct !== null ? Math.round(distToSlPct * 100) / 100 : null,
          entryTimestamp: String(p.entry_timestamp),
        };
      }),
    );
    return { positions, asOf: new Date().toISOString() };
  }

  @Get('binance/balance')
  getBinanceBalance(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // throws si non authentifié
    return this.lisa.fetchBinanceBalance();
  }

  /**
   * Daily catalyst brief — couche d'intelligence Gemini, env-gated.
   * Renvoie le dernier brief généré (cron 04:00 UTC). Null si pas encore généré.
   */
  @Get('daily-catalyst-brief')
  async getDailyCatalystBrief(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    const brief = await this.dailyCatalystBrief.getLatestBrief();
    return { brief, generated: brief !== null };
  }

  /**
   * Daily catalyst brief — déclenchement manuel (dev/debug).
   * Utile pour bootstrap le 1er brief sans attendre 04:00 UTC.
   */
  @Post('daily-catalyst-brief/generate')
  async generateDailyCatalystBrief(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    const brief = await this.dailyCatalystBrief.generateAndPersistBrief();
    return { brief, ok: brief !== null };
  }

  /**
   * Phase D-1 — Event-driven engine : liste les events watchés / snapshots
   * pris pour les prochaines `hours` heures (default 48h).
   * Visu/debug. Pas d'écriture.
   */
  @Get('event-engine/upcoming')
  async getEventEngineUpcoming(
    @Headers() headers: Record<string, string>,
    @Query('hours') hoursRaw?: string,
  ) {
    extractUserId(headers);
    const hours = Math.max(1, Math.min(168, Number(hoursRaw ?? '48') || 48));
    const events = await this.eventEngine.listUpcoming(hours);
    return { hours, count: events.length, events };
  }

  /**
   * Phase D-1 — trigger manuel du tick (debug/bootstrap).
   * Effet réel : schedule + snapshots. Aucune position ouverte (V1).
   */
  @Post('event-engine/tick')
  async triggerEventEngineTick(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    const result = await this.eventEngine.tick();
    return result;
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

  // LISA refonte B.2 — Lessons Impact Tracker.
  // Agrège les citations sur une fenêtre glissante (default 30j, max 365).
  @Get('lessons-impact/:portfolioId')
  getLessonsImpact(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('days') days?: string,
  ) {
    const parsedDays = Math.min(Math.max(parseInt(days ?? '30', 10) || 30, 1), 365);
    return this.lisa.getLessonsImpact(extractUserId(headers), portfolioId, parsedDays);
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

  // LISA refonte C.1 — Coach proposals : list / accept / reject.
  @Get('coach-proposals/:portfolioId')
  listCoachProposals(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
    @Query('status') status?: string,
  ) {
    return this.lisa.listCoachProposals(extractUserId(headers), portfolioId, status);
  }

  @Post('coach-proposals/:id/accept')
  @HttpCode(200)
  acceptCoachProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: { accepted_lessons?: number[]; accepted_params?: number[]; comment?: string },
  ) {
    return this.lisa.acceptCoachProposal(extractUserId(headers), id, body ?? {});
  }

  @Post('coach-proposals/:id/reject')
  @HttpCode(200)
  rejectCoachProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('comment') comment?: string,
  ) {
    return this.lisa.rejectCoachProposal(extractUserId(headers), id, comment);
  }

  // LISA Shadows Summary read-only widget (compare TRADER vs HIGH/MIDDLE/SMALL).
  @Get('shadows-summary')
  getShadowsSummary(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // auth check anti-abuse, pas de filtre user_id
    return this.lisa.getShadowsSummary();
  }

  // LISA refonte B.4.a — In-app notifications (badge + dropdown).
  @Get('notifications/:portfolioId')
  getNotifications(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.getNotifications(extractUserId(headers), portfolioId);
  }

  // LISA refonte B.3 — Désarme le kill-switch (anti-spirale ou manuel).
  // Pas de force-close, juste UPDATE kill_switch_active=false.
  @Post('kill-switch-reset/:portfolioId')
  @HttpCode(200)
  resetKillSwitch(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    return this.lisa.resetKillSwitch(extractUserId(headers), portfolioId);
  }

  // LISA refonte B.3 — Lessons management (CRUD partiel : list + toggle).
  @Get('scanner-lessons')
  listScannerLessons(
    @Headers() headers: Record<string, string>,
    @Query('active') active?: string,
    @Query('search') search?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
  ) {
    extractUserId(headers);
    const opts: { active?: boolean; search?: string; scope?: string; limit?: number } = {};
    if (active === 'true') opts.active = true;
    else if (active === 'false') opts.active = false;
    if (search) opts.search = search;
    if (scope) opts.scope = scope;
    if (limit) opts.limit = parseInt(limit, 10);
    return this.lisa.listScannerLessons(opts);
  }

  @Patch('scanner-lessons/:id')
  @HttpCode(200)
  toggleScannerLesson(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('is_active') isActive: boolean,
  ) {
    extractUserId(headers);
    return this.lisa.setScannerLessonActive(id, Boolean(isActive));
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

  /**
   * P19w (29/04/2026) — Alias `/lisa/portfolio-status/:portfolioId` →
   * comportement identique à `/lisa/daily-pnl/:portfolioId`.
   *
   * Pourquoi : Fly logs prod (19:29:26 UTC) montraient des 404 récurrents :
   *   ERROR [HTTP] GET /lisa/portfolio-status/ → 404
   * Le route name `portfolio-status` n'existait dans aucun fichier — il a été
   * référencé dans des scripts de validation externes (incl. mes propres
   * exemples curl écrits comme template). Ajouter l'alias supprime le bruit
   * 404 dans les logs sans casser quoi que ce soit. La méthode `daily-pnl`
   * retourne déjà : netReturn7dPct, winRatePct, tpHitRatePct (P19u),
   * recentStreak, costBreakdown, lastMechanicalCycle.
   */
  @Get('portfolio-status/:portfolioId')
  async getPortfolioStatus(
    @Headers() headers: Record<string, string>,
    @Param('portfolioId') portfolioId: string,
  ) {
    const userId = extractUserId(headers);
    return this.lisa.getDailyPnl(userId, portfolioId);
  }

  // PR2 cost-cuts (H) — endpoints kill-switch quotidien Gemini.
  //
  // GET  /lisa/gemini-cost/status
  // POST /lisa/gemini-cost/manual-override  body { reason?: string }
  // POST /lisa/gemini-cost/clear-override

  @Get('gemini-cost/status')
  async getGeminiCostStatus(@Headers() headers: Record<string, string>) {
    extractUserId(headers); // require authenticated user
    return this.geminiBudgetGuard.getStatus(true);
  }

  @Post('gemini-cost/manual-override')
  async overrideGeminiKillSwitch(
    @Headers() headers: Record<string, string>,
    @Body() body: { reason?: string } | null,
  ) {
    const userId = extractUserId(headers);
    const reason = body?.reason;
    return this.geminiBudgetGuard.manualOverride(reason ? { userId, reason } : { userId });
  }

  @Post('gemini-cost/clear-override')
  async clearGeminiOverride(@Headers() headers: Record<string, string>) {
    extractUserId(headers);
    return this.geminiBudgetGuard.clearOverride();
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

/**
 * PR Counters jour (Option B) — agrège par asset_class en 5 buckets UI :
 * us / eu / asia / crypto / other.
 *
 * Hotfix breakdown : `gainers_v1_shadow_signals.asset_class` stocke souvent
 * un générique 'equity' (sans préfixe us_equity/eu_equity/asia_equity). Sans
 * fallback exchange, ces rows tomberaient toutes en 'other' → breakdown UI
 * affichait uniquement "₿ 50" sur 1000 scans (cas user 05/05 14:30 UTC).
 *
 * Mapping exchange → bucket :
 *   - US, NYSE, NASDAQ, BATS, OTCQB, OTCMKTS → us
 *   - LSE, XETRA, PA, AS, AMS, MC, BME, MI, SW, BR → eu
 *   - KO, KQ, T, HK, NSE, BSE, SHG, SHE, AU, AX, TO → asia
 *   - BINANCE, CC, COINBASE → crypto
 */
const US_EXCHANGES = new Set(['US', 'NYSE', 'NASDAQ', 'BATS', 'OTCQB', 'OTCMKTS', 'OTC', 'NMFQS']);
const EU_EXCHANGES = new Set(['LSE', 'XETRA', 'PA', 'AS', 'AMS', 'MC', 'BME', 'MI', 'SW', 'BR']);
const ASIA_EXCHANGES = new Set(['KO', 'KQ', 'KS', 'KE', 'T', 'TSE', 'HK', 'NSE', 'BSE', 'SHG', 'SHE', 'SS', 'SZ', 'AU', 'AX', 'TO']);
const CRYPTO_EXCHANGES = new Set(['BINANCE', 'CC', 'COINBASE']);

function aggregateByClass(rows: Array<{ asset_class: string | null; exchange?: string | null }>): {
  us: number; eu: number; asia: number; crypto: number; other: number;
} {
  const out = { us: 0, eu: 0, asia: 0, crypto: 0, other: 0 };
  for (const r of rows) {
    const ac = String(r.asset_class ?? '').toLowerCase();
    const ex = String(r.exchange ?? '').toUpperCase();
    // Step 1 — try asset_class préfixe (préservé si bien typé)
    if (ac.startsWith('us_equity')) { out.us++; continue; }
    if (ac.startsWith('eu_equity')) { out.eu++; continue; }
    if (ac.startsWith('asia_equity')) { out.asia++; continue; }
    if (ac.startsWith('crypto')) { out.crypto++; continue; }
    // Step 2 — fallback exchange (bug fix : asset_class générique 'equity')
    if (CRYPTO_EXCHANGES.has(ex)) { out.crypto++; continue; }
    if (US_EXCHANGES.has(ex)) { out.us++; continue; }
    if (EU_EXCHANGES.has(ex)) { out.eu++; continue; }
    if (ASIA_EXCHANGES.has(ex)) { out.asia++; continue; }
    out.other++;
  }
  return out;
}

/**
 * PR Counters jour — bucketize timestamps en N jours pour sparkline.
 * Retourne un array [{ date: 'YYYY-MM-DD', count: N }] aligné UTC.
 */
function bucketByDay(rows: Array<{ created_at: string }>, daysWindow: number): Array<{
  date: string; count: number;
}> {
  const buckets = new Map<string, number>();
  // Pré-remplit avec 0 pour avoir tous les jours dans la window même sans data
  for (let i = daysWindow - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600_000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, 0);
  }
  for (const r of rows) {
    const key = String(r.created_at).slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

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

/**
 * P9 — Helper clamp pour query params numériques.
 */
function clampInt(raw: string | undefined, min: number, max: number, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
