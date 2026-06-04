import { BadRequestException, Injectable, Logger, NotFoundException, Inject, forwardRef, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import Anthropic from '@anthropic-ai/sdk';
import {
  CorpusQueryService,
  LisaClaudeClient,
  LlmRouter,
  PaperBrokerService,
  RiskEnforcer,
  RiskMonitorService,
  ThesisGeneratorService,
  computeDataQualityDegraded,
  type AllocationProposal,
  type HistoryMetrics,
  type LisaSessionConfig,
  type MarketSnapshot,
  type PaperPosition,
  type PerformanceObjectives,
  type PortfolioSnapshot,
  type RecentStreak,
  type SessionProfile,
  type TrajectoryStatus,
} from '@smartvest/ai-analyst';
import { BinanceAdapter } from '@smartvest/brokers';
import { SupabaseService } from '../../supabase/supabase.service';
import { DecisionLogService } from './decision-log.service';
import { RealtimePriceService } from './realtime-price.service';
import { EodhdEnrichmentService } from './eodhd-enrichment.service';
import { EodhdCalendarService } from './eodhd-calendar.service';
import { NewsRankerService } from './news-ranker.service';
import { NewsAggregatorService } from './news-aggregator.service';
import { LisaMemoryService } from './lisa-memory.service';
import { MaterialChangeDetectorService } from './material-change-detector.service';
import { TradeOutcomeRecorderService } from './trade-outcome-recorder.service';
import { DailySessionService } from './daily-session.service';
import type { DailyHarvestConfig, CapitalDisciplineMode } from '../types/capital-discipline.types';
import type { DailyHarvestBriefingContext } from '@smartvest/ai-analyst';
import { PatternBriefingService } from '../../bot-lab/services/pattern-briefing.service';
import { PatternAdoptionService } from '../../bot-lab/services/pattern-adoption.service';
import { LisaPerformanceAnalyticsService } from './lisa-performance-analytics.service';
import { EodhdTechnicalService } from './eodhd-technical.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { MultiTimeframePersistenceService } from './multi-tf-persistence.service';
import { CloseDecisionCaptureService } from './close-decision-capture.service';
import { BinanceMarketService } from './binance-market.service';
import { EodhdMacroService } from './eodhd-macro.service';
import { EodhdScreenerService } from './eodhd-screener.service';
import { EodhdInsiderService } from './eodhd-insider.service';
import { EodhdOptionsService } from './eodhd-options.service';
import { BinanceLiquidationsService } from './binance-liquidations.service';
import { ApiCostTrackerService, BudgetExceededError } from './api-cost-tracker.service';
import { MarketRegimeService } from './market-regime.service';
import { RedditService } from './reddit.service';
import {
  computeAtrPct,
  computeRealizedVolPct,
  computeRegimeAdjustedDeployment,
  shouldRunNewsAggregator,
  getProposalSources,
  marketForSymbol,
} from '@smartvest/ai-analyst';
import {
  buildYahooChartUrl,
  buildStooqCsvUrl,
  buildFredObservationsUrl,
  parseYahooChartResponse,
  parseStooqCsvResponse,
  parseFredObservationsResponse,
  fetchWithRetry,
} from '../helpers/macro-fallback.helper';
import { assertRegimeInputsHealthy } from '../helpers/regime-healthcheck.helper';
import { isInExchangeSession } from './exchange-sessions.helper';

/**
 * LisaService — orchestrateur principal du module AI analyst.
 *
 * Coordonne :
 *  - Config session (CRUD)
 *  - Génération de propositions via Claude
 *  - Enforcement des risk constraints
 *  - Ouverture/fermeture positions simulées
 *  - Snapshots + risk monitoring
 */
@Injectable()
export class LisaService {
  private readonly logger = new Logger(LisaService.name);
  private readonly claudeClient: LisaClaudeClient | null;
  private readonly corpusQuery: CorpusQueryService;
  private readonly thesisGenerator: ThesisGeneratorService | null;
  private readonly riskEnforcer: RiskEnforcer;
  private readonly paperBroker: PaperBrokerService;
  private readonly riskMonitor: RiskMonitorService;
  // Cache léger du dernier MarketSnapshot. Consommé par les services tiers
  // (LiveTraderAgent, ShadowSizingOrchestrator) qui ont besoin d'un contexte
  // macro frais sans payer le coût d'un re-fetch complet à chaque cycle.
  private lastMarketSnapshotCache: { snap: MarketSnapshot; fetchedAt: number } | null = null;

  /**
   * P0-B — Cache last-known macro per indicator. Quand toutes les sources
   * live (yahoo / eodhd / fred / stooq) ET le proxy ETF échouent
   * dans `fetchCascade`, on retourne la dernière valeur connue (TTL 24h)
   * marquée `dataQuality.stale=true` plutôt que la valeur fallback
   * hardcoded — Lisa peut continuer 1-2 cycles sur un VIX un peu daté
   * mais réaliste, sinon elle lit `vix=18.5` et classifie un faux régime.
   */
  private readonly lastKnownMacroValues = new Map<string, { value: number; timestamp: number }>();
  private readonly LAST_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * P0-B — Compteur metric `macro_quote_source{symbol,source,status}` pour
   * observabilité. Clé = `${indicator}:${source}:${status}`, valeur =
   * nombre d'occurrences. Exposé via `getMacroQuoteSourceCounters()` pour
   * dump dans /metrics ou inspection ad-hoc côté admin.
   */
  private readonly quoteSourceCounters = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly realtimePrice: RealtimePriceService,
    private readonly eodhdEnrichment: EodhdEnrichmentService,
    private readonly eodhdTechnical: EodhdTechnicalService,
    private readonly eodhdIntraday: EodhdIntradayService,
    private readonly binanceMarket: BinanceMarketService,
    private readonly eodhdMacro: EodhdMacroService,
    private readonly eodhdScreener: EodhdScreenerService,
    private readonly eodhdInsider: EodhdInsiderService,
    private readonly eodhdOptions: EodhdOptionsService,
    private readonly binanceLiquidations: BinanceLiquidationsService,
    private readonly eodhdCalendar: EodhdCalendarService,
    private readonly newsRanker: NewsRankerService,
    private readonly newsAggregator: NewsAggregatorService,
    private readonly lisaMemory: LisaMemoryService,
    @Inject(forwardRef(() => MaterialChangeDetectorService))
    private readonly materialDetector: MaterialChangeDetectorService,
    private readonly tradeOutcomeRecorder: TradeOutcomeRecorderService,
    private readonly performanceAnalytics: LisaPerformanceAnalyticsService,
    private readonly dailySession: DailySessionService,
    private readonly patternBriefing: PatternBriefingService,
    private readonly patternAdoption: PatternAdoptionService,
    // PATCH 4 — hard-stop budget journalier API
    private readonly apiCostTracker: ApiCostTrackerService,
    // P1 — classifier de régime tactique
    private readonly marketRegime: MarketRegimeService,
    // P1 PR E — direct access pour redditSpikeSigma (déjà injecté via newsAggregator
    // mais on a besoin du sigma rolling explicit, pas le résultat ranked)
    private readonly redditService: RedditService,
    // PR #353 — Router intraday dual-call EODHD + TD pour summarizePositions.
    private readonly intradayRouter: IntradayProviderRouter,
    // Risk-monitor extension : capture pathEff/persistence @ entry pour positions
    // ouvertes via le pipeline LLM (en plus du scanner). @Optional pour ne pas casser
    // les tests existants qui instancient LisaService avec un sous-ensemble de deps.
    @Optional() private readonly mtfPersistence?: MultiTimeframePersistenceService,
    // Apprentissage décisions fermeture (capture close manuel + counterfactuel).
    // @Optional : ne casse pas les tests qui instancient LisaService partiel.
    @Optional() private readonly closeDecisionCapture?: CloseDecisionCaptureService,
  ) {
    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const geminiKey = this.config.get<string>('GEMINI_API_KEY');

    // Migration 28/05/2026 — LISA_PROPOSAL_PROVIDER permet de switcher
    // entre Gemini 2.5 Pro (default, ~10× moins cher) et Claude Opus
    // (fallback / legacy). Si GEMINI_API_KEY absent, l'effectif tombe sur
    // claude (cf. LisaClaudeClient constructor logic).
    const proposalProviderRaw = (
      this.config.get<string>('LISA_PROPOSAL_PROVIDER') ?? 'gemini'
    ).toLowerCase();
    const proposalProvider: 'gemini' | 'claude' =
      proposalProviderRaw === 'claude' ? 'claude' : 'gemini';
    const proposalFallbackEnabled = (
      this.config.get<string>('LISA_PROPOSAL_FALLBACK_ENABLED') ?? 'true'
    ).toLowerCase() !== 'false';
    const geminiModel = this.config.get<string>('LISA_PROPOSAL_GEMINI_MODEL') ?? 'gemini-2.5-pro';

    if (anthropicKey || geminiKey) {
      // PATCH 6 P1 cost-01-llm-router — Toute requête Anthropic passe par le
      // routeur centralisé : il choisit le modèle par tâche, applique le
      // circuit breaker budget, et persiste le coût après chaque appel.
      // Le LisaClaudeClient n'instancie plus l'SDK directement.
      const dailyBudget = Number(
        this.config.get<string>('LLM_ROUTER_DAILY_BUDGET_USD') ?? '100',
      );
      const fallbackOnBudget = (
        this.config.get<string>('LLM_ROUTER_FALLBACK_ON_BUDGET') ?? 'true'
      ).toLowerCase() !== 'false';

      // Router Anthropic instancié uniquement si la clé est dispo (sinon
      // Gemini-only — pas de fallback Claude possible).
      const router = anthropicKey
        ? new LlmRouter(
            new Anthropic({ apiKey: anthropicKey }),
            this.apiCostTracker,
            { dailyCostBudgetUsd: dailyBudget, fallbackOnBudget },
            {
              warn: (event, details) => this.logger.warn(
                `[llm-router:${event}] ${JSON.stringify(details)}`,
              ),
            },
          )
        : null;

      if (!router && proposalProvider === 'claude') {
        this.claudeClient = null;
        this.logger.warn(
          'ANTHROPIC_API_KEY absent + LISA_PROPOSAL_PROVIDER=claude — thesis generation disabled',
        );
      } else if (router) {
        this.claudeClient = new LisaClaudeClient(router, {
          ...(geminiKey ? { apiKey: geminiKey } : {}),
          model: geminiModel,
          provider: proposalProvider,
          claudeFallbackEnabled: proposalFallbackEnabled,
          logger: {
            warn: (msg) => this.logger.warn(msg),
            info: (msg) => this.logger.log(msg),
          },
        });
        this.logger.log(
          `[lisa-llm] provider=${proposalProvider} geminiKey=${!!geminiKey} `
          + `claudeKey=${!!anthropicKey} fallback=${proposalFallbackEnabled} model=${geminiModel}`,
        );
      } else {
        // Gemini-only path : pas de router Anthropic, on construit un client
        // minimal qui ne peut PAS fallback Claude. On passe un router stub
        // qui throw si jamais appelé (théoriquement impossible vu effective=gemini).
        const stubRouter = new LlmRouter(
          {
            messages: {
              create: async () => {
                throw new Error('ANTHROPIC_API_KEY absent — Claude fallback impossible');
              },
            },
          },
          this.apiCostTracker,
          { dailyCostBudgetUsd: dailyBudget, fallbackOnBudget: false },
        );
        this.claudeClient = new LisaClaudeClient(stubRouter, {
          ...(geminiKey ? { apiKey: geminiKey } : {}),
          model: geminiModel,
          provider: 'gemini',
          claudeFallbackEnabled: false,
          logger: {
            warn: (msg) => this.logger.warn(msg),
            info: (msg) => this.logger.log(msg),
          },
        });
        this.logger.log(
          `[lisa-llm] provider=gemini (no Anthropic fallback) model=${geminiModel}`,
        );
      }
    } else {
      this.claudeClient = null;
      this.logger.warn('ANTHROPIC_API_KEY + GEMINI_API_KEY absents — thesis generation disabled');
    }

    this.corpusQuery = new CorpusQueryService(this.supabase.getClient());
    this.riskEnforcer = new RiskEnforcer();

    this.paperBroker = new PaperBrokerService({
      supabase: this.supabase.getClient(),
      fetchLivePrice: async (symbol) => this.fetchLivePrice(symbol),
    });

    this.thesisGenerator = this.claudeClient
      ? new ThesisGeneratorService(this.claudeClient, this.corpusQuery)
      : null;

    this.riskMonitor = new RiskMonitorService(
      this.supabase.getClient(),
      this.paperBroker,
      // Bug #M (14/05/2026) — expose `source` au risk-monitor pour qu'il puisse
      // skipper les prix fallback corrompus (incident SEE.LSE exit_price=0).
      // fetchLivePrice retourne déjà { symbol, price, asOf, source } (cf. l.2676).
      async (symbol) => {
        const q = await this.fetchLivePrice(symbol);
        return { price: q.price, source: q.source };
      },
    );
  }

  // ── Session config ──────────────────────────────────────────────────────────

  async getSessionConfig(userId: string, portfolioId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async upsertSessionConfig(userId: string, portfolioId: string, config: Record<string, unknown>) {
    // Vérifier que le portefeuille appartient bien à l'user ET is_simulation
    const { data: portfolio, error: pErr } = await this.supabase.getClient()
      .from('portfolios')
      .select('id, user_id, is_simulation')
      .eq('id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (pErr || !portfolio) throw new NotFoundException('Portfolio introuvable');
    if (!portfolio.is_simulation) {
      throw new BadRequestException('Lisa ne peut opérer QUE sur un portefeuille de simulation (is_simulation=true)');
    }

    // Accept both snake_case (frontend native) and camelCase (domain type).
    // Le frontend envoie par convention du snake_case qui matche les colonnes DB.
    // IMPORTANT : on distingue "clé absente du payload" (= pas de changement)
    // vs "clé présente avec valeur null" (= clear explicite). Le ?? de
    // l'ancienne version confondait les deux cas, ce qui empêchait de
    // nettoyer autopilot_expires_at quand le user décochait auto_approve.
    const hasKey = (obj: Record<string, unknown>, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(obj, key);
    const pick = <T>(snake: string, camel: string, fallback: T): T => {
      if (hasKey(config, snake)) return config[snake] as T;
      if (hasKey(config, camel)) return config[camel] as T;
      return fallback;
    };

    // Fetch existing row to preserve fields not sent in the partial update
    const { data: existing } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    const merged = {
      user_id: userId,
      portfolio_id: portfolioId,
      profile: pick('profile', 'profile', existing?.profile ?? 'long_term_investor'),
      // PR Hotfix — l'UI panneau Gainers envoie `capital_simulation` (alias
      // historique). On accepte les 2 noms pour ne pas perdre les saves.
      capital_usd: (() => {
        if (Object.prototype.hasOwnProperty.call(config, 'capital_simulation')) {
          return config.capital_simulation as string | number;
        }
        return pick('capital_usd', 'capitalUsd', existing?.capital_usd ?? '10000');
      })(),
      base_currency: pick('base_currency', 'baseCurrency', existing?.base_currency ?? 'EUR'),
      risk_constraints: pick('risk_constraints', 'riskConstraints', existing?.risk_constraints ?? {}),
      include_asset_classes: pick('include_asset_classes', 'includeAssetClasses', existing?.include_asset_classes ?? null),
      exclude_asset_classes: pick('exclude_asset_classes', 'excludeAssetClasses', existing?.exclude_asset_classes ?? null),
      // P10-FIX — Default seed bumped 7→8/10 pour briser la monoculture
      // safe-haven (or, défense). 8+ force la rotation hors consensus dominant.
      anti_consensus_strength: pick('anti_consensus_strength', 'antiConsensusStrength', existing?.anti_consensus_strength ?? 8),
      max_theses: pick('max_theses', 'maxTheses', existing?.max_theses ?? 5),
      enable_crypto: pick('enable_crypto', 'enableCrypto', existing?.enable_crypto ?? true),
      enable_derivatives: pick('enable_derivatives', 'enableDerivatives', existing?.enable_derivatives ?? false),
      enable_leverage: pick('enable_leverage', 'enableLeverage', existing?.enable_leverage ?? false),
      autopilot_enabled: pick('autopilot_enabled', 'autopilotEnabled', existing?.autopilot_enabled ?? false),
      autopilot_cycle_minutes: pick('autopilot_cycle_minutes', 'autopilotCycleMinutes', existing?.autopilot_cycle_minutes ?? 15),
      autopilot_auto_approve: pick('autopilot_auto_approve', 'autopilotAutoApprove', existing?.autopilot_auto_approve ?? false),
      autopilot_expires_at: pick('autopilot_expires_at', 'autopilotExpiresAt', existing?.autopilot_expires_at ?? null),
      autopilot_aggressive: pick('autopilot_aggressive', 'autopilotAggressive', existing?.autopilot_aggressive ?? false),
      autopilot_market_hours_only: pick('autopilot_market_hours_only', 'autopilotMarketHoursOnly', existing?.autopilot_market_hours_only ?? false),
      // PATCH 1 — kill-switch dataQuality (PR#1 P0) — default false.
      allow_degraded_macro: pick('allow_degraded_macro', 'allowDegradedMacro', existing?.allow_degraded_macro ?? false),
      // Lisa v2 — objectifs & budget (tous nullables)
      return_target_daily_pct: pick('return_target_daily_pct', 'returnTargetDailyPct', existing?.return_target_daily_pct ?? null),
      return_target_monthly_pct: pick('return_target_monthly_pct', 'returnTargetMonthlyPct', existing?.return_target_monthly_pct ?? null),
      return_target_annual_pct: pick('return_target_annual_pct', 'returnTargetAnnualPct', existing?.return_target_annual_pct ?? null),
      daily_cost_budget_usd: pick('daily_cost_budget_usd', 'dailyCostBudgetUsd', existing?.daily_cost_budget_usd ?? null),
      performance_horizon_days: pick('performance_horizon_days', 'performanceHorizonDays', existing?.performance_horizon_days ?? 30),
      // P9-UX — scanner cycle per-portfolio + path quality gate (migration 0089)
      gainers_cycle_minutes: pick('gainers_cycle_minutes', 'gainersCycleMinutes', existing?.gainers_cycle_minutes ?? 15),
      gainers_min_path_efficiency: pick('gainers_min_path_efficiency', 'gainersMinPathEfficiency', existing?.gainers_min_path_efficiency ?? 0.5),
      // P8 + P19x.2 — gates and TP/SL gainers config (migrations 0086 + 0093).
      // Avant ce fix, ces 3 colonnes étaient lues par le scanner mais jamais
      // écrites par upsertSessionConfig → toute saisie UI était silencieusement
      // ignorée et la valeur DB restait coincée sur le default migration.
      gainers_min_persistence_score: pick('gainers_min_persistence_score', 'gainersMinPersistenceScore', existing?.gainers_min_persistence_score ?? null),
      gainers_default_tp_pct: pick('gainers_default_tp_pct', 'gainersDefaultTpPct', existing?.gainers_default_tp_pct ?? 1.5),
      gainers_default_sl_pct: pick('gainers_default_sl_pct', 'gainersDefaultSlPct', existing?.gainers_default_sl_pct ?? 1.0),
      // PR #3 — Migration 0115 full-config columns. Capacity, sizing, cooldown,
      // univers toggles. Validation côté API ci-dessous (clamp + 400 lisible).
      gainers_max_open_positions: pick('gainers_max_open_positions', 'gainersMaxOpenPositions', existing?.gainers_max_open_positions ?? 5),
      gainers_max_per_cycle: pick('gainers_max_per_cycle', 'gainersMaxPerCycle', existing?.gainers_max_per_cycle ?? 3),
      gainers_position_pct: pick('gainers_position_pct', 'gainersPositionPct', existing?.gainers_position_pct ?? 20.0),
      gainers_cash_reserve_pct: pick('gainers_cash_reserve_pct', 'gainersCashReservePct', existing?.gainers_cash_reserve_pct ?? 10.0),
      gainers_cooldown_minutes: pick('gainers_cooldown_minutes', 'gainersCooldownMinutes', existing?.gainers_cooldown_minutes ?? 30),
      gainers_universe_us: pick('gainers_universe_us', 'gainersUniverseUs', existing?.gainers_universe_us ?? true),
      gainers_universe_eu: pick('gainers_universe_eu', 'gainersUniverseEu', existing?.gainers_universe_eu ?? true),
      gainers_universe_asia: pick('gainers_universe_asia', 'gainersUniverseAsia', existing?.gainers_universe_asia ?? true),
      gainers_universe_crypto: pick('gainers_universe_crypto', 'gainersUniverseCrypto', existing?.gainers_universe_crypto ?? true),
      gainers_fees_aware_buffer: pick('gainers_fees_aware_buffer', 'gainersFeesAwareBuffer', existing?.gainers_fees_aware_buffer ?? 2.0),
      gainers_min_net_profit_usd: pick('gainers_min_net_profit_usd', 'gainersMinNetProfitUsd', existing?.gainers_min_net_profit_usd ?? 0.50),
      // PR #4 — pWin gate (migration 0116). Désactivé par défaut, activable
      // par utilisateur quand modèle ML a convergé (≥30 trades fermés + AUC ≥ 0.55).
      gainers_p_win_gate_enabled: pick('gainers_p_win_gate_enabled', 'gainersPWinGateEnabled', existing?.gainers_p_win_gate_enabled ?? false),
      gainers_min_p_win: pick('gainers_min_p_win', 'gainersMinPWin', existing?.gainers_min_p_win ?? 0.50),
      // PR #262 — Capital rotation : seuil "stagnante" (15-480 min, default 90)
      gainers_rotation_stagnant_min_age_min: pick('gainers_rotation_stagnant_min_age_min', 'gainersRotationStagnantMinAgeMin', existing?.gainers_rotation_stagnant_min_age_min ?? 90),
      // PR #269 — Capital rotation : seuil pathEff candidat A+ (0..1 ou null pour désactiver, default 0.5)
      gainers_rotation_min_path_efficiency: pick('gainers_rotation_min_path_efficiency', 'gainersRotationMinPathEfficiency', existing?.gainers_rotation_min_path_efficiency ?? 0.5),
      // PR #270 — Post-SL cooldown par symbole (0..1440 min, default 60)
      gainers_post_sl_cooldown_min: pick('gainers_post_sl_cooldown_min', 'gainersPostSlCooldownMin', existing?.gainers_post_sl_cooldown_min ?? 60),
      // PR #271 — Asia strictness boost additif sur path/persistence (0..0.50, default 0.10)
      gainers_asia_strictness_boost: pick('gainers_asia_strictness_boost', 'gainersAsiaStrictnessBoost', existing?.gainers_asia_strictness_boost ?? 0.10),
      // PR #243 — Adaptive Selectivity toggle (migration 0119). Opt-in default false.
      gainers_adaptive_enabled: pick('gainers_adaptive_enabled', 'gainersAdaptiveEnabled', existing?.gainers_adaptive_enabled ?? false),
      // PR #276 — DB-backed toggles rotation + high-grading + min_score (migration 0131)
      gainers_capital_rotation_enabled: pick('gainers_capital_rotation_enabled', 'gainersCapitalRotationEnabled', existing?.gainers_capital_rotation_enabled ?? null),
      gainers_high_grading_enabled: pick('gainers_high_grading_enabled', 'gainersHighGradingEnabled', existing?.gainers_high_grading_enabled ?? null),
      gainers_rotation_min_score: pick('gainers_rotation_min_score', 'gainersRotationMinScore', existing?.gainers_rotation_min_score ?? 0.85),
      // PR #278 — Top pool size configurable (migration 0133)
      gainers_top_pool_size: pick('gainers_top_pool_size', 'gainersTopPoolSize', existing?.gainers_top_pool_size ?? 10),
      // PR #266 — Session-aware filter + force-close before close (migration 0123).
      gainers_session_filter_enabled: pick('gainers_session_filter_enabled', 'gainersSessionFilterEnabled', existing?.gainers_session_filter_enabled ?? true),
      gainers_force_close_before_close_enabled: pick('gainers_force_close_before_close_enabled', 'gainersForceCloseBeforeCloseEnabled', existing?.gainers_force_close_before_close_enabled ?? false),
      gainers_force_close_offset_min: pick('gainers_force_close_offset_min', 'gainersForceCloseOffsetMin', existing?.gainers_force_close_offset_min ?? 30),
      // PR #464 — Smart close before close (lock-profit variant, migration 0165).
      gainers_smart_close_enabled: pick('gainers_smart_close_enabled', 'gainersSmartCloseEnabled', existing?.gainers_smart_close_enabled ?? false),
      gainers_smart_close_window_min: pick('gainers_smart_close_window_min', 'gainersSmartCloseWindowMin', existing?.gainers_smart_close_window_min ?? 30),
      gainers_smart_close_min_profit_pct: pick('gainers_smart_close_min_profit_pct', 'gainersSmartCloseMinProfitPct', existing?.gainers_smart_close_min_profit_pct ?? 1.0),
      // FIX 01/06 — Reset markers (migration 0174). L'UI gains-tracker poste
      // ces 3 champs via useResetScopeMarker (use-lisa-targets.ts:202+) pour
      // reset l'affichage par scope. Avant ce fix, ces clés étaient présentes
      // dans `config` mais jamais incluses dans `merged` → silencieusement
      // perdues (PostgREST ignore les colonnes inconnues sans erreur).
      // Conséquence UI : bouton "🔄 Reset jour/mois/année" sans effet.
      lisa_reset_marker_daily: pick('lisa_reset_marker_daily', 'lisaResetMarkerDaily', existing?.lisa_reset_marker_daily ?? null),
      lisa_reset_marker_monthly: pick('lisa_reset_marker_monthly', 'lisaResetMarkerMonthly', existing?.lisa_reset_marker_monthly ?? null),
      lisa_reset_marker_annual: pick('lisa_reset_marker_annual', 'lisaResetMarkerAnnual', existing?.lisa_reset_marker_annual ?? null),
    };

    // Validation des valeurs numériques pour renvoyer une 400 lisible plutôt
    // qu'un cryptique "numeric field overflow" venu de Postgres. La DB elle
    // peut accepter jusqu'à numeric(8,4) = 9999.9999 après migration 0100,
    // mais on cap côté API à des valeurs sensées (≤ 9999%) pour bloquer la
    // saisie accidentelle de 1e9.
    const validateReturnTarget = (key: string, value: unknown): void => {
      if (value == null) return;
      const n = typeof value === 'string' ? parseFloat(value) : Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`${key} : valeur numérique invalide.`);
      }
      if (n < -100 || n > 9999) {
        throw new BadRequestException(
          `${key} : valeur ${n} hors plage acceptée (-100 à 9999%).`,
        );
      }
    };
    validateReturnTarget('return_target_daily_pct', merged.return_target_daily_pct);
    validateReturnTarget('return_target_monthly_pct', merged.return_target_monthly_pct);
    validateReturnTarget('return_target_annual_pct', merged.return_target_annual_pct);

    // P19x.2 — gainers TP/SL : DB CHECK constraints sont (0, 50] pour TP et
    // (0, 20] pour SL (migration 0093). On valide côté API pour 400 lisible.
    const validateGainersPct = (key: string, value: unknown, max: number): void => {
      if (value == null) return;
      const n = typeof value === 'string' ? parseFloat(value) : Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`${key} : valeur numérique invalide.`);
      }
      if (n <= 0 || n > max) {
        throw new BadRequestException(`${key} : valeur ${n} hors plage acceptée (0, ${max}].`);
      }
    };
    validateGainersPct('gainers_default_tp_pct', merged.gainers_default_tp_pct, 50);
    validateGainersPct('gainers_default_sl_pct', merged.gainers_default_sl_pct, 20);

    // PR #3 — Migration 0115 validators (capacity / sizing / cooldown).
    const validateInt = (key: string, value: unknown, min: number, max: number): void => {
      if (value == null) return;
      const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new BadRequestException(`${key} : entier invalide.`);
      }
      if (n < min || n > max) {
        throw new BadRequestException(`${key} : valeur ${n} hors plage [${min}, ${max}].`);
      }
    };
    const validateNum = (key: string, value: unknown, min: number, max: number): void => {
      if (value == null) return;
      const n = typeof value === 'string' ? parseFloat(value) : Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`${key} : valeur numérique invalide.`);
      }
      if (n < min || n > max) {
        throw new BadRequestException(`${key} : valeur ${n} hors plage [${min}, ${max}].`);
      }
    };
    validateInt('gainers_max_open_positions', merged.gainers_max_open_positions, 1, 20);
    validateInt('gainers_max_per_cycle', merged.gainers_max_per_cycle, 1, 10);
    validateNum('gainers_position_pct', merged.gainers_position_pct, 1, 100);
    validateNum('gainers_cash_reserve_pct', merged.gainers_cash_reserve_pct, 0, 50);
    validateInt('gainers_cooldown_minutes', merged.gainers_cooldown_minutes, 0, 240);
    validateNum('gainers_fees_aware_buffer', merged.gainers_fees_aware_buffer, 1.0, 5.0);
    validateNum('gainers_min_net_profit_usd', merged.gainers_min_net_profit_usd, 0, 9999);
    validateNum('gainers_min_p_win', merged.gainers_min_p_win, 0, 1);
    // PR #266 — force-close offset 5..120 min
    validateInt('gainers_force_close_offset_min', merged.gainers_force_close_offset_min, 5, 120);
    // PR #464 — smart close window 15..120 min (must be > force_close_offset_min for the window to exist)
    validateInt('gainers_smart_close_window_min', merged.gainers_smart_close_window_min, 15, 120);
    // PR #464 — smart close min profit threshold 0.10..10.00 %
    validateNum('gainers_smart_close_min_profit_pct', merged.gainers_smart_close_min_profit_pct, 0.10, 10);
    // PR #268 — rotation stagnant min age 3..480 min (relâché de 15..480)
    validateInt('gainers_rotation_stagnant_min_age_min', merged.gainers_rotation_stagnant_min_age_min, 3, 480);
    // PR #269 — rotation min path efficiency 0..1 (null désactive le gate)
    if (merged.gainers_rotation_min_path_efficiency != null) {
      validateNum('gainers_rotation_min_path_efficiency', merged.gainers_rotation_min_path_efficiency, 0, 1);
    }
    // PR #270 — post-SL cooldown 0..1440 min
    validateInt('gainers_post_sl_cooldown_min', merged.gainers_post_sl_cooldown_min, 0, 1440);
    // PR #271 — asia strictness boost 0..0.50
    if (merged.gainers_asia_strictness_boost != null) {
      validateNum('gainers_asia_strictness_boost', merged.gainers_asia_strictness_boost, 0, 0.50);
    }
    // PR #276/#277 — rotation min score 0..1.0 (0 = OFF, gate désactivé)
    if (merged.gainers_rotation_min_score != null) {
      validateNum('gainers_rotation_min_score', merged.gainers_rotation_min_score, 0, 1.0);
    }
    // PR #278 — top pool size 5..50
    validateInt('gainers_top_pool_size', merged.gainers_top_pool_size, 5, 50);
    // Cohérence : positionPct × maxOpen + cashReserve ne doit pas dépasser 100%
    // (sinon impossible de tenir le cash buffer en pratique). Warning soft, pas hard fail.
    const totalAllocPct =
      Number(merged.gainers_position_pct) * Number(merged.gainers_max_open_positions)
      + Number(merged.gainers_cash_reserve_pct);
    if (totalAllocPct > 200) {
      // Hard fail uniquement au-delà du double : permet over-leverage modéré.
      throw new BadRequestException(
        `Configuration incohérente : position_pct (${merged.gainers_position_pct}%) × max_open (${merged.gainers_max_open_positions}) + cash_reserve (${merged.gainers_cash_reserve_pct}%) = ${totalAllocPct.toFixed(0)}% du capital. Réduire position_pct ou max_open_positions.`,
      );
    }
    // gainers_min_persistence_score est une fraction [0, 1] — null = utilise default.
    if (merged.gainers_min_persistence_score != null) {
      const n = typeof merged.gainers_min_persistence_score === 'string'
        ? parseFloat(merged.gainers_min_persistence_score as string)
        : Number(merged.gainers_min_persistence_score);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new BadRequestException(
          `gainers_min_persistence_score : valeur ${merged.gainers_min_persistence_score} hors plage [0, 1].`,
        );
      }
    }

    // Validation : auto_approve exige uniquement un portefeuille de simulation
    // (déjà vérifié plus haut). L'expiration est suggestive côté UI mais non
    // bloquante ici — l'utilisateur peut laisser tourner sans deadline s'il
    // le souhaite. Le kill-switch et le bouton de désactivation restent
    // toujours accessibles comme garde-fous opérationnels.
    if (merged.autopilot_auto_approve === true) {
      const expiresAt = merged.autopilot_expires_at as string | null;
      if (expiresAt) {
        const expiresMs = new Date(expiresAt).getTime();
        if (isNaN(expiresMs)) {
          throw new BadRequestException('autopilot_expires_at : date invalide.');
        }
      }
    }

    let { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .upsert(merged, { onConflict: 'portfolio_id' })
      .select()
      .single();

    // Si la colonne autopilot_market_hours_only n'existe pas encore en DB
    // (migration 0047 pas encore appliquée), Supabase renvoie une erreur 400
    // "Could not find the '...' column". On retente sans ce champ pour que
    // la sauvegarde des autres champs ne soit pas bloquée.
    if (error && /return_target_|daily_cost_budget_usd|performance_horizon_days/i.test(error.message)) {
      this.logger.warn('Colonnes Lisa v2 (0050) absentes — retry sans objectifs');
      const {
        return_target_daily_pct: _a,
        return_target_monthly_pct: _b,
        return_target_annual_pct: _c,
        daily_cost_budget_usd: _d,
        performance_horizon_days: _e,
        ...mergedFallback
      } = merged;
      void _a; void _b; void _c; void _d; void _e;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error && /autopilot_market_hours_only/i.test(error.message)) {
      this.logger.warn('Colonne autopilot_market_hours_only absente — retry sans ce champ');
      const { autopilot_market_hours_only: _omit, ...mergedFallback } = merged;
      void _omit;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PATCH 1 — fallback si migration 0070_allow_degraded_macro pas encore appliquée
    if (error && /allow_degraded_macro/i.test(error.message)) {
      this.logger.warn('Colonne allow_degraded_macro absente — retry sans ce champ');
      const { allow_degraded_macro: _omit, ...mergedFallback } = merged;
      void _omit;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // P9-UX — fallback si migration 0089/0093 pas encore appliquée
    if (error && /gainers_cycle_minutes|gainers_min_path_efficiency|gainers_default_tp_pct|gainers_default_sl_pct|gainers_min_persistence_score/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_* absentes — retry sans ces champs');
      const {
        gainers_cycle_minutes: _gc,
        gainers_min_path_efficiency: _gpe,
        gainers_min_persistence_score: _gmp,
        gainers_default_tp_pct: _gtp,
        gainers_default_sl_pct: _gsl,
        ...mergedFallback
      } = merged;
      void _gc; void _gpe; void _gmp; void _gtp; void _gsl;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #243 — fallback si migration 0119 pas encore appliquée
    if (error && /gainers_adaptive_enabled/i.test(error.message)) {
      this.logger.warn('Colonne gainers_adaptive_enabled absente — retry sans');
      const { gainers_adaptive_enabled: _ade, ...mergedFallback } = merged;
      void _ade;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #4 — fallback si migration 0116 pas encore appliquée
    if (error && /gainers_p_win_gate_enabled|gainers_min_p_win/i.test(error.message)) {
      this.logger.warn('Colonnes pWin (migration 0116) absentes — retry sans ces champs');
      const {
        gainers_p_win_gate_enabled: _pwe,
        gainers_min_p_win: _pmw,
        ...mergedFallback
      } = merged;
      void _pwe; void _pmw;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #3 — fallback si migration 0115 pas encore appliquée
    if (error && /gainers_max_open_positions|gainers_max_per_cycle|gainers_position_pct|gainers_cash_reserve_pct|gainers_cooldown_minutes|gainers_universe_|gainers_fees_aware_buffer|gainers_min_net_profit_usd/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_* (migration 0115) absentes — retry sans ces champs');
      const {
        gainers_max_open_positions: _mop,
        gainers_max_per_cycle: _mpc,
        gainers_position_pct: _ppc,
        gainers_cash_reserve_pct: _crp,
        gainers_cooldown_minutes: _cdm,
        gainers_universe_us: _uus,
        gainers_universe_eu: _ueu,
        gainers_universe_asia: _ua,
        gainers_universe_crypto: _uc,
        gainers_fees_aware_buffer: _fab,
        gainers_min_net_profit_usd: _mnp,
        ...mergedFallback
      } = merged;
      void _mop; void _mpc; void _ppc; void _crp; void _cdm;
      void _uus; void _ueu; void _ua; void _uc; void _fab; void _mnp;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #266 — fallback si migration 0123 pas encore appliquée (session_filter / force_close)
    if (error && /gainers_session_filter_enabled|gainers_force_close_before_close_enabled|gainers_force_close_offset_min/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_session_filter / gainers_force_close (migration 0123) absentes — retry sans ces champs');
      const {
        gainers_session_filter_enabled: _sfe,
        gainers_force_close_before_close_enabled: _fcbce,
        gainers_force_close_offset_min: _fcom,
        ...mergedFallback
      } = merged;
      void _sfe; void _fcbce; void _fcom;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #464 — fallback si migration 0165 pas encore appliquée (smart_close_*)
    if (error && /gainers_smart_close_enabled|gainers_smart_close_window_min|gainers_smart_close_min_profit_pct/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_smart_close_* (migration 0165) absentes — retry sans ces champs');
      const {
        gainers_smart_close_enabled: _sce,
        gainers_smart_close_window_min: _scw,
        gainers_smart_close_min_profit_pct: _scp,
        ...mergedFallback
      } = merged;
      void _sce; void _scw; void _scp;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #269 — fallback si migration 0125 pas encore appliquée (rotation_min_path_efficiency)
    if (error && /gainers_rotation_min_path_efficiency/i.test(error.message)) {
      this.logger.warn('Colonne gainers_rotation_min_path_efficiency (migration 0125) absente — retry sans ce champ');
      const { gainers_rotation_min_path_efficiency: _rmpe, ...mergedFallback } = merged;
      void _rmpe;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #278 — fallback si migration 0133 pas appliquée
    if (error && /gainers_top_pool_size/i.test(error.message)) {
      this.logger.warn('Colonne gainers_top_pool_size (migration 0133) absente — retry sans ce champ');
      const { gainers_top_pool_size: _tps, ...mergedFallback } = merged;
      void _tps;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #276 — fallback si migration 0131 pas appliquée
    if (error && /gainers_capital_rotation_enabled|gainers_high_grading_enabled|gainers_rotation_min_score/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_capital_rotation_enabled / gainers_high_grading_enabled / gainers_rotation_min_score (migration 0131) absentes — retry sans ces champs');
      const {
        gainers_capital_rotation_enabled: _cre,
        gainers_high_grading_enabled: _hge,
        gainers_rotation_min_score: _rms,
        ...mergedFallback
      } = merged;
      void _cre; void _hge; void _rms;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    // PR #270/#271 — fallback si migrations 0126/0127 pas appliquées
    if (error && /gainers_post_sl_cooldown_min|gainers_asia_strictness_boost/i.test(error.message)) {
      this.logger.warn('Colonnes gainers_post_sl_cooldown_min / gainers_asia_strictness_boost (migrations 0126/0127) absentes — retry sans ces champs');
      const {
        gainers_post_sl_cooldown_min: _psc,
        gainers_asia_strictness_boost: _asb,
        ...mergedFallback
      } = merged;
      void _psc; void _asb;
      const retry = await this.supabase.getClient()
        .from('lisa_session_configs')
        .upsert(mergedFallback, { onConflict: 'portfolio_id' })
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── Proposal generation ────────────────────────────────────────────────────

  /**
   * P5.4 — Détecte si le userFocus vient d'un wake-up agent (AgentLisaSyncService).
   * En wake-up mode, on réduit max_theses pour que Lisa réponde vite et cible
   * ses tactical_overrides plutôt que régénérer 5 nouvelles thèses.
   */
  private isWakeUpMode(userFocus?: string): boolean {
    return !!userFocus && userFocus.startsWith('WAKE-UP');
  }

  /**
   * P5-LLM-THESES — Vrai si le userFocus correspond aux focus génériques
   * de l'autopilot cron (pas un focus explicite utilisateur). Sert au
   * logging : quand Lisa retourne theses=[] sur un focus utilisateur
   * EXPLICITE (scénarios concrets), c'est un signal de mauvais prompt.
   */
  private isAutopilotGenericFocus(userFocus?: string): boolean {
    if (!userFocus) return true;
    const trimmed = userFocus.trim().toLowerCase();
    return (
      trimmed.startsWith('autopilot agressif') ||
      trimmed.startsWith('autopilot cycle') ||
      trimmed.startsWith('wake-up')
    );
  }

  async generateProposal(userId: string, portfolioId: string, userFocus?: string): Promise<AllocationProposal> {
    if (!this.thesisGenerator) {
      throw new BadRequestException('Thesis generator unavailable: ANTHROPIC_API_KEY not configured on backend');
    }

    const config = await this.getSessionConfig(userId, portfolioId);
    if (!config) throw new NotFoundException('Session config introuvable — configurer d\'abord');

    // PATCH 4 + P8-BR — Hard-stop budget journalier API.
    // Avant tout call Claude (~$0.17 Opus), vérifier que le budget configuré
    // n'est pas déjà dépassé. Si oui → set autopilot_paused_reason +
    // throw BudgetExceededError. P8-BR : on NE TOUCHE PLUS à autopilot_enabled,
    // pour permettre la reprise automatique au prochain cycle quand le coût
    // retombe sous 90% du budget (rollover UTC ou budget bumped). Cf.
    // lisa-autopilot.service.runAutopilotCycleInner pour la logique de resume.
    const budget = config.daily_cost_budget_usd as number | null | undefined;
    if (budget != null && Number(budget) > 0) {
      const todayCostUsd = await this.apiCostTracker.getTodayTotalUsd();
      if (todayCostUsd >= Number(budget)) {
        await this.supabase.getClient()
          .from('lisa_session_configs')
          .update({ autopilot_paused_reason: 'BUDGET_EXCEEDED' })
          .eq('portfolio_id', portfolioId)
          .then(({ error }) => {
            if (error) this.logger.warn(`autopilot pause on budget exceeded failed: ${error.message}`);
          });

        await this.decisionLog.append({
          portfolioId,
          kind: 'autopilot_paused',
          summary: `Autopilot mis en pause — budget API journalier dépassé : $${todayCostUsd.toFixed(2)} >= $${Number(budget).toFixed(2)}`,
          rationale: `Le coût Claude cumulé sur la journée dépasse la limite configurée (config.daily_cost_budget_usd). Reprise automatique au prochain cycle dès que le coût retombe sous 90% du budget (rollover UTC à minuit OU budget augmenté manuellement). autopilot_enabled reste à true. P8-BR risk-resilience.`,
          payload: {
            reason: 'daily_api_budget_exceeded',
            today_cost_usd: todayCostUsd,
            budget_usd: Number(budget),
            paused_reason: 'BUDGET_EXCEEDED',
          },
          triggeredBy: 'risk_monitor',
        }).catch((e) => this.logger.warn(`budget log append failed: ${String(e)}`));

        throw new BudgetExceededError(todayCostUsd, Number(budget));
      }
    }

    const sessionConfig: LisaSessionConfig = {
      profile: config.profile as SessionProfile,
      capitalUsd: String(config.capital_usd),
      baseCurrency: config.base_currency as string,
      riskConstraints: {
        maxDrawdown2DaysPct: 10,
        maxDrawdown7DaysPct: 15,
        maxDrawdown30DaysPct: 25,
        maxPositionSizePct: 25,
        maxOpenPositions: 3,
        maxLeverage: 1.5,
        maxExposurePerAssetClassPct: 40,
        maxPortfolioVolatilityPct: 20,
        targetDeploymentPct: 60,
        autoLiquidateOnKill: true,
        // PATCH 3 — caps par thème (defaults conservateurs pour HARVEST)
        maxThemePct: {
          geopolitical_safehaven: 40,
          ai_megacap: 35,
          energy_disruption: 30,
          crypto: 25,
          defensive_bond_proxy: 50,
          small_cap_breakout: 25,
          other: 50,
        },
        ...(config.risk_constraints as Partial<LisaSessionConfig['riskConstraints']> ?? {}),
      },
      antiConsensusStrength: (config.anti_consensus_strength as number) ?? 7,
      // P5.4 — Wake-up mode : l'agent a détecté un signal urgent. Lisa doit
      // répondre vite avec un focus sur les tactical_overrides plutôt que
      // régénérer 5 thèses complètes. On baisse max_theses à 2 pour réduire
      // les tokens output (~70% de coût en moins, ~50% de latence en moins).
      maxTheses: this.isWakeUpMode(userFocus)
        ? 2
        : ((config.max_theses as number) ?? 5),
      enableCrypto: (config.enable_crypto as boolean) ?? true,
      enableDerivatives: (config.enable_derivatives as boolean) ?? false,
      enableLeverage: (config.enable_leverage as boolean) ?? false,
      // PATCH 1 — kill-switch dataQuality (PR#1 P0).
      allowDegradedMacro: (config.allow_degraded_macro as boolean) ?? false,
    };

    const marketSnapshot = await this.fetchMarketSnapshot();

    // P2-C — Sizing dynamique selon régime risk-on / risk-off.
    // Ajuste targetDeploymentPct AVANT envoi prompt Lisa :
    //   - RISK_ON  (VIX<20 ET spread us10y-us2y > 0)  → +5 pp (90 → 95)
    //   - RISK_OFF (VIX≥20 ET spread us10y-us2y ≤ 0)  → -20 pp (90 → 70)
    //   - NEUTRAL  (signaux mixtes ou inputs incomplets) → no-op
    // Aligne le levier de cash deployment sur l'environnement macro :
    // pousse le déploiement quand la vol implicite est calme + curve
    // steepening (signal classique appétit risque), réduit en stress.
    {
      const baseline = sessionConfig.riskConstraints.targetDeploymentPct;
      const verdict = computeRegimeAdjustedDeployment(
        {
          vix: Number.isFinite(marketSnapshot.vix) ? marketSnapshot.vix : null,
          us10yYield: Number.isFinite(marketSnapshot.us10yYield) ? marketSnapshot.us10yYield : null,
          us2yYield: Number.isFinite(marketSnapshot.us2yYield) ? marketSnapshot.us2yYield : null,
        },
        baseline,
      );
      if (verdict.deltaPct !== 0) {
        sessionConfig.riskConstraints.targetDeploymentPct = verdict.adjustedDeploymentPct;
        this.logger.log(
          `[regime-deployment] ${verdict.regime} (${verdict.reasons.join(', ')}) → targetDeploymentPct ${baseline}% → ${verdict.adjustedDeploymentPct}% (Δ${verdict.deltaPct >= 0 ? '+' : ''}${verdict.deltaPct}pp)`,
        );
      }
    }

    // Enrichissement EODHD Premium : calendrier économique + macro +
    // screener (pas dépendants des positions). News fetchée plus bas une
    // fois les positions connues (NewsAggregator a besoin des heldSymbols
    // pour fetcher StockTwits/Twitter ciblés).
    try {
      const [econEvents, macro, screenerSummary] = await Promise.all([
        this.eodhdEnrichment.fetchUpcomingEconomicEvents(7, 1),
        this.eodhdMacro.getMacroContext('USA').catch(() => null),
        this.eodhdScreener.summarizeAllScans().catch(() => ''),
      ]);
      if (screenerSummary) {
        marketSnapshot.screenerCandidates = screenerSummary;
      }
      if (macro) {
        marketSnapshot.macroContext = {
          country: macro.country,
          realRateUsPct: macro.realRate?.value ?? null,
          inflationYoyPct: macro.inflationYoY?.value ?? null,
          unemploymentPct: macro.unemployment?.value ?? null,
          gdpYoyPct: macro.gdpGrowth?.value ?? null,
        };
      }
      // Trie les events : importance desc (3→1), puis date asc — les plus
      // critiques en premier. Cap à 20 pour éviter bloat du prompt.
      const sortedEvents = [...econEvents].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      });
      marketSnapshot.upcomingEvents = sortedEvents.slice(0, 20).map((e) => ({
        name: `${e.country ? `[${e.country}] ` : ''}${e.name}${e.estimate ? ` (est ${e.estimate})` : ''}`,
        date: e.date,
        importance: e.importance === 3 ? 'high' : e.importance === 2 ? 'medium' : 'low',
      }));
    } catch (e) {
      this.logger.warn(`EODHD enrichment partial failure: ${String(e).slice(0, 120)}`);
    }

    // P3-A.2 — injecte les positions rebound OPEN dans le snapshot pour
    // que Lisa connaisse les rebounds en cours (paper trading) et évite
    // de doubler une position sur le même ticker. Mappage léger en mode
    // "signals" (les TP/SL sont déjà figés à l'ouverture, pas négociables).
    try {
      const reboundOpen = await this.getReboundOpenPositions(portfolioId);
      if (reboundOpen.length > 0) {
        marketSnapshot.reboundSignals = reboundOpen.map((r) => ({
          ticker: r.ticker,
          entry: r.entry,
          tp1: r.tp1,
          tp2: r.tp2,
          tp3: r.tp3,
          sl: r.sl,
          timeStopDays: Math.max(
            0,
            Math.round((new Date(r.timeStopAt).getTime() - Date.now()) / 86_400_000),
          ),
          confidence: r.confidence ?? 0,
        }));
      }
    } catch (e) {
      this.logger.debug(`rebound positions inject skipped: ${String(e).slice(0, 80)}`);
    }

    // Persona "chasseur EV+" injectée en amont du user focus si le flag est actif.
    // N'ajoute AUCUN droit d'exécution réelle — elle modifie juste le cadrage de
    // l'analyse produite par Claude (plus de turnover, sizing plus agressif dans
    // les limites toujours imposées par le risk_enforcer).
    const aggressivePersona = (config.autopilot_aggressive === true)
      ? `\n# PERSONA OVERRIDE — CHASSEUSE SÉLECTIVE EV+ (simulation uniquement)
Tu opères en mode chasse agressive MAIS sélective. Philosophie centrale :
**LET WINNERS RUN, ne fais rien si rien ne mérite d'être fait.**

## Règles d'OUVERTURE (discrétion stricte)
- Tu n'ouvres une nouvelle thèse QUE si son risk/reward est meilleur que le
  PIRE R/R des positions existantes — sinon tu remplaces une bonne idée par
  une moins bonne, perte sèche.
- Si le portefeuille est globalement en gain et que toutes les thèses
  initiales tiennent → DEFAULT = HOLD. Retourne un array \`theses\` vide,
  c'est une réponse parfaitement valide et souvent la meilleure.
- Pas de honte à dire « rien à proposer ce cycle » dans \`warnings\`. Le
  meilleur trade est très souvent celui qu'on ne fait pas.
- Chaque trade coûte des fees + spread + slippage simulés (~10-30 bps) qui
  GRIGNOTENT les gains acquis. Le turnover pour le turnover détruit la perf.

## Règles de FERMETURE (toujours actives, pas de discrétion)
- Stop-loss déclenché → fermeture (gérée par le risk monitor, hors prompt).
- Thèse INVALIDÉE par un nouvel élément (news, macro, prix qui invalide le
  setup) → \`closeRecommendations\` immédiat avec rationale.
- Risque devenu asymétrique défavorable (R/R retombé < 1) → fermeture.
- Une position pourrie qui stagne sans catalyseur clair > son horizon → fermeture.

## RÈGLE CRITIQUE — arbitrage cash saturé
Si le bloc "RÉSUMÉ PORTEFEUILLE" montre un cash disponible < 10 % du
capital total ET que tu identifies une nouvelle thèse avec R/R strictement
supérieur à la pire position existante :
→ tu DOIS inclure cette pire position dans \`closeRecommendations\` pour
   libérer le cash nécessaire à la nouvelle ouverture.
→ Ne propose JAMAIS une nouvelle thèse avec allocation > cash disponible
   sans fermeture proportionnelle en \`closeRecommendations\`.
→ Ton sizing doit être réaliste : si après fermetures tu libères X $, la
   somme de tes allocations ne peut pas dépasser X + cash initial.
Principe : recycler le capital, pas accumuler au-dessus de 100 %.

## Stop-loss obligatoire à toute nouvelle ouverture
Champ \`invalidation.conditions\` doit contenir au moins une condition de prix
quantifiée (jamais juste qualitatif).

## Hard limits (priment sur tout)
Drawdown intraday > ${((config.risk_constraints as Record<string, unknown> | null)?.maxDrawdown2DaysPct ?? 10)}% : tu réduis l'exposition,
tu n'ouvres rien de neuf. Les contraintes "Risk constraints" sont absolues.

## En résumé
- Portefeuille en gain stable + thèses initiales OK → HOLD (\`theses\`: []).
- Position se dégrade → close ou rebalance.
- Opportunité VRAIMENT meilleure que l'existant → ouverture sélective.
- Jamais d'ouverture par habitude juste parce que le cycle se déclenche.
`
      : '';

    const mergedFocus = [aggressivePersona, userFocus].filter((s) => s && s.trim().length > 0).join('\n\n');

    // Récupère les positions ouvertes + cash pour gestion active
    const currentSnapshot = await this.paperBroker.computeSnapshot(portfolioId);
    const openPositionsRaw = await this.paperBroker.getPositions(portfolioId, true);

    // Pré-fetch enrichissement fondamentaux + earnings pour tous les symbols
    // ouverts (les fonctions gèrent le cache et les exclusions crypto/FX).
    const uniqueSymbols = Array.from(new Set(openPositionsRaw.map((p) => p.symbol)));
    const [earningsAll, fundamentalsArr] = await Promise.all([
      this.eodhdEnrichment.fetchEarningsForSymbols(uniqueSymbols, 14),
      Promise.all(uniqueSymbols.map((s) => this.eodhdEnrichment.fetchKeyFundamentals(s))),
    ]);
    const fundamentalsBySymbol = new Map<string, typeof fundamentalsArr[number]>();
    uniqueSymbols.forEach((s, i) => fundamentalsBySymbol.set(s, fundamentalsArr[i]));

    // P4-B — Routing sources de propositions par mode opératoire.
    // En harvest (TP 2.5% / SL 1.5%, horizon scalping intraday), on
    // court-circuite news-aggregator + sentiment retail pour ne garder
    // que rebound_tp_scanner + mechanical_stops. Économie ~600ms latence
    // + 4 calls API + risque biais narratif.
    const disciplineMode = (config.capital_discipline_mode as string | null | undefined) ?? null;
    const proposalSources = getProposalSources(disciplineMode);
    const newsActive = shouldRunNewsAggregator(disciplineMode);

    if (!newsActive) {
      this.logger.log(
        `[proposal-sources] mode=${disciplineMode ?? 'NONE'} → sources=[${proposalSources.join(',')}] (news skipped)`,
      );
      // Audit non-bloquant
      this.decisionLog.append({
        portfolioId,
        kind: 'news_aggregator_skipped_harvest_mode',
        summary: 'News pipeline skip (mode harvest = rebound-only)',
        rationale: `proposal_sources=[${proposalSources.join(',')}]`,
        payload: { discipline_mode: disciplineMode, proposal_sources: proposalSources },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.debug(`audit append failed: ${String(e).slice(0, 80)}`));
    }

    // News pipeline complet — agrégation multi-source (EODHD + StockTwits
    // + Reddit + Twitter), scoring 4 axes + convergence cross-source,
    // dédup, bucketing. Substitue le dump naïf des 10 dernières headlines
    // par un bloc analytique avec scoring détaillé par item.
    // P4-B — short-circuit en mode harvest.
    if (!newsActive) {
      // Skip block — Lisa raisonnera uniquement sur rebound + mechanical
    } else try {
      const aggregate = await this.newsAggregator.aggregate(uniqueSymbols, 30);
      if (aggregate.items.length > 0) {
        const halfLifeHours = sessionConfig.profile === 'hyper_active' ? 3
          : sessionConfig.profile === 'active_trading' || sessionConfig.profile === 'sniper_mode' ? 6
          : 12;
        const ranked = this.newsRanker.rank(aggregate.items, uniqueSymbols, halfLifeHours, 15);
        const buckets = this.newsRanker.bucket(ranked);
        const sourcesSummary = aggregate.sources
          .map((s) => `${s.provider}=${s.count}${s.ok ? '' : '✗'}`)
          .join(' ');
        marketSnapshot.newsAnalysis = `📡 Sources fetched: ${sourcesSummary} (${aggregate.elapsedMs}ms)\n\n${this.newsRanker.formatForBriefing(buckets)}`;
        // Override recentNews legacy avec uniquement les pertinentes/bruit
        // pour éviter que Claude raisonne sur des news écartées via le
        // fallback path (au cas où newsAnalysis ne serait pas exploité).
        const keep = [...buckets.relevant, ...buckets.noise].slice(0, 10);
        marketSnapshot.recentNews = keep.map((r) => ({
          headline: r.title,
          source: r.sourceDomain ?? (r.symbols.length > 0 ? r.symbols.slice(0, 3).join(', ') : 'general'),
          timestamp: r.date,
          relevance: r.scores.final >= 70 ? 'high' : r.scores.final >= 40 ? 'medium' : 'low',
          sentiment: r.sentiment,
        }));

        // P1 — re-classify le régime tactique avec le newsScore enrichi
        // + reddit spike sigma (PR E). Le sigma est null tant que l'history
        // RedditService n'a pas accumulé 10+ samples (post-redeploy).
        // NewsRanker scores 0-100, classifier seuil > 7 sur échelle 0-10
        // → on divise par 10 pour aligner. Top item = max score.final.
        const topNewsScore = ranked.length > 0 ? ranked[0].scores.final / 10 : null;
        const redditSpikeSigma = this.redditService.getSpikeSigma();

        const extras: { newsScore?: number; redditSpikeSigma?: number } = {};
        if (topNewsScore != null && Number.isFinite(topNewsScore)) {
          extras.newsScore = topNewsScore;
        }
        if (redditSpikeSigma != null && Number.isFinite(redditSpikeSigma)) {
          extras.redditSpikeSigma = redditSpikeSigma;
        }

        if (Object.keys(extras).length > 0) {
          const reclassified = await this.marketRegime.reclassifyWithExtras(extras);
          if (reclassified && marketSnapshot.tacticalRegime) {
            marketSnapshot.tacticalRegime = {
              regime: reclassified.regime,
              reasons: reclassified.reasons,
              sizingMultiplier: reclassified.sizingMultiplier,
              stopLossPct: reclassified.stopLossPct,
              takeProfitPct: reclassified.takeProfitPct,
              takeProfitLadderPct: reclassified.takeProfitLadderPct,
            };
          }
        }
      }
    } catch (e) {
      this.logger.warn(`news aggregator failure (non-blocking): ${String(e).slice(0, 200)}`);
    }

    const openPositions = await Promise.all(openPositionsRaw.map(async (pos) => {
      let currentPrice = pos.entryPrice;
      try {
        const q = await this.fetchLivePrice(pos.symbol);
        // 🛡️ Patch A : si Lisa reçoit un prix fallback, utiliser entry_price
        // au lieu (pas de PnL latent factice). Évite que Lisa génère des
        // thèses sur prix faux (ex: "GLD à 310 → close immédiat" alors que
        // le vrai prix est 430). Cf. incident 26/04 — bug fallback critique.
        if (q.source && q.source.startsWith('fallback')) {
          this.logger.warn(`[FALLBACK_GUARD_LISA] ${pos.symbol} source=${q.source} → using entry_price ${pos.entryPrice} pour thèse`);
        } else {
          currentPrice = q.price;
        }
      } catch { /* fallback entryPrice */ }
      const entryPx = new Decimal(pos.entryPrice);
      const livePx = new Decimal(currentPrice);
      const sign = pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put' ? 1 : -1;
      const unrealizedPnlPct = entryPx.isZero()
        ? 0
        : livePx.minus(entryPx).dividedBy(entryPx).mul(sign).mul(100).toNumber();
      const ageDays = Math.floor((Date.now() - new Date(pos.entryTimestamp).getTime()) / 86_400_000);
      const horizonDays = pos.horizonTargetDate
        ? Math.ceil((new Date(pos.horizonTargetDate).getTime() - new Date(pos.entryTimestamp).getTime()) / 86_400_000)
        : null;
      // Fundamentals + prochain earning pour ce symbole (si applicable)
      const fundamentals = fundamentalsBySymbol.get(pos.symbol) ?? null;
      const nextEarning = earningsAll
        .filter((e) => e.symbol.toUpperCase().includes(pos.symbol.toUpperCase().split('.')[0]))
        .sort((a, b) => new Date(a.reportDate).getTime() - new Date(b.reportDate).getTime())[0] ?? null;

      return {
        positionId: pos.id,
        symbol: pos.symbol,
        assetClass: pos.assetClass,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        currentPrice,
        quantity: pos.quantity,
        entryNotionalUsd: pos.entryNotionalUsd,
        unrealizedPnlPct,
        ageDays,
        horizonDays,
        fundamentals,
        nextEarning,
      };
    }));

    // Lisa v2 — portfolio trajectory optimizer : on lit les objectifs de
    // la config session et on calcule les métriques historiques avant de
    // lancer Claude, pour que le bloc # MISSION soit complet.
    const objectives: PerformanceObjectives = {
      returnTargetDailyPct: config.return_target_daily_pct !== null && config.return_target_daily_pct !== undefined
        ? Number(config.return_target_daily_pct) : null,
      returnTargetMonthlyPct: config.return_target_monthly_pct !== null && config.return_target_monthly_pct !== undefined
        ? Number(config.return_target_monthly_pct) : null,
      returnTargetAnnualPct: config.return_target_annual_pct !== null && config.return_target_annual_pct !== undefined
        ? Number(config.return_target_annual_pct) : null,
      dailyCostBudgetUsd: config.daily_cost_budget_usd !== null && config.daily_cost_budget_usd !== undefined
        ? Number(config.daily_cost_budget_usd) : null,
      performanceHorizonDays: Number(config.performance_horizon_days ?? 30),
    };

    const historyMetrics = await this.computeHistoryMetrics(portfolioId);
    const { status: trajectoryStatus, targetExtrapolatedPct: targetExtrapolated7dPct } =
      this.computeTrajectoryStatus(objectives, historyMetrics);

    // Fetch les indicateurs techniques + bougies intraday 5m pour chaque
    // position ouverte en parallèle — permet à Lisa de décider quand
    // clôturer (RSI overbought, ATR spike, MACD bearish cross) et à l'agent
    // de dimensionner les stops ATR-based, et donne une vue réelle du
    // price action (20 bougies 5m = 1h40 de contexte).
    const technicalBySymbol: Record<string, import('./eodhd-technical.service').TechnicalIndicators> = {};
    const intradayBySymbol: Record<string, string> = {}; // symbol → résumé texte
    const insiderLines: string[] = [];
    const optionsLines: string[] = [];
    const liquidationsLines: string[] = [];
    if (openPositions.length > 0) {
      await Promise.all(openPositions.flatMap((pos) => {
        const eodhdTicker = this.toEodhdTicker(pos.symbol);
        const currentPrice = Number(pos.currentPrice);
        const isCrypto = pos.assetClass?.toLowerCase().includes('crypto');
        const isEquity = pos.assetClass?.toLowerCase().includes('equit') || pos.assetClass?.toLowerCase().includes('stock');
        const tasks: Promise<unknown>[] = [
          this.eodhdTechnical.getIndicators(eodhdTicker, currentPrice)
            .then((ind) => { technicalBySymbol[pos.symbol] = ind; })
            .catch((e) => this.logger.debug(`tech indicators failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
        ];
        if (isCrypto) {
          // Crypto → Binance direct (plus frais que EODHD + 24h stats gratuit)
          tasks.push(
            this.binanceMarket.summarize(pos.symbol)
              .then((s) => { if (s) intradayBySymbol[pos.symbol] = s; })
              .catch((e) => this.logger.debug(`binance summary failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
            this.binanceLiquidations.getSnapshot(pos.symbol)
              .then((snap) => {
                const line = this.binanceLiquidations.summarize(snap);
                if (line) liquidationsLines.push(line);
              })
              .catch((e) => this.logger.debug(`liquidations failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
          );
        } else {
          tasks.push(
            // PR #353 — router dual-call (TD + EODHD) si flag ON, EODHD only sinon.
            this.intradayRouter.getCandles(eodhdTicker, '5m', 20, { calledBy: 'lisa_summarize' })
              .then((series) => {
                if (series) intradayBySymbol[pos.symbol] = this.eodhdIntraday.summarize(series);
              })
              .catch((e) => this.logger.debug(`intraday fetch failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
          );
          if (isEquity) {
            tasks.push(
              this.eodhdInsider.getInsiderSignal(pos.symbol, 30)
                .then((sig) => {
                  const line = this.eodhdInsider.summarize(sig);
                  if (line) insiderLines.push(`${pos.symbol} ${line}`);
                })
                .catch((e) => this.logger.debug(`insider failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
              this.eodhdOptions.getSnapshot(pos.symbol)
                .then((snap) => {
                  const line = this.eodhdOptions.summarize(snap);
                  if (line) optionsLines.push(line);
                })
                .catch((e) => this.logger.debug(`options failed for ${pos.symbol}: ${String(e).slice(0, 80)}`)),
            );
          }
        }
        return tasks;
      }));

      if (insiderLines.length > 0) marketSnapshot.insiderSignals = insiderLines.join('\n');
      if (optionsLines.length > 0) marketSnapshot.optionsSignals = optionsLines.join('\n');
      if (liquidationsLines.length > 0) marketSnapshot.liquidationsSignals = liquidationsLines.join('\n');
    }

    // Earnings calendar pour les positions equity ouvertes (skip les
    // crypto/FX/ETF via filtre interne du service). Évite que Lisa propose
    // une thèse equity dont l'horizon couvre un earnings imminent
    // (event binaire) — coût Claude payé pour rien si mechanical rejette.
    const earningsBySymbol: Record<string, string | null> = {};
    if (openPositions.length > 0) {
      await Promise.all(
        openPositions.map(async (pos) => {
          const next = await this.eodhdCalendar
            .getNextEarningsDate(pos.symbol, 30)
            .catch(() => null);
          if (next) earningsBySymbol[pos.symbol] = next;
        }),
      );
    }

    // Phase 3 : injecte la mémoire Lisa (décisions passées par regime) dans
    // le briefing. Le regime courant pris comme proxy = dernier regime
    // détecté sur ce portefeuille (ou null si premier cycle).
    const { data: lastProposal } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('detected_regime')
      .eq('portfolio_id', portfolioId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastRegime = (lastProposal?.detected_regime as string | null) ?? null;
    marketSnapshot.lisaMemory = await this.lisaMemory
      .getMemoryBriefing(portfolioId, lastRegime, 30)
      .catch(() => '(mémoire indisponible)');

    // Phase 5 : edge confirmé contextuel (stats sur trades fermés).
    // Utilise le VIX live pour le bucket courant + les symboles candidats
    // qui pourraient être dans les thèses (positions tenues + symboles
    // évoqués récemment dans le briefing).
    const candidateSymbols = Array.from(new Set([
      ...uniqueSymbols, // positions actuellement tenues
      // Note : on pourrait aussi inclure les symboles des thèses précédentes
      // mais les positions tenues sont le signal le plus fort.
    ]));
    const liveVix = marketSnapshot.vix ?? null;
    marketSnapshot.performanceAnalytics = await this.performanceAnalytics
      .getContextualEdge(portfolioId, lastRegime, liveVix, candidateSymbols, 30)
      .catch(() => '(analytics indisponibles)');

    // DAILY_HARVEST Phase 3 — construit le contexte si mode actif.
    // Inerte (undefined) si capital_discipline_mode != 'DAILY_HARVEST'.
    const dailyHarvestContext = await this.buildDailyHarvestContext(portfolioId)
      .catch((e) => {
        this.logger.warn(`buildDailyHarvestContext failed: ${String(e).slice(0, 100)}`);
        return undefined;
      });

    // BOT LAB Phase 4 — bloc patterns adoptés (SUGGEST/ENFORCE).
    // Empty string si aucune adoption active sur ce portfolio.
    const adoptedPatternsBriefing = await this.patternBriefing.getBriefingBlock(portfolioId)
      .catch((e) => {
        this.logger.warn(`getBriefingBlock failed: ${String(e).slice(0, 100)}`);
        return '';
      });

    // P0-A — Lecture per-cycle de la config budget Claude depuis
    // lisa_session_configs. Permet à l'UI de remonter le budget (ex.
    // $20 → $50) sans redéployer (cf. incident 28/04 05:02 UTC où le
    // router lisait l'env var statique au lieu de la config DB).
    // - daily_cost_budget_usd : budget cumulé en USD (null = pas d'override,
    //   le router applique sa config constructor / env LLM_ROUTER_DAILY_BUDGET_USD)
    // - cost_force_continue : à 100% du budget, soft warn + continue Opus
    //   (true, default DB via migration 0074, ADR-001 Phase 2 — plus de
    //   fallback Haiku) ou hard throw (false, mode strict)
    const budgetOverride = config.daily_cost_budget_usd != null
      ? Number(config.daily_cost_budget_usd)
      : undefined;
    const forceContinueOverride = (config as Record<string, unknown>).cost_force_continue;
    const forceContinue = typeof forceContinueOverride === 'boolean'
      ? forceContinueOverride
      : true; // default DB true (migration 0074) — fail-soft par défaut

    let result: Awaited<ReturnType<ThesisGeneratorService['generateTheses']>>;
    try {
      result = await this.thesisGenerator.generateTheses({
        config: sessionConfig,
        marketSnapshot,
        ...(mergedFocus ? { userFocus: mergedFocus } : {}),
        includeFullCorpus: true,
        openPositions,
        availableCashUsd: currentSnapshot.cashUsd,
        objectives,
        historyMetrics,
        trajectoryStatus,
        targetExtrapolated7dPct,
        technicalBySymbol,
        intradayBySymbol,
        earningsBySymbol,
        ...(dailyHarvestContext ? { dailyHarvestContext } : {}),
        ...(adoptedPatternsBriefing ? { adoptedPatternsBriefing } : {}),
        ...(budgetOverride != null ? { budgetUsd: budgetOverride } : {}),
        forceContinue,
      });
    } catch (e) {
      // Parse failure ou erreur Claude : on log dans le decision log et on
      // retourne une erreur 400 explicite avec contexte lisible (pas un 500
      // qui fait croire à une panne d'infra).
      const msg = e instanceof Error ? e.message : String(e);

      // Détection spéciale : crédit Anthropic épuisé. Messages typiques :
      //   "credit_balance_too_low"
      //   "invalid_request_error" + "credit"
      //   HTTP 400 avec type "invalid_request_error"
      const isCreditExhausted = /credit.*too.?low|insufficient.*credit|credit.*balance/i.test(msg)
        || /\b400\b.*invalid_request_error.*credit/i.test(msg);

      if (isCreditExhausted) {
        // P19c — pause REVERSIBLE (pattern P8-BR), pas désactivation. L'autopilot
        // reste `enabled=true` mais `autopilot_paused_reason='ANTHROPIC_CREDIT_EXHAUSTED'`
        // → maybeResumeOrSkip skip ce cycle silencieusement. Quand le crédit est
        // rechargé sur console.anthropic.com, l'utilisateur peut reset le paused_reason
        // (UI badge "Anthropic indispo, reprendre") OU le prochain cycle Lisa qui
        // réussit clear automatiquement le flag.
        // Avant P19c (29/04/2026 12:03 UTC, observé en prod) : autopilot_enabled
        // flipait à false → autopilot OFFLINE silencieusement, intervention manuelle
        // requise. Cassait la promesse de continuité de service Lisa.
        await this.supabase.getClient()
          .from('lisa_session_configs')
          .update({
            autopilot_paused_reason: 'ANTHROPIC_CREDIT_EXHAUSTED',
          })
          .eq('portfolio_id', portfolioId);

        await this.logDecision(portfolioId, 'anthropic_credit_exhausted', {
          summary: '⚠️ Crédit Anthropic épuisé — autopilot mis en pause (réversible)',
          rationale: `Erreur API reçue : ${msg.slice(0, 500)}. autopilot_paused_reason=ANTHROPIC_CREDIT_EXHAUSTED (autopilot_enabled reste true). Recharger le crédit sur console.anthropic.com — la pause sera levée au prochain cycle Lisa qui réussit. P19c risk-resilience.`,
          payload: { source: 'thesis_generator', errorType: 'credit_exhausted', paused_reason: 'ANTHROPIC_CREDIT_EXHAUSTED' },
          triggeredBy: 'risk_monitor',
        });

        throw new BadRequestException(
          `⚠️ CRÉDIT ANTHROPIC ÉPUISÉ — L'autopilot a été mis en pause (réversible). Recharge le crédit sur console.anthropic.com — la pause se lèvera automatiquement au prochain cycle qui réussit.`,
        );
      }

      await this.logDecision(portfolioId, 'proposal_failed', {
        summary: 'Génération proposition échouée',
        rationale: msg.slice(0, 2000),
        payload: { source: 'thesis_generator' },
        triggeredBy: 'user_manual',
      });
      throw new BadRequestException(
        `Lisa n'a pas pu produire une proposition exploitable (${msg.slice(0, 150)}). Réessaie dans un instant — les parse failures Claude sont rares et transitoires.`,
      );
    }

    // P19c — Path success : si une pause `ANTHROPIC_CREDIT_EXHAUSTED` était
    // active, c'est que le crédit vient d'être rechargé (la nouvelle tentative
    // a réussi). Clear silently. Pas une dépendance circulaire car on update
    // directement la table sans passer par lisa-autopilot.service.
    await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({ autopilot_paused_reason: null })
      .eq('portfolio_id', portfolioId)
      .eq('autopilot_paused_reason', 'ANTHROPIC_CREDIT_EXHAUSTED')
      .then(({ error, data }) => {
        if (!error && data) {
          this.logger.log(
            `[autopilot:resumed] portfolio=${portfolioId.slice(0, 8)} reason=anthropic_credit_restored`,
          );
        }
      });

    // Enforce risk constraints (structural safety net)
    // Calcule l'exposition AGRÉGÉE par classe des positions DÉJÀ TENUES
    // pour que le check ASSET_CLASS_CONCENTRATION prenne en compte
    // l'existant + les nouvelles allocations (fix 26/04 : précieux à 40%
    // sur 2 ouvertures successives chacune <28% mais cumul ignoré).
    const existingExposureByAssetClassPct: Record<string, number> = {};
    const capitalNum = Number(sessionConfig.capitalUsd) || 10000;
    for (const pos of openPositionsRaw) {
      const cls = String((pos as unknown as Record<string, unknown>)['asset_class'] ?? pos.assetClass ?? '').toLowerCase();
      if (!cls) continue;
      const notional = Number((pos as unknown as Record<string, unknown>)['entry_notional_usd'] ?? pos.entryNotionalUsd ?? 0);
      const pct = capitalNum > 0 ? (notional / capitalNum) * 100 : 0;
      existingExposureByAssetClassPct[cls] = (existingExposureByAssetClassPct[cls] ?? 0) + pct;
    }
    // P1 — Régime tactique : applique sizingMultiplier sur les allocations
    // AVANT les checks de cap. Lit le régime cached par MarketRegimeService
    // (pas de re-fetch — le snapshot a déjà classifié post-fetchMarketSnapshot
    // et possiblement re-classifié post-news ranking).
    const cachedRegime = this.marketRegime.peekCurrentRegime();
    const regimeSizing = cachedRegime
      ? {
          multiplier: cachedRegime.sizingMultiplier,
          regime: cachedRegime.regime,
          reason: cachedRegime.reasons.join(' · ').slice(0, 200),
        }
      : undefined;

    const enforcement = this.riskEnforcer.enforce(
      result.proposal,
      existingExposureByAssetClassPct,
      undefined, // existingExposureByThemePct (PATCH 3 — non câblé encore)
      regimeSizing,
    );
    const finalProposal = enforcement.adjustedProposal ?? result.proposal;

    if (!enforcement.adjustedProposal) {
      throw new BadRequestException(`Proposal rejected by risk enforcer: ${enforcement.summary}`);
    }

    // Persist proposal
    // Snapshot des inputs marché pour MaterialChangeDetector (event-driven)
    // Capturé EN ASYNC pour ne pas bloquer la réponse Lisa.
    const detectedInputsSnapshot = await this.materialDetector
      .captureCurrentInputs(portfolioId, uniqueSymbols)
      .catch(() => null);

    await this.supabase.getClient().from('lisa_proposals').insert({
      id: finalProposal.id,
      user_id: userId,
      portfolio_id: portfolioId,
      capital_usd: finalProposal.capitalUsd,
      base_currency: finalProposal.baseCurrency,
      detected_regime: finalProposal.detectedRegime,
      market_momentum: finalProposal.marketMomentum,
      regime_summary: finalProposal.regimeSummary,
      favored_pockets: finalProposal.favoredPockets,
      avoided_pockets: finalProposal.avoidedPockets,
      theses: finalProposal.theses,
      allocations: finalProposal.allocations,
      cash_reserve_pct: finalProposal.cashReservePct,
      portfolio_risk_lens: finalProposal.portfolioRiskLens,
      constraints_used: finalProposal.constraints,
      warnings: [...finalProposal.warnings, ...enforcement.violations.map((v) => v.message)],
      status: 'proposed',
      claude_model: result.claudeMeta.model,
      claude_input_tokens: result.claudeMeta.inputTokens,
      claude_output_tokens: result.claudeMeta.outputTokens,
      claude_cost_usd: result.costUsd,
      generated_at: finalProposal.generatedAt,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h validity
      close_recommendations: result.closeRecommendations ?? [],
      detected_inputs: detectedInputsSnapshot
        ? { ...detectedInputsSnapshot, freshHighScoreNews: undefined } // exclude verbose news from snapshot
        : null,
    });

    // PATCH 4 — UPSERT api_costs_daily (running total + breakdown by model).
    // Fire-and-forget — ne bloque jamais le flow generateProposal.
    this.apiCostTracker
      .recordApiCost(result.claudeMeta.model, result.costUsd)
      .catch((e) => this.logger.debug(`recordApiCost failed: ${String(e).slice(0, 100)}`));

    // Decision log
    await this.logDecision(portfolioId, 'proposal_generated', {
      summary: `Lisa generated ${finalProposal.theses.length} theses, regime=${finalProposal.detectedRegime}`,
      rationale: finalProposal.regimeSummary,
      payload: { proposalId: finalProposal.id, costUsd: result.costUsd },
      triggeredBy: 'user_manual',
    });

    // P5-LLM-THESES — Visibilité : Lisa a retourné theses=[] alors que
    // l'utilisateur a explicité des scénarios. Indique un problème de prompt
    // (Lisa "se protège" en regime=neutral). Persona block 05 a été
    // renforcé pour exiger ≥1 thèse — ce log capture les cas restants
    // pour analyse + tuning futur.
    if (finalProposal.theses.length === 0 && userFocus && !this.isAutopilotGenericFocus(userFocus)) {
      await this.logDecision(portfolioId, 'proposal_rejected', {
        summary: `Empty theses despite explicit user focus (${userFocus.slice(0, 80)})`,
        rationale: `gate=empty_theses_with_user_focus · Lisa a retourné theses=[] alors que userFocus n'est PAS le focus autopilot générique. Vérifier persona block 05-profile-overrides + tuning prompt. regime=${finalProposal.detectedRegime}.`,
        payload: {
          proposalId: finalProposal.id,
          theses_count: 0,
          regime: finalProposal.detectedRegime,
          user_focus_excerpt: userFocus.slice(0, 200),
          gate: 'empty_theses_with_user_focus',
        },
        triggeredBy: 'user_manual',
      }).catch(() => null);
    }

    // Écrire la directive mécanique — l'agent sans-LLM l'utilise pendant 35 min
    await this.writeDirective(portfolioId, finalProposal, result.closeRecommendations ?? [], trajectoryStatus, config.profile as SessionProfile).catch(
      (e) => this.logger.warn(`writeDirective failed (non-blocking): ${String(e)}`),
    );

    return finalProposal;
  }

  /**
   * Extrait et persiste une directive mécanique depuis la proposal Claude.
   * L'agent MechanicalTradingService consomme cette directive toutes les minutes
   * pour ouvrir/fermer des positions sans appel LLM.
   */
  private async writeDirective(
    portfolioId: string,
    proposal: AllocationProposal,
    closeRecommendations: Array<{ positionId: string; reason: string }>,
    trajectoryStatus: TrajectoryStatus | null,
    profile: SessionProfile,
  ): Promise<void> {
    // Extraire les thèmes depuis favored_pockets
    const activeThemes = proposal.favoredPockets.map((p) => p.assetClass);
    const favoredAssetClasses = [...new Set(proposal.favoredPockets.map((p) => p.assetClass))];
    const avoidedAssetClasses = [...new Set(proposal.avoidedPockets.map((p) => p.assetClass))];

    const isHyperActive = profile === 'hyper_active';

    // Posture de risque : trajectoire PRIME sur momentum
    //  - HORS_TRAJECTOIRE → defensive (protège le capital, pas de nouvelles ouvertures)
    //    SAUF si profile=hyper_active : l'utilisateur a explicitement choisi
    //    haute fréquence + cible ambitieuse — defensive paralyserait tout.
    //    On passe alors en 'aggressive' pour forcer le rattrapage actif.
    //  - EN_RETARD + momentum bullish → aggressive (rattrape le retard)
    //  - EN_AVANCE → normal (pas besoin de forcer)
    //  - DANS_LE_PLAN → basé sur momentum
    let riskPosture: 'aggressive' | 'normal' | 'defensive';
    if (trajectoryStatus === 'HORS_TRAJECTOIRE') {
      riskPosture = isHyperActive ? 'aggressive' : 'defensive';
    } else if (trajectoryStatus === 'EN_RETARD' && proposal.marketMomentum !== 'bearish') {
      riskPosture = 'aggressive';
    } else if (trajectoryStatus === 'EN_AVANCE') {
      riskPosture = 'normal';
    } else {
      riskPosture =
        proposal.marketMomentum === 'bullish_strong' ? 'aggressive' :
        proposal.marketMomentum === 'bearish' ? 'defensive' : 'normal';
    }

    // Construire target_symbols depuis les thèses + allocations.
    //
    // Si l'expression Lisa choisit une direction `long_call` ou `long_put`,
    // on injecte un optionStructure avec defaults raisonnables (DTE 14,
    // OTM 2%, IV 0.30). Le mechanical-trading routera vers OptionBroker
    // si enable_derivatives=true. Sinon, fallback equity classique.
    const targetSymbols = proposal.theses.flatMap((thesis) => {
      const alloc = proposal.allocations.find((a) => a.thesisId === thesis.id);
      if (!alloc) return [];
      const expr = thesis.expressions[thesis.preferredExpressionIndex];
      if (!expr) return [];

      // PR #249 — `thesis.riskReward` est undefined dans les thèses générées
      // par le scanner top-gainers (qui ne peuple que stopLossPct/takeProfitPct
      // sur l'expression, pas un objet riskReward complet). Sans `?.`, ouverture
      // crashe `Cannot read properties of undefined (reading 'adverseScenarioReturnPct')`
      // → 100% des candidats Asia/US crash silencieusement → 0 position ouverte.
      const stopPct = Math.abs(thesis.riskReward?.adverseScenarioReturnPct ?? 2);
      const tpPct = thesis.riskReward?.centralScenarioReturnPct?.mid ?? stopPct * 2;
      const horizonDays = thesis.riskReward?.horizonDays ?? 3;

      const isOptionLong = expr.direction === 'long_call' || expr.direction === 'long_put';
      const direction: 'long' | 'short' = isOptionLong
        ? expr.direction === 'long_call' ? 'long' : 'short'
        : (expr.direction === 'long' || expr.direction === 'short' ? expr.direction : 'long');

      return [{
        symbol: expr.symbol,
        assetClass: expr.assetClass,
        direction,
        stopLossPct: Math.max(stopPct, 0.5),
        takeProfitPct: Math.max(tpPct, 0.5),
        convictionScore: Math.round(thesis.confidenceScore / 10),
        horizonDays,
        venue: expr.preferredVenue,
        thesisId: thesis.id,
        // PATCH 5 — propage thesisKind au mécanique pour multiplicateur ATR
        ...(thesis.kind ? { thesisKind: thesis.kind } : {}),
        ...(isOptionLong
          ? {
              optionStructure: {
                strikeOtmPct: 2,                              // ATM+2% par défaut
                dteDays: Math.max(7, Math.min(45, horizonDays * 3)), // DTE = ~3× horizon, borné [7, 45]
                iv: 0.30,                                     // IV constante
              },
            }
          : {}),
      }];
    });

    // close_conditions depuis les closeRecommendations de Lisa
    const closeConditions = closeRecommendations.map((r) => ({
      positionId: r.positionId,
      reason: r.reason,
      urgency: 'immediate' as const,
    }));

    const validUntil = new Date(Date.now() + 35 * 60_000).toISOString();

    // Parser les warnings [AGENT] {...} → tactical_overrides JSON
    // (format strict : une ligne, JSON valide strict après le préfixe)
    const tacticalOverrides = this.parseAgentDirectives(proposal.warnings ?? []);

    const { error } = await this.supabase.getClient()
      .from('lisa_mechanical_directives')
      .insert({
        portfolio_id: portfolioId,
        market_momentum: proposal.marketMomentum ?? 'neutral',
        trajectory_status: trajectoryStatus ?? 'DANS_LE_PLAN',
        active_themes: activeThemes,
        favored_asset_classes: favoredAssetClasses,
        avoided_asset_classes: avoidedAssetClasses,
        target_symbols: targetSymbols,
        close_conditions: closeConditions,
        risk_posture: riskPosture,
        tactical_overrides: tacticalOverrides,
        source_proposal_id: proposal.id,
        generated_at: new Date().toISOString(),
        valid_until: validUntil,
      });

    if (error) {
      // Log all directive write errors with enough context to diagnose migration issues
      this.logger.warn(`writeDirective DB error: ${error.message} — apply migrations 0051/0053 if missing columns`);
      return;
    }

    // Purger les directives > 2h pour ce portfolio
    void this.supabase.getClient()
      .from('lisa_mechanical_directives')
      .delete()
      .eq('portfolio_id', portfolioId)
      .lt('generated_at', new Date(Date.now() - 2 * 3_600_000).toISOString());

    this.logger.log(`Directive mécanique écrite — ${targetSymbols.length} symboles cibles, validité 35 min${
      Object.keys(tacticalOverrides).length > 0 ? `, overrides: ${Object.keys(tacticalOverrides).join(',')}` : ''
    }`);
  }

  /**
   * Parse les warnings préfixés [AGENT] {...} en un objet tactical_overrides
   * strict. Les entrées malformées ou avec clés inconnues sont ignorées
   * silencieusement (fail-safe : l'agent fonctionne toujours sur les défauts).
   *
   * Clés acceptées :
   *  - pauseOpens: boolean
   *  - pauseOpensReason: enum ('stops_cluster'|'vix_spike'|'drawdown'|'exposure_high'|'choppiness'|'regime_break')
   *  - tightenStopsMultiplier: number (borné [0.3, 2.0])
   *  - minConvictionOverride: number (borné [0, 10])
   *  - maxNewOpensOverride: number (borné [0, 10])
   *  - closeLowestConvictionIfExposureAbovePct: number (borné [0, 100])
   *  - preferredAssetClasses: string[]
   */
  private parseAgentDirectives(warnings: string[]): Record<string, unknown> {
    const agentRe = /^\[AGENT\]\s*(\{.*\})\s*$/s;
    const VALID_REASONS = new Set(['stops_cluster', 'vix_spike', 'drawdown', 'exposure_high', 'choppiness', 'regime_break']);
    const out: Record<string, unknown> = {};

    for (const w of warnings) {
      const m = agentRe.exec(w.trim());
      if (!m) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1]);
      } catch (e) {
        this.logger.warn(`[AGENT] JSON invalide, ignoré: ${m[1].slice(0, 120)}`);
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const p = parsed as Record<string, unknown>;

      if (typeof p.pauseOpens === 'boolean') out.pauseOpens = p.pauseOpens;
      if (typeof p.pauseOpensReason === 'string' && VALID_REASONS.has(p.pauseOpensReason)) {
        out.pauseOpensReason = p.pauseOpensReason;
      }
      if (typeof p.tightenStopsMultiplier === 'number' && Number.isFinite(p.tightenStopsMultiplier)) {
        out.tightenStopsMultiplier = Math.max(0.3, Math.min(2.0, p.tightenStopsMultiplier));
      }
      if (typeof p.minConvictionOverride === 'number' && Number.isFinite(p.minConvictionOverride)) {
        out.minConvictionOverride = Math.max(0, Math.min(10, Math.round(p.minConvictionOverride)));
      }
      if (typeof p.maxNewOpensOverride === 'number' && Number.isFinite(p.maxNewOpensOverride)) {
        out.maxNewOpensOverride = Math.max(0, Math.min(10, Math.round(p.maxNewOpensOverride)));
      }
      if (typeof p.closeLowestConvictionIfExposureAbovePct === 'number' && Number.isFinite(p.closeLowestConvictionIfExposureAbovePct)) {
        out.closeLowestConvictionIfExposureAbovePct = Math.max(0, Math.min(100, p.closeLowestConvictionIfExposureAbovePct));
      }
      if (Array.isArray(p.preferredAssetClasses) && p.preferredAssetClasses.every((x) => typeof x === 'string')) {
        out.preferredAssetClasses = p.preferredAssetClasses;
      }
    }

    return out;
  }

  async approveProposal(userId: string, proposalId: string): Promise<{ openedPositions: PaperPosition[]; skipped: number; closedRecommended: number }> {
    const { data: proposal, error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*')
      .eq('id', proposalId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !proposal) throw new NotFoundException('Proposal introuvable');
    if (proposal.status !== 'proposed') {
      throw new BadRequestException(`Proposal status = ${proposal.status}, cannot approve`);
    }

    const portfolioId = proposal.portfolio_id as string;

    // 🛡️ Patch C : kill-switch étanche.
    // Si l'utilisateur a cliqué Emergency Stop entre la génération de la
    // proposition et son approbation (auto ou manuelle), on refuse toute
    // action. Sinon une proposition générée juste avant le kill-switch
    // peut continuer à fermer/ouvrir des positions et rendre le stop
    // d'urgence non étanche.
    const { data: killCheck } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('kill_switch_active')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    if (killCheck?.kill_switch_active === true) {
      this.logger.warn(`[KILL_SWITCH_GUARD] approveProposal ${proposalId} refusé — kill_switch_active=true sur portfolio ${portfolioId.slice(0, 8)}`);
      await this.logDecision(portfolioId, 'proposal_skipped_kill_switch', {
        summary: 'Proposition refusée — kill-switch actif',
        rationale: 'Garde-fou : aucune action après Emergency Stop. Désactiver le kill-switch dans la config pour reprendre.',
        payload: { proposalId },
        triggeredBy: 'system',
      });
      // On ne lève pas d'erreur (le caller autopilot ne doit pas crash).
      // On retourne un résultat "rien fait" cohérent.
      return { openedPositions: [], skipped: 0, closedRecommended: 0 };
    }
    const theses = proposal.theses as Array<Record<string, unknown>>;
    const allocationsRaw = proposal.allocations as Array<{ thesisId: string; pctCapital: number; amountUsd: string }>;

    // P5-LLM-THESES — Guard : refuser explicitement les proposals à theses=[].
    // Avant ce guard, l'UI cliquait "Approuver" sur une proposal vide et
    // recevait silencieusement openedPositions=[] avec un toast "positions
    // ouvertes" trompeur. Maintenant 400 explicite + audit decision_log.
    if (!Array.isArray(theses) || theses.length === 0) {
      await this.logDecision(portfolioId, 'proposal_rejected', {
        summary: `Proposal ${proposalId.slice(0, 8)} : theses=[] — aucune action`,
        rationale: `gate=empty_theses · Lisa a généré 0 thèse tradeable. Vérifier le user focus / scénarios envoyés au LLM. UI ne devrait pas afficher "positions ouvertes" sur une proposal vide.`,
        payload: { proposal_id: proposalId, theses_count: 0, gate: 'empty_theses' },
        triggeredBy: 'user_manual',
      }).catch(() => null);
      throw new BadRequestException(
        'Aucune thèse à exécuter dans cette proposition. Régénérer avec scénarios concrets ou attendre prochain cycle.',
      );
    }
    const closeRecommendations = (proposal.close_recommendations as Array<{ positionId: string; reason: string }> | null) ?? [];
    const marketMomentum = (proposal.market_momentum as 'bullish_strong' | 'neutral' | 'bearish' | null) ?? 'neutral';

    // Stop-loss plus serré si le portefeuille est en mode agressif (chasseuse EV+)
    // + cap d'ouvertures par cycle modulé par le marketMomentum.
    const { data: sessionCfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const aggressive = sessionCfg?.autopilot_aggressive === true;

    // Cap effectif par régime. Base vient du config (default 2).
    // Appliqué UNIQUEMENT en mode autopilot (auto_approve) pour ne pas
    // restreindre les approbations manuelles volontaires de l'utilisateur.
    const capBase = Math.max(1, Math.min(7, Number(sessionCfg?.autopilot_max_opens_per_cycle ?? 2)));
    const autopilotActive = sessionCfg?.autopilot_enabled === true && sessionCfg?.autopilot_auto_approve === true;
    let effectiveCap = allocationsRaw.length;
    if (autopilotActive) {
      if (marketMomentum === 'bullish_strong') effectiveCap = capBase * 2;
      else if (marketMomentum === 'bearish') effectiveCap = Math.max(1, Math.floor(capBase / 2));
      else effectiveCap = capBase;
    }

    // On garde les N allocations à plus haute conviction (pctCapital desc
    // = sizing Claude, proxy de sa conviction relative). Les rejetées sont
    // loggées pour traçabilité.
    const allocations = allocationsRaw.length > effectiveCap
      ? [...allocationsRaw].sort((a, b) => b.pctCapital - a.pctCapital).slice(0, effectiveCap)
      : allocationsRaw;
    const cappedOut = allocationsRaw.length - allocations.length;
    if (cappedOut > 0) {
      const keptIds = new Set(allocations.map((a) => a.thesisId));
      const rejected = allocationsRaw.filter((a) => !keptIds.has(a.thesisId));
      await this.logDecision(portfolioId, 'proposal_capped_by_cycle_limit', {
        summary: `Cap d'ouvertures : ${cappedOut} thèse(s) écartée(s) ce cycle (momentum=${marketMomentum}, cap=${effectiveCap})`,
        rationale: `Garde-fou anti-burst : le cycle ne peut pas ouvrir plus de ${effectiveCap} position(s) selon le momentum détecté. Les thèses écartées sont les moins sized par Claude. Le prochain cycle (après cooldown) pourra les reprendre si elles restent pertinentes.`,
        payload: { marketMomentum, effectiveCap, capBase, rejectedThesisIds: rejected.map((a) => a.thesisId) },
        triggeredBy: 'user_manual',
      });
    }

    // 1. D'abord on exécute les fermetures recommandées par Lisa — libère du
    //    cash avant d'ouvrir les nouvelles positions.
    let closedRecommended = 0;
    const openPositions = await this.paperBroker.getPositions(portfolioId, true);
    for (const rec of closeRecommendations) {
      const pos = openPositions.find((p) => p.id === rec.positionId);
      if (!pos) {
        this.logger.warn(`Close rec skipped — position ${rec.positionId} non trouvée ou déjà fermée`);
        continue;
      }
      try {
        const quote = await this.fetchLivePrice(pos.symbol);
        // 🛡️ Bug #M Part 3 (#C5) — skip si quote fallback corrompu : ne pas
        // fermer sur un prix sentinel '0'. La recommandation Lisa sera
        // ré-évaluée au prochain cycle quand un prix fiable sera disponible.
        if (quote.source && quote.source.startsWith('fallback')) {
          this.logger.warn(
            `[FALLBACK_GUARD_LISA] close recommendation ${pos.symbol} skip — source=${quote.source}`,
          );
          continue;
        }
        // 🛡️ Bug #R5 — gap zéro NON-FALLBACK + ratio sanity bounds : la garde
        // #C5 ne checkait QUE la source. Un prix 0/NaN/Infinity (glitch EODHD
        // non-sentinel) OU hors [0.5x, 2.0x] de l'entry passait → close à un
        // prix corrompu. On rejette quelle que soit la source.
        const recPriceNum = parseFloat(quote.price);
        const recEntryNum = parseFloat(pos.entryPrice);
        const recRatio = Number.isFinite(recEntryNum) && recEntryNum > 0
          ? recPriceNum / recEntryNum
          : 1;
        if (!Number.isFinite(recPriceNum) || recPriceNum <= 0 || recRatio < 0.5 || recRatio > 2.0) {
          this.logger.warn(
            `[FALLBACK_GUARD_LISA] close recommendation ${pos.symbol} skip — ` +
            `livePrice ${quote.price} invalide ou hors sanity bounds [0.5x, 2.0x] (entry=${pos.entryPrice})`,
          );
          continue;
        }
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_invalidated',
          livePrice: quote.price,
          rationale: `Lisa recommendation: ${rec.reason}`.slice(0, 500),
        });
        // Phase 5 — capture outcome
        this.tradeOutcomeRecorder.recordOutcome(pos.id, quote.price, 'closed_invalidated')
          .catch(() => null);
        closedRecommended++;
        await this.logDecision(portfolioId, 'position_closed_by_lisa', {
          summary: `Lisa closed ${pos.symbol} (${pos.id.slice(0, 8)}): ${rec.reason}`.slice(0, 200),
          rationale: rec.reason,
          payload: { positionId: pos.id, symbol: pos.symbol },
          triggeredBy: 'user_manual',
        });
      } catch (e) {
        this.logger.warn(`Close recommendation failed for ${pos.symbol}: ${String(e)}`);
      }
    }

    // 1bis. Cooldown check — bloque les nouvelles ouvertures si une position
    // vient d'être ouverte récemment ET que le momentum n'est pas bullish_strong.
    // Bullish_strong bypasse le cooldown pour garder la réactivité maximale
    // en fenêtre haussière confirmée. Ne s'applique qu'en mode autopilot.
    // Les fermetures ont déjà été exécutées ci-dessus : elles ne sont jamais
    // bloquées par le cooldown.
    const opened: PaperPosition[] = [];
    let skipped = 0;
    let cooldownSkipped = false;

    if (autopilotActive && marketMomentum !== 'bullish_strong' && allocations.length > 0) {
      // Default cooldown : 5 min en hyper_active (cadence haute fréquence
      // explicite), 15 min sinon. L'utilisateur peut surcharger via
      // autopilot_opening_cooldown_minutes côté config.
      // En hyper_active, on CAP le cooldown à 5 min même si l'utilisateur
      // a configuré plus haut — la valeur explicite ne doit pas saboter
      // la cadence du profil.
      const cooldownDefault = sessionCfg?.profile === 'hyper_active' ? 5 : 15;
      const cooldownConfigured = Number(sessionCfg?.autopilot_opening_cooldown_minutes ?? cooldownDefault);
      const cooldownCap = sessionCfg?.profile === 'hyper_active' ? 5 : 240;
      const cooldownBase = Math.max(0, Math.min(cooldownCap, cooldownConfigured));
      const cooldownMultiplier = marketMomentum === 'bearish' ? 1.33 : 1;
      const effectiveCooldownMs = Math.round(cooldownBase * cooldownMultiplier) * 60_000;

      if (effectiveCooldownMs > 0) {
        const { data: lastOpen } = await this.supabase.getClient()
          .from('lisa_decision_log')
          .select('timestamp')
          .eq('portfolio_id', portfolioId)
          .eq('kind', 'position_opened')
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastOpen) {
          const elapsedMs = Date.now() - new Date(lastOpen.timestamp as string).getTime();
          if (elapsedMs < effectiveCooldownMs) {
            const remaining = Math.ceil((effectiveCooldownMs - elapsedMs) / 60_000);
            await this.logDecision(portfolioId, 'proposal_cooldown_active', {
              summary: `Cooldown ouvertures actif — ${allocations.length} thèse(s) ignorée(s) (${remaining}min restants, momentum=${marketMomentum})`,
              rationale: `Garde-fou anti-burst : une position a été ouverte il y a ${Math.round(elapsedMs / 60_000)}min ; cooldown effectif = ${Math.round(effectiveCooldownMs / 60_000)}min pour momentum "${marketMomentum}". Seul marketMomentum='bullish_strong' bypasse ce cooldown. Fermetures restent actives.`,
              payload: { marketMomentum, effectiveCooldownMinutes: Math.round(effectiveCooldownMs / 60_000), remainingMinutes: remaining, skippedAllocations: allocations.length },
              triggeredBy: 'user_manual',
            });
            skipped = allocations.length;
            cooldownSkipped = true;
          }
        }
      }
    }

    // 2. Récupère le cash disponible avant d'ouvrir des nouvelles positions.
    //    Gate STRICT : pas de leverage implicite, pas de cash négatif.
    const snapshot = await this.paperBroker.computeSnapshot(portfolioId);
    let availableCash = new Decimal(snapshot.cashUsd);
    // P10-FIX — Buffer absolu USD réduit $50 → $35 pour laisser passer les
    // rotations defense (NOC, GDX, etc. skippées sur 3 thèses live 28/04).
    // Env override `CASH_BUFFER_USD_OVERRIDE` permet de tuner runtime sans
    // redeploy. Justification : un buffer plus permissif laisse déployer
    // plus de capital tout en gardant safety contre slippage/fees.
    //
    // Note postmortem : le ticket P10-FIX parlait d'un "ratio 50%→35%"
    // mais le code utilise historiquement un buffer ABSOLU USD. On honore
    // l'intent (réduction ~30%) en gardant la sémantique absolue : 50→35.
    const cashBufferOverride = this.config.get<string>('CASH_BUFFER_USD_OVERRIDE');
    const CASH_BUFFER_USD = new Decimal(
      cashBufferOverride && Number.isFinite(parseFloat(cashBufferOverride))
        ? cashBufferOverride
        : '35',
    );

    // Cap maxOpenPositions — garde-fou utilisateur (default 10, configurable
    // dans risk_constraints). Sans ce check, l'auto-approve pouvait ouvrir
    // au-delà du cap (le check existait uniquement côté mécanique).
    const constraintsForCap = (sessionCfg?.risk_constraints as Record<string, unknown> | null) ?? {};
    const maxOpenPositions = Number(constraintsForCap['maxOpenPositions'] ?? 10);
    const currentOpenPositions = await this.paperBroker.getPositions(portfolioId, true).catch(() => []);
    const currentOpenCount = currentOpenPositions.length;
    // Symboles déjà ouverts : empêche la duplication (Lisa pouvait proposer
    // 2 thèses RTX différentes et auto-approve les ouvrait toutes les 2).
    // Le mécanique a déjà ce check ligne 623 ; on l'aligne ici.
    const openSymbolsSet = new Set(
      currentOpenPositions.map((p) => p.symbol.toUpperCase()),
    );
    let openedSoFar = 0;

    // SWAP : quand cap atteint, on charge les positions ouvertes triées par
    // conviction asc. Si une nouvelle thèse a conviction ≥ weakest + GAP,
    // on ferme la weakest et on ouvre la nouvelle (rotation tactique).
    // Sans ça, les meilleures opportunités étaient simplement ignorées
    // une fois le cap saturé.
    // SWAP gap dynamique adaptatif (sur échelle conviction 0-10) :
    // - Position weakest en perte : gap = 1.0 (réactif, on coupe vite les losers)
    // - Position weakest breakeven : gap = 1.0
    // - Position weakest en gain : gap = 1.0 + min(2.0, weakestPnlPct/2)
    //   → un winner +5% demande gap +3.5 pour être swap (don't fix what works)
    //   → un winner +1% demande gap +1.5 (modeste protection)
    // Effet : autoriser rotation tactique sur les losers, protéger les winners.
    const computeSwapGap = (weakestPnlPct: number | null): number => {
      const pnl = weakestPnlPct ?? 0;
      if (pnl <= 0) return 1.0; // perte ou breakeven : facile à swap
      return Math.min(3.5, 1.0 + pnl / 2); // gain : protège proportionnel
    };
    const { data: openSwapCandidates } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, conviction_score, unrealized_pnl_pct, entry_price')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open')
      .order('conviction_score', { ascending: true, nullsFirst: true });
    const swappedIds = new Set<string>();

    const allocationsToOpen = cooldownSkipped ? [] : allocations;
    for (const alloc of allocationsToOpen) {
      const thesis = theses.find((t) => t.id === alloc.thesisId);
      if (!thesis) continue;
      const expressions = thesis.expressions as Array<Record<string, unknown>>;
      const preferredIdx = (thesis.preferredExpressionIndex as number) ?? 0;
      const expression = expressions[preferredIdx];
      if (!expression) continue;
      const newSymbol = String(expression.symbol);
      const newConviction = Number(thesis.confidenceScore) / 10; // échelle 0-10

      // Skip si position déjà ouverte sur ce symbole (anti-duplication)
      if (openSymbolsSet.has(newSymbol.toUpperCase())) {
        await this.logDecision(portfolioId, 'position_skipped_duplicate_symbol', {
          summary: `Skip ${newSymbol} : position déjà ouverte sur ce symbole`,
          rationale: `Anti-duplication : une position LONG/SHORT ${newSymbol} existe déjà. Lisa peut proposer plusieurs thèses sur le même symbole — on n'en prend qu'une à la fois pour éviter de doubler l'exposition implicitement. Ferme l'existante puis re-propose si tu veux changer le sizing.`,
          payload: { thesisId: alloc.thesisId, symbol: newSymbol },
          triggeredBy: 'user_manual',
        });
        skipped++;
        continue;
      }

      // Cap atteint : tenter swap avec gap dynamique fonction PnL weakest
      if (currentOpenCount + openedSoFar - swappedIds.size >= maxOpenPositions) {
        type SwapCandidate = (NonNullable<typeof openSwapCandidates>)[number];
        let swapTarget: SwapCandidate | null = null;
        let actualGap = 0;
        let usedThreshold = 0;
        for (const p of openSwapCandidates ?? []) {
          if (swappedIds.has(String(p.id))) continue;
          if (String(p.symbol) === newSymbol) continue;
          const existingConv = Number((p.conviction_score as number | null) ?? 5);
          const weakestPnl = (p.unrealized_pnl_pct as number | null) ?? null;
          const dynamicGap = computeSwapGap(weakestPnl);
          const gap = newConviction - existingConv;
          if (gap >= dynamicGap) {
            swapTarget = p;
            actualGap = gap;
            usedThreshold = dynamicGap;
            break;
          }
        }
        if (!swapTarget) {
          await this.logDecision(portfolioId, 'proposal_capped_by_max_positions', {
            summary: `Cap maxOpenPositions atteint (${currentOpenCount + openedSoFar - swappedIds.size}/${maxOpenPositions}) — pas de swap candidate (gap conviction insuffisant)`,
            rationale: `Garde-fou cap atteint. Tentative swap : nouvelle thèse ${newSymbol} conviction ${newConviction.toFixed(1)} ; aucune position existante avec conviction inférieure ET gap suffisant (gap dynamique = 1.0 si position en perte, jusqu'à 3.5 si winner). Pour autoriser plus de positions concurrentes, augmenter Max positions ouvertes dans /lisa.`,
            payload: { currentOpenCount, openedSoFar, maxOpenPositions, newSymbol, newConviction },
            triggeredBy: 'user_manual',
          });
          break;
        }
        // Swap : on ferme la position weakest avant d'ouvrir la nouvelle
        try {
          const swapQuote = await this.fetchLivePrice(String(swapTarget.symbol));
          // 🛡️ Bug #M Part 3 (#C5) — skip swap si quote fallback corrompu : ne
          // pas fermer la position weakest sur un prix sentinel '0'. On n'ouvre
          // pas la nouvelle non plus (cap toujours plein) → break, retry next cycle.
          // 🛡️ Bug #R5 — étendu : rejette aussi un prix 0/NaN/Infinity NON-FALLBACK
          // OU hors [0.5x, 2.0x] de l'entry du swapTarget (corruption non-sentinel).
          const swapPriceNum = parseFloat(swapQuote.price);
          const swapEntryNum = parseFloat(String(swapTarget.entry_price ?? ''));
          const swapRatio = Number.isFinite(swapEntryNum) && swapEntryNum > 0
            ? swapPriceNum / swapEntryNum
            : 1;
          const swapPriceInvalid =
            !Number.isFinite(swapPriceNum) || swapPriceNum <= 0 ||
            swapRatio < 0.5 || swapRatio > 2.0;
          if ((swapQuote.source && swapQuote.source.startsWith('fallback')) || swapPriceInvalid) {
            this.logger.warn(
              `[FALLBACK_GUARD_LISA] SWAP ${swapTarget.symbol} skip — ` +
              `source=${swapQuote.source} livePrice=${swapQuote.price} ` +
              `(invalide ou hors sanity bounds, entry=${swapTarget.entry_price})`,
            );
            break;
          }
          await this.paperBroker.closePosition({
            positionId: String(swapTarget.id),
            reason: 'closed_invalidated',
            livePrice: swapQuote.price,
            rationale: `SWAP : remplacée par ${newSymbol} (conviction ${newConviction.toFixed(1)} vs ${Number(swapTarget.conviction_score ?? 5).toFixed(1)})`.slice(0, 500),
          });
          // Phase 5 — capture outcome (swap close)
          this.tradeOutcomeRecorder.recordOutcome(String(swapTarget.id), swapQuote.price, 'closed_invalidated')
            .catch(() => null);
          swappedIds.add(String(swapTarget.id));
          // Position fermée : son symbole peut être réouvert ce cycle
          openSymbolsSet.delete(String(swapTarget.symbol).toUpperCase());
          const closedPnl = (swapTarget.unrealized_pnl_pct as number | null) ?? null;
          await this.logDecision(portfolioId, 'position_swapped_for_better_thesis', {
            summary: `SWAP : ${swapTarget.symbol} fermée → ${newSymbol} (gap ${actualGap.toFixed(1)} ≥ seuil dynamique ${usedThreshold.toFixed(1)})`,
            rationale: `Rotation tactique adaptative : nouvelle thèse ${newSymbol} conviction ${newConviction.toFixed(1)} vs ${swapTarget.symbol} conviction ${Number(swapTarget.conviction_score ?? 5).toFixed(1)} (PnL ${closedPnl !== null ? closedPnl.toFixed(2) + '%' : '?'}). Seuil dynamique calculé = ${usedThreshold.toFixed(1)} pts (1.0 si position en perte, jusqu'à 3.5 si gain pour protéger les winners).`,
            payload: {
              closedSymbol: swapTarget.symbol,
              closedPositionId: swapTarget.id,
              closedConviction: Number(swapTarget.conviction_score ?? 5),
              closedPnlPct: closedPnl,
              newSymbol,
              newThesisId: alloc.thesisId,
              newConviction,
              gap: actualGap,
              dynamicThreshold: usedThreshold,
            },
            triggeredBy: 'user_manual',
          });
        } catch (e) {
          this.logger.warn(`SWAP failed for ${swapTarget.symbol}: ${String(e).slice(0, 120)}`);
          break; // si on n'arrive pas à fermer, on n'ouvre pas la nouvelle
        }
        // Recharge le compte cash après fermeture (sera réutilisé plus bas)
        const refreshedSnapshot = await this.paperBroker.computeSnapshot(portfolioId);
        availableCash = new Decimal(refreshedSnapshot.cashUsd);
      }

      const allocAmount = new Decimal(alloc.amountUsd);
      if (availableCash.minus(allocAmount).lt(CASH_BUFFER_USD)) {
        this.logger.warn(
          `Skip ${String(expression.symbol)}: cash ${availableCash.toFixed(2)} insuffisant pour ${allocAmount.toFixed(2)}`,
        );
        skipped++;
        await this.logDecision(portfolioId, 'position_skipped_insufficient_cash', {
          summary: `Skip ${String(expression.symbol)} (${alloc.amountUsd} USD) — cash dispo ${availableCash.toFixed(2)} USD`,
          rationale: `Respect du cap anti-leverage : cash + buffer ${CASH_BUFFER_USD} requis`,
          payload: { thesisId: alloc.thesisId, allocAmount: alloc.amountUsd, cashAvailable: availableCash.toFixed(2) },
          triggeredBy: 'user_manual',
        });
        continue;
      }

      try {
        const quote = await this.fetchLivePrice(expression.symbol as string);
        // 🛡️ Patch A : ne JAMAIS ouvrir une position à prix fallback
        // (incident 26/04 — LMT ouvert à $513 puis liquidé à fallback $100).
        if (quote.source && quote.source.startsWith('fallback')) {
          this.logger.warn(`[FALLBACK_GUARD_LISA] approveProposal skip open ${expression.symbol} — source=${quote.source} (prix non fiable)`);
          skipped++;
          await this.logDecision(portfolioId, 'position_skipped_fallback_price', {
            summary: `Skip ${String(expression.symbol)} — prix live indisponible (source ${quote.source})`,
            rationale: `Garde-fou critique : pas d'ouverture sur fallback hardcoded. Au prochain cycle, si EODHD est revenu, l'ouverture pourra se faire à prix réel.`,
            payload: { thesisId: alloc.thesisId, symbol: expression.symbol, source: quote.source },
            triggeredBy: 'user_manual',
          });
          continue;
        }
        // PR #249 — Cast safe quand `thesis.riskReward` peut être undefined
        // (cas scanner top-gainers, voir commentaire ligne ~1392).
        const riskReward = thesis.riskReward as { horizonDays?: number; adverseScenarioReturnPct?: number } | undefined;
        const assetClass = String(expression.assetClass ?? '');
        const isCrypto = assetClass.startsWith('crypto_');

        // Stop-loss OBLIGATOIRE : -5% par défaut, ou le scénario adverse de la
        // thèse si plus strict. Permet à la risk_monitor de fermer les perdantes.
        const direction = expression.direction as string;
        const livePx = new Decimal(quote.price);
        const adversePct = Math.abs(riskReward?.adverseScenarioReturnPct ?? -5);
        // Aggressive mode = stop plus serré (-2% floor au lieu de -3%) pour
        // couper vite les perdantes et libérer du cash pour la prochaine idée.
        const floor = aggressive ? 2 : 3;
        const ceil = aggressive ? 5 : 10;
        const stopPct = Math.min(Math.max(adversePct, floor), ceil) / 100;
        const stopLossPrice = direction === 'long' || direction === 'long_call' || direction === 'long_put'
          ? livePx.mul(new Decimal(1).minus(new Decimal(stopPct))).toFixed(8)
          : livePx.mul(new Decimal(1).plus(new Decimal(stopPct))).toFixed(8);

        // 🛡️ Take-profit OBLIGATOIRE — incident 27/04/2026 : BTC + RTX
        // ouvertes via paperBroker avaient `takeProfitPrice: null` en dur,
        // ce qui inscrivait NULL en DB. Le mécanique skippait ensuite tout
        // check TP (cf. checkStopTarget). On force ici un TP basé sur :
        //   - daily_harvest_config.takeProfitAbsolutePct si DAILY_HARVEST actif
        //   - sinon defaults : 2.5% hyper_active, 4% standard
        const harvestCfg = sessionCfg?.daily_harvest_config as
          | { takeProfitAbsolutePct?: number }
          | null
          | undefined;
        const isHyper = sessionCfg?.profile === 'hyper_active';
        const tpPct = (
          (typeof harvestCfg?.takeProfitAbsolutePct === 'number' && harvestCfg.takeProfitAbsolutePct > 0)
            ? harvestCfg.takeProfitAbsolutePct
            : (isHyper ? 2.5 : 4.0)
        ) / 100;
        const isLongDir = direction === 'long' || direction === 'long_call' || direction === 'long_put';
        const takeProfitPrice = isLongDir
          ? livePx.mul(new Decimal(1).plus(new Decimal(tpPct))).toFixed(8)
          : livePx.mul(new Decimal(1).minus(new Decimal(tpPct))).toFixed(8);

        const binanceResult = isCrypto
          ? await this.tryBinanceExecution(expression.symbol as string, alloc.amountUsd, quote.price)
          : null;

        const pos = await this.paperBroker.openPosition({
          portfolioId,
          proposalId,
          thesisId: alloc.thesisId,
          expressionIndex: preferredIdx,
          capitalAllocationUsd: alloc.amountUsd,
          livePrice: quote.price,
          stopLossPrice,
          takeProfitPrice,
          horizonDays: riskReward?.horizonDays ?? 30,
        });
        opened.push(pos);
        openedSoFar++;
        openSymbolsSet.add(newSymbol.toUpperCase());
        availableCash = availableCash.minus(allocAmount);

        // Phase 2 : persiste autonomy_rules + conviction_score sur la
        // position ouverte. Ces métadonnées sont lues par le mécanique
        // (cron 60s) pour évaluer les règles H24 entre cycles Lisa.
        const autonomyRules = Array.isArray(thesis.autonomyRules) ? thesis.autonomyRules : [];
        const convictionScore = Math.round(Number(thesis.confidenceScore) / 10);
        await this.supabase.getClient()
          .from('lisa_positions')
          .update({
            autonomy_rules: autonomyRules,
            conviction_score: convictionScore,
          })
          .eq('id', pos.id)
          .then(({ error }) => {
            if (error) this.logger.warn(`Failed to persist autonomy_rules for ${pos.id}: ${error.message}`);
          });

        // Risk-monitor extension : capture pathEff/persistence/market_ch1m @ entry
        // pour positions ouvertes via le pipeline LLM (en plus du scanner gainers).
        // Best-effort : si mtfPersistence indisponible ou échec, le risk-monitor sera
        // dégradé pour cette position (Sub-B/A null → Sub-C carry).
        if (this.mtfPersistence) {
          void this.captureRiskMonitorFeaturesAtEntry(pos.id, String(expression.symbol), Number(quote.price));
        }

        await this.logDecision(portfolioId, 'position_opened', {
          summary: `Opened ${expression.symbol}: ${alloc.pctCapital}% (${alloc.amountUsd} USD) at ${quote.price} stop=${stopLossPrice}`,
          rationale: String(thesis.summary),
          payload: {
            positionId: pos.id,
            thesisId: alloc.thesisId,
            stopLossPrice,
            binanceOrderId: binanceResult?.externalOrderId ?? null,
            executionRoute: binanceResult ? 'binance_live' : 'paper',
          },
          triggeredBy: 'user_manual',
        });
      } catch (e) {
        // Migration 0118 — observabilité paper-broker silent failures.
        // Avant ce fix, les exceptions thrown par paperBroker.openPosition
        // (P20 fees-aware guard, fallback price, insufficient cash, etc.)
        // étaient loggées au logger Nest mais JAMAIS persistées en DB.
        // L'utilisateur voyait juste "0 position ouverte" sans cause racine.
        // Désormais on persiste l'erreur exacte avec son contexte pour
        // diagnostic en 1 query SQL.
        const errMsg = e instanceof Error ? e.message : String(e);
        const errClass = e instanceof Error ? e.constructor.name : 'unknown';
        this.logger.error(`Failed to open position for ${String(expression.symbol)}: ${errMsg}`);
        await this.logDecision(portfolioId, 'position_open_failed', {
          summary: `Open ${String(expression.symbol)} failed: ${errMsg.slice(0, 200)}`,
          rationale: errMsg.slice(0, 1500),
          payload: {
            proposal_id: proposalId,
            thesis_id: alloc.thesisId,
            symbol: expression.symbol,
            asset_class: expression.assetClass,
            venue: expression.venue,
            capital_allocation_usd: alloc.amountUsd,
            error_class: errClass,
            error_message: errMsg.slice(0, 500),
          },
          triggeredBy: 'user_manual',
        }).catch((logErr) =>
          this.logger.warn(`Failed to log position_open_failed: ${String(logErr).slice(0, 100)}`),
        );
      }
    }

    // P5-EXEC — Summary visibility : si approveProposal a été appelée avec
    // des thèses mais 0 position ouverte (tous les gates ont rejeté), log un
    // résumé top-level pour visibilité dashboard. Les rejets individuels
    // sont déjà loggés (position_skipped_*, proposal_cooldown_active,
    // proposal_capped_by_max_positions) mais sans aggregate, le user voit
    // proposal_generated puis silence.
    if (opened.length === 0 && allocations.length > 0) {
      await this.logDecision(portfolioId, 'proposal_rejected', {
        summary: `Proposal ${proposalId.slice(0, 8)} : 0 position ouverte sur ${allocations.length} allocation(s) — tous les gates ont rejeté`,
        rationale: `Voir les decision_log précédents pour le détail par thèse : kind in (position_skipped_duplicate_symbol, position_skipped_insufficient_cash, position_skipped_fallback_price, proposal_cooldown_active, proposal_capped_by_max_positions). Si rien n'apparaît : exception silencieuse côté paperBroker.openPosition.`,
        payload: {
          proposal_id: proposalId,
          allocations_count: allocations.length,
          opened_count: 0,
          skipped_count: skipped,
          closed_recommended_count: closedRecommended,
          gate: 'all_gates_rejected_or_silent_failure',
        },
        triggeredBy: 'user_manual',
      }).catch(() => null);
    }

    // Mark proposal as executed
    await this.supabase.getClient()
      .from('lisa_proposals')
      .update({ status: 'executed', executed_at: new Date().toISOString() })
      .eq('id', proposalId);

    return { openedPositions: opened, skipped, closedRecommended };
  }

  async rejectProposal(userId: string, proposalId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .update({ status: 'rejected' })
      .eq('id', proposalId)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);

    await this.logDecision(proposalId, 'proposal_rejected', {
      summary: `Proposal rejected by user`,
      rationale: reason,
      payload: { proposalId },
      triggeredBy: 'user_manual',
    });
  }

  /**
   * Purge en masse des propositions anciennes. Supprime celles dont le
   * status est terminal (executed/rejected/expired) OU plus vieilles que
   * olderThanHours (défaut 24h). Préserve les propositions "proposed"
   * récentes en attente d'approbation utilisateur.
   */
  async purgeOldProposals(
    userId: string,
    portfolioId: string,
    olderThanHours = 24,
  ): Promise<{ deleted: number }> {
    await this.assertPortfolioOwner(userId, portfolioId);
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();

    // Comptage d'abord pour retour au user
    const { count: beforeCount } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId);

    // Delete : propositions terminales peu importe l'âge OU propositions
    // de toute status si plus vieilles que le cutoff.
    const { error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .delete()
      .eq('portfolio_id', portfolioId)
      .or(`status.in.(executed,rejected,expired),generated_at.lt.${cutoff}`);

    if (error) throw new BadRequestException(`Purge failed: ${error.message}`);

    const { count: afterCount } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId);

    const deleted = (beforeCount ?? 0) - (afterCount ?? 0);

    await this.logDecision(portfolioId, 'proposals_purged', {
      summary: `${deleted} proposition(s) ancienne(s) purgée(s)`,
      rationale: `Cutoff : ${cutoff}. Critères : status terminal OU âge > ${olderThanHours}h.`,
      payload: { deleted, olderThanHours, cutoff },
      triggeredBy: 'user_manual',
    });

    return { deleted };
  }

  async listProposals(userId: string, portfolioId: string, limit = 20) {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_proposals')
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('generated_at', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  // ── Positions + snapshots ──────────────────────────────────────────────────

  async listPositions(userId: string, portfolioId: string, openOnly = false) {
    await this.assertPortfolioOwner(userId, portfolioId);
    return this.paperBroker.getPositions(portfolioId, openOnly);
  }

  async getCurrentSnapshot(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const snap = await this.paperBroker.computeSnapshot(portfolioId);
    // Transform camelCase PortfolioSnapshot → snake_case to match LisaSnapshot frontend type
    return {
      id: snap.id,
      portfolio_id: snap.portfolioId,
      timestamp: snap.timestamp,
      cash_usd: snap.cashUsd,
      open_positions_value_usd: snap.openPositionsValueUsd,
      total_value_usd: snap.totalValueUsd,
      realized_pnl_cumulative_usd: snap.realizedPnlCumulativeUsd,
      unrealized_pnl_usd: snap.unrealizedPnlUsd,
      return_from_inception_pct: snap.returnFromInceptionPct,
      open_positions_count: snap.openPositionsCount,
      drawdown_from_peak_pct: snap.drawdownFromPeakPct,
    };
  }

  /**
   * P3-A.2 — Liste les positions rebound OPEN d'un portfolio pour
   * injection dans le prompt Lisa. Retourne un format léger (pas tout
   * le row DB), prêt à être formaté par le builder de prompt.
   */
  async getReboundOpenPositions(portfolioId: string): Promise<Array<{
    ticker: string;
    entry: number;
    tp1: number;
    tp2: number;
    tp3: number;
    sl: number;
    timeStopAt: string;
    filledQtyPct: number;
    confidence: number | null;
  }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('rebound_positions')
      .select('ticker, entry_price, tp1, tp2, tp3, sl, time_stop_at, filled_qty_pct, scanner_confidence')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'OPEN');
    if (error) {
      this.logger.warn(`getReboundOpenPositions failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map((r) => ({
      ticker: String(r.ticker),
      entry: parseFloat(r.entry_price as string),
      tp1: parseFloat(r.tp1 as string),
      tp2: parseFloat(r.tp2 as string),
      tp3: parseFloat(r.tp3 as string),
      sl: parseFloat(r.sl as string),
      timeStopAt: r.time_stop_at as string,
      filledQtyPct: parseFloat(r.filled_qty_pct as string),
      confidence: r.scanner_confidence != null ? parseFloat(r.scanner_confidence as string) : null,
    }));
  }

  /**
   * P2-D — Telemetry P&L journalier vs objectif fixe $100/jour.
   *
   *   realized       : somme realized_pnl_usd des positions fermées aujourd'hui (UTC)
   *   latent         : unrealizedPnlUsd live du portfolio snapshot
   *   target         : objectif fixe $100 (constante produit)
   *   achievementPct : (realized + latent) / target × 100, clamp [0, 999]
   *   drift          : realized + latent - target  (peut être négatif)
   *
   * Source de vérité realized = lisa_positions filter `closed_*` aujourd'hui
   * (pas daily_trading_sessions qui n'est qu'un cache resync). Source de
   * vérité latent = paperBroker.computeSnapshot (live valuation marketplace).
   */
  async getDailyPnl(
    userId: string,
    portfolioId: string,
  ): Promise<{
    realized: number;
    latent: number;
    target: number;
    achievementPct: number;
    drift: number;
    dailyTargetHit: boolean;
  }> {
    await this.assertPortfolioOwner(userId, portfolioId);

    // P3-A — DAILY_TARGET_USD configurable via env (default $100).
    const TARGET_USD = Number(this.config.get<string>('DAILY_TARGET_USD')) || 100;
    const dayStartUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 86_400_000).toISOString();

    const [closesRes, snap] = await Promise.all([
      this.supabase.getClient()
        .from('lisa_positions')
        .select('realized_pnl_usd')
        .eq('portfolio_id', portfolioId)
        .like('status', 'closed_%')
        .gte('exit_timestamp', dayStartUtc)
        .lt('exit_timestamp', dayEndUtc)
        .not('exit_timestamp', 'is', null),
      this.paperBroker.computeSnapshot(portfolioId),
    ]);

    let realized = 0;
    for (const c of closesRes.data ?? []) {
      const pnl = parseFloat((c.realized_pnl_usd as string | null) ?? '0');
      if (Number.isFinite(pnl)) realized += pnl;
    }
    const latent = parseFloat(snap.unrealizedPnlUsd ?? '0');
    const safeLatent = Number.isFinite(latent) ? latent : 0;

    const total = realized + safeLatent;
    const achievementPctRaw = (total / TARGET_USD) * 100;
    const achievementPct = Math.max(0, Math.min(999, Number.isFinite(achievementPctRaw) ? achievementPctRaw : 0));
    const drift = total - TARGET_USD;

    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      realized: round2(realized),
      latent: round2(safeLatent),
      target: TARGET_USD,
      achievementPct: round2(achievementPct),
      drift: round2(drift),
      // P3-A — flag consommé par le cron pour freeze nouvelles entrées
      // rebound + signalé à l'UI dashboard. Latent compte (un trade
      // rebound non encore fermé est de l'avancement vers l'objectif).
      dailyTargetHit: total >= TARGET_USD,
    };
  }

  async getSnapshotHistory(userId: string, portfolioId: string, windowDays: number) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', since)
      .order('timestamp', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    // P0 hotfix — Postgres numeric() columns are serialized as STRINGS by
    // supabase-js (precision-preserving). The frontend `LisaSnapshot` type
    // expects `return_from_inception_pct: number` and `drawdown_from_peak_pct: number`
    // and components call `.toFixed()` on them → crash if string.
    // We coerce to numbers here for these two fields, while keeping money
    // columns (cash_usd, total_value_usd, etc.) as strings (Decimal-safe).
    return (data ?? []).map((row) => ({
      ...row,
      return_from_inception_pct: parseFloat(String(row.return_from_inception_pct ?? 0)) || 0,
      drawdown_from_peak_pct: parseFloat(String(row.drawdown_from_peak_pct ?? 0)) || 0,
      open_positions_count: parseInt(String(row.open_positions_count ?? 0), 10) || 0,
    }));
  }

  async getDecisionLog(userId: string, portfolioId: string, limit = 50) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const { data, error } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  /**
   * LISA refonte B.2 — Lessons Impact Tracker.
   *
   * Agrège les citations de lessons par TRADER sur une fenêtre glissante.
   * Pour chaque lesson (ou marker orphan non mappé), retourne :
   *   - citations_count, applied_count, resolved_count, wins, losses
   *   - sum_pnl_usd, avg_pnl_usd, win_rate_pct, last_cited_at
   *   - métadonnées scanner_lessons (lesson_kind, lesson_text, confidence, etc.)
   *
   * Stratégie : fetch citations + lessons séparément, agrégation TS.
   * Volumétrie raisonnable jusqu'à ~10k citations (limite hard).
   */
  async getLessonsImpact(userId: string, portfolioId: string, days = 30) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const client = this.supabase.getClient();
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

    const { data: citations, error: cErr } = await client
      .from('scanner_lesson_citations')
      .select('lesson_id, marker_text, action_applied, outcome_resolved_at, outcome_win, outcome_pnl_usd, cited_at')
      .eq('portfolio_id', portfolioId)
      .gte('cited_at', sinceIso)
      .limit(10000);
    if (cErr) throw new BadRequestException(cErr.message);
    const allCitations = citations ?? [];

    type LessonRow = {
      id: string;
      lesson_kind: string;
      lesson_text: string | null;
      confidence: number | null;
      is_active: boolean;
      macro_condition: string | null;
      sample_size: number | null;
    };

    const lessonIds = [
      ...new Set(allCitations.map((c) => (c as { lesson_id?: string }).lesson_id).filter(Boolean)),
    ] as string[];
    const lessonMap = new Map<string, LessonRow>();
    if (lessonIds.length > 0) {
      const { data: lessons } = await client
        .from('scanner_lessons')
        .select('id, lesson_kind, lesson_text, confidence, is_active, macro_condition, sample_size')
        .in('id', lessonIds);
      for (const l of (lessons ?? []) as LessonRow[]) lessonMap.set(l.id, l);
    }

    type Bucket = {
      lesson_id: string | null;
      lesson_kind: string;
      lesson_text: string | null;
      marker_text: string;
      confidence: number | null;
      is_active: boolean | null;
      macro_condition: string | null;
      sample_size: number | null;
      citations_count: number;
      applied_count: number;
      resolved_count: number;
      wins: number;
      losses: number;
      sum_pnl_usd: number;
      avg_pnl_usd: number;
      win_rate_pct: number | null;
      last_cited_at: string | null;
    };
    const buckets = new Map<string, Bucket>();
    for (const c of allCitations) {
      const row = c as {
        lesson_id?: string | null;
        marker_text: string;
        action_applied: boolean;
        outcome_resolved_at?: string | null;
        outcome_win?: boolean | null;
        outcome_pnl_usd?: unknown;
        cited_at: string;
      };
      const key = row.lesson_id ? `id:${row.lesson_id}` : `marker:${row.marker_text}`;
      let b = buckets.get(key);
      if (!b) {
        const lesson = row.lesson_id ? lessonMap.get(row.lesson_id) : null;
        b = {
          lesson_id: row.lesson_id ?? null,
          lesson_kind: lesson?.lesson_kind ?? '(orphan marker)',
          lesson_text: lesson?.lesson_text ?? null,
          marker_text: row.marker_text,
          confidence: lesson?.confidence ?? null,
          is_active: lesson?.is_active ?? null,
          macro_condition: lesson?.macro_condition ?? null,
          sample_size: lesson?.sample_size ?? null,
          citations_count: 0,
          applied_count: 0,
          resolved_count: 0,
          wins: 0,
          losses: 0,
          sum_pnl_usd: 0,
          avg_pnl_usd: 0,
          win_rate_pct: null,
          last_cited_at: null,
        };
        buckets.set(key, b);
      }
      b.citations_count += 1;
      if (row.action_applied) b.applied_count += 1;
      if (row.outcome_resolved_at) {
        b.resolved_count += 1;
        const pnl = Number(row.outcome_pnl_usd ?? 0);
        b.sum_pnl_usd += pnl;
        if (row.outcome_win === true) b.wins += 1;
        if (row.outcome_win === false) b.losses += 1;
      }
      if (!b.last_cited_at || row.cited_at > b.last_cited_at) {
        b.last_cited_at = row.cited_at;
      }
    }

    const lessonsArr = [...buckets.values()].map((b) => ({
      ...b,
      avg_pnl_usd: b.resolved_count > 0 ? b.sum_pnl_usd / b.resolved_count : 0,
      win_rate_pct: b.resolved_count > 0 ? (b.wins / b.resolved_count) * 100 : null,
    })).sort((a, b) => b.citations_count - a.citations_count);

    return {
      windowDays: days,
      totalCitations: allCitations.length,
      resolvedCitations: allCitations.filter(
        (c) => (c as { outcome_resolved_at?: string | null }).outcome_resolved_at,
      ).length,
      lessons: lessonsArr,
    };
  }

  async runRiskCheck(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const config = await this.getSessionConfig(userId, portfolioId);
    if (!config) throw new NotFoundException('Session config introuvable');

    const constraints = (config.risk_constraints as LisaSessionConfig['riskConstraints']) ?? {
      maxDrawdown2DaysPct: 10,
      maxDrawdown7DaysPct: 15,
      maxDrawdown30DaysPct: 25,
      maxPositionSizePct: 25,
      maxOpenPositions: 3,
      maxLeverage: 1.5,
      maxExposurePerAssetClassPct: 40,
      maxPortfolioVolatilityPct: 20,
      autoLiquidateOnKill: true,
    };

    return this.riskMonitor.checkPortfolio(portfolioId, constraints);
  }

  /**
   * Reset complet de la simulation : supprime TOUTES les positions, snapshots
   * et decision log pour ce portefeuille. Utile pour effacer un état corrompu
   * (ex : positions ouvertes avec prix fallback avant live feed disponible).
   * À la différence du kill-switch, ne matérialise PAS de P&L réalisé.
   */
  async resetSimulation(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const client = this.supabase.getClient();

    // Reset COMPLET — toutes les tables qui portent un état du portfolio.
    // Incident 27/04/2026 : ancien reset n'effaçait que positions/snapshots/log/proposals
    // → daily_trading_sessions et secured_profit_balance gardaient le P&L corrompu
    // → UI Harvest affichait toujours -$0.91 et vault $7.09 après reset.
    const [posRes, snapRes, logRes, propRes, sessRes, vaultRes, dirRes, cycleRes] = await Promise.all([
      client.from('lisa_positions').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_portfolio_snapshots').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_decision_log').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_proposals').delete().eq('portfolio_id', portfolioId),
      client.from('daily_trading_sessions').delete().eq('portfolio_id', portfolioId),
      client.from('secured_profit_balance').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_mechanical_directives').delete().eq('portfolio_id', portfolioId),
      client.from('lisa_mechanical_cycle_summary').delete().eq('portfolio_id', portfolioId),
    ]);

    const errors = [posRes.error, snapRes.error, logRes.error, propRes.error, sessRes.error, vaultRes.error, dirRes.error, cycleRes.error].filter(Boolean);
    if (errors.length) {
      throw new BadRequestException(`Reset partiel — erreurs : ${errors.map((e) => e!.message).join(' | ')}`);
    }

    // Réactive la config (lève kill_switch éventuel posé avant)
    await client
      .from('lisa_session_configs')
      .update({ kill_switch_active: false })
      .eq('portfolio_id', portfolioId);

    return { ok: true, portfolioId };
  }

  /**
   * LISA refonte C.1 — Coach proposals : list / accept / reject.
   * Accept = applique les lessons (INSERT scanner_lessons) + (optional)
   * applique les parameter_changes. Reject = juste UPDATE status='rejected'.
   */
  async listCoachProposals(userId: string, portfolioId: string, status?: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    let q = this.supabase.getClient()
      .from('coach_proposals')
      .select('id, created_at, source, llm_model, llm_cost_usd, feasibility_verdict, feasibility_probability_pct, feasibility_rationale, proposed_lessons, proposed_parameter_changes, risk_warnings, status, reviewed_at, resulted_lesson_ids')
      .eq('portfolio_id', portfolioId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async acceptCoachProposal(
    userId: string,
    proposalId: string,
    body: {
      accepted_lessons?: number[]; // index dans proposed_lessons
      accepted_params?: number[]; // index dans proposed_parameter_changes
      comment?: string;
    },
  ) {
    const client = this.supabase.getClient();
    const { data: proposal, error: pErr } = await client
      .from('coach_proposals')
      .select('id, portfolio_id, proposed_lessons, proposed_parameter_changes, status')
      .eq('id', proposalId)
      .maybeSingle();
    if (pErr || !proposal) throw new NotFoundException('Proposal introuvable');
    await this.assertPortfolioOwner(userId, String(proposal.portfolio_id));
    if (proposal.status !== 'pending') {
      throw new BadRequestException(`Proposal status=${proposal.status}, not pending`);
    }

    const acceptedLessonIdx = new Set(body.accepted_lessons ?? []);
    const acceptedParamIdx = new Set(body.accepted_params ?? []);
    const allLessons = Array.isArray(proposal.proposed_lessons) ? proposal.proposed_lessons : [];
    const allParams = Array.isArray(proposal.proposed_parameter_changes) ? proposal.proposed_parameter_changes : [];

    const lessonsToInsert = (allLessons as Array<Record<string, unknown>>).filter((_, i) => acceptedLessonIdx.has(i));
    const resultedLessonIds: string[] = [];
    if (lessonsToInsert.length > 0) {
      const rows = lessonsToInsert.map((l) => ({
        lesson_kind: String(l.lesson_kind ?? 'UNNAMED'),
        lesson_text: String(l.lesson_text ?? ''),
        confidence: typeof l.confidence === 'number' ? l.confidence : 0.7,
        scope: String(l.scope ?? 'trader_agent_only'),
        derived_from_date: new Date().toISOString().slice(0, 10),
        is_active: true,
        applied: true,
        applied_by: `coach:${userId.slice(0, 8)}`,
        applied_at: new Date().toISOString(),
        payload: { from_coach_proposal: proposalId, rationale: l.rationale ?? null, expected_impact_usd: l.expected_impact_usd ?? null },
      }));
      const { data: ins, error: insErr } = await client.from('scanner_lessons').insert(rows).select('id');
      if (insErr) throw new BadRequestException(insErr.message);
      for (const r of (ins ?? []) as Array<{ id: string }>) resultedLessonIds.push(r.id);
    }

    const partial = acceptedLessonIdx.size < allLessons.length || acceptedParamIdx.size < allParams.length;
    const newStatus = (acceptedLessonIdx.size === 0 && acceptedParamIdx.size === 0)
      ? 'rejected'
      : (partial ? 'partially_accepted' : 'fully_accepted');

    await client
      .from('coach_proposals')
      .update({
        status: newStatus,
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
        user_decision: {
          accepted_lessons: [...acceptedLessonIdx],
          rejected_lessons: allLessons.map((_, i) => i).filter((i) => !acceptedLessonIdx.has(i)),
          applied_params: [...acceptedParamIdx],
          comment: body.comment ?? null,
        },
        resulted_lesson_ids: resultedLessonIds,
      })
      .eq('id', proposalId);

    return { ok: true, status: newStatus, resulted_lesson_ids: resultedLessonIds };
  }

  async rejectCoachProposal(userId: string, proposalId: string, comment?: string) {
    const body: { accepted_lessons: number[]; accepted_params: number[]; comment?: string } = {
      accepted_lessons: [],
      accepted_params: [],
    };
    if (comment !== undefined) body.comment = comment;
    return this.acceptCoachProposal(userId, proposalId, body);
  }

  /**
   * LISA — Shadows Summary read-only (B-shadow widget).
   *
   * Retourne un snapshot compact des 3 Shadow Sizing portfolios (HIGH/MIDDLE/SMALL)
   * pour comparaison vs TRADER côté UI. Pas de check ownership : ces portfolios
   * sont system-managed par ShadowSizingOrchestrator et peuvent ne pas être
   * owned par l'user qui consulte. Le service-role bypass RLS, donc OK.
   *
   * Endpoint public (auth simple via extractUserId pour anti-abuse) — read-only.
   */
  async getShadowsSummary() {
    const client = this.supabase.getClient();
    const SHADOW_IDS = [
      { id: 'a0000001-0000-0000-0000-000000000001', name: 'Shadow High Sizing', label: 'HIGH' },
      { id: 'a0000002-0000-0000-0000-000000000002', name: 'Shadow Middle Sizing', label: 'MIDDLE' },
      { id: 'a0000003-0000-0000-0000-000000000003', name: 'Shadow Small Sizing', label: 'SMALL' },
    ];

    // Latest snapshot par portfolio (table shadow_sizing_snapshot, écrite chaque
    // cycle 5min par ShadowSizingOrchestratorService).
    const { data: snapshots } = await client
      .from('shadow_sizing_snapshot')
      .select('portfolio_id, profile_name, open_positions, closed_today, realized_pnl_usd, unrealized_pnl_usd, total_pnl_usd, win_rate_pct, fees_paid_usd, net_pnl_after_fees_usd, daily_pnl_extrapolated_usd, target_progress_pct, drawdown_today_pct, capacity_used_pct, created_at')
      .in('portfolio_id', SHADOW_IDS.map((s) => s.id))
      .order('created_at', { ascending: false })
      .limit(30);

    const latestByPortfolio = new Map<string, Record<string, unknown>>();
    for (const row of (snapshots ?? []) as Array<Record<string, unknown>>) {
      const pid = String(row.portfolio_id ?? '');
      if (!latestByPortfolio.has(pid)) latestByPortfolio.set(pid, row);
    }

    // FIX 01/06 — Ajout fetch des positions fermées du JOUR (UTC) pour
    // fallback live si shadow_sizing_snapshot vide (cron pas actif ou en
    // retard). Avant ce fix, l'UI affichait 0/0/0/0 sur les 3 cards du jour
    // alors que les shadows tradaient bien (audit script v1.0 montrait 39
    // trades closed non-TRADER en 24h).
    const todayUtcStart = new Date();
    todayUtcStart.setUTCHours(0, 0, 0, 0);
    const [configsRes, openSymbolsRes, cumPnlRes, todayPnlRes] = await Promise.all([
      client
        .from('lisa_session_configs')
        .select('portfolio_id, capital_usd, kill_switch_active')
        .in('portfolio_id', SHADOW_IDS.map((s) => s.id)),
      client
        .from('lisa_positions')
        .select('portfolio_id, symbol, entry_notional_usd')
        .in('portfolio_id', SHADOW_IDS.map((s) => s.id))
        .eq('status', 'open'),
      client
        .from('lisa_positions')
        .select('portfolio_id, realized_pnl_usd')
        .in('portfolio_id', SHADOW_IDS.map((s) => s.id))
        .neq('status', 'open'),
      client
        .from('lisa_positions')
        .select('portfolio_id, realized_pnl_usd, exit_timestamp')
        .in('portfolio_id', SHADOW_IDS.map((s) => s.id))
        .neq('status', 'open')
        .gte('exit_timestamp', todayUtcStart.toISOString()),
    ]);

    const configByPortfolio = new Map<string, { capital_usd?: string; kill_switch_active?: boolean }>();
    for (const c of (configsRes.data ?? []) as Array<{ portfolio_id: string; capital_usd?: string; kill_switch_active?: boolean }>) {
      configByPortfolio.set(c.portfolio_id, c);
    }
    const symbolsByPortfolio = new Map<string, string[]>();
    const deployedByPortfolio = new Map<string, number>();
    for (const p of (openSymbolsRes.data ?? []) as Array<{ portfolio_id: string; symbol?: string; entry_notional_usd?: unknown }>) {
      const arr = symbolsByPortfolio.get(p.portfolio_id) ?? [];
      if (p.symbol) arr.push(p.symbol);
      symbolsByPortfolio.set(p.portfolio_id, arr);
      deployedByPortfolio.set(p.portfolio_id, (deployedByPortfolio.get(p.portfolio_id) ?? 0) + Number(p.entry_notional_usd ?? 0));
    }
    const cumPnlByPortfolio = new Map<string, number>();
    const tradesByPortfolio = new Map<string, number>();
    const winsByPortfolio = new Map<string, number>();
    for (const p of (cumPnlRes.data ?? []) as Array<{ portfolio_id: string; realized_pnl_usd?: unknown }>) {
      const pnl = Number(p.realized_pnl_usd ?? 0);
      cumPnlByPortfolio.set(p.portfolio_id, (cumPnlByPortfolio.get(p.portfolio_id) ?? 0) + pnl);
      tradesByPortfolio.set(p.portfolio_id, (tradesByPortfolio.get(p.portfolio_id) ?? 0) + 1);
      if (pnl > 0) winsByPortfolio.set(p.portfolio_id, (winsByPortfolio.get(p.portfolio_id) ?? 0) + 1);
    }
    // FIX 01/06 — Fallback live today stats (si snapshot vide ou absent).
    const todayTradesByPortfolio = new Map<string, number>();
    const todayPnlByPortfolio = new Map<string, number>();
    const todayWinsByPortfolio = new Map<string, number>();
    for (const p of (todayPnlRes.data ?? []) as Array<{ portfolio_id: string; realized_pnl_usd?: unknown }>) {
      const pnl = Number(p.realized_pnl_usd ?? 0);
      todayTradesByPortfolio.set(p.portfolio_id, (todayTradesByPortfolio.get(p.portfolio_id) ?? 0) + 1);
      todayPnlByPortfolio.set(p.portfolio_id, (todayPnlByPortfolio.get(p.portfolio_id) ?? 0) + pnl);
      if (pnl > 0) todayWinsByPortfolio.set(p.portfolio_id, (todayWinsByPortfolio.get(p.portfolio_id) ?? 0) + 1);
    }

    const results = SHADOW_IDS.map((shadow) => {
      const snap = latestByPortfolio.get(shadow.id);
      const cfg = configByPortfolio.get(shadow.id);
      const openSyms = symbolsByPortfolio.get(shadow.id) ?? [];
      const baseCapital = cfg?.capital_usd ? parseFloat(cfg.capital_usd) : 10000;
      const cumulativePnl = cumPnlByPortfolio.get(shadow.id) ?? 0;

      const openPositions = snap ? Number(snap.open_positions ?? 0) : openSyms.length;
      // FIX 01/06 — Fallback live : si snapshot vide ou stats jour à 0 alors
      // que lisa_positions montre des closes today, utiliser le recompute live.
      const liveTrades = todayTradesByPortfolio.get(shadow.id) ?? 0;
      const livePnl = todayPnlByPortfolio.get(shadow.id) ?? 0;
      const liveWins = todayWinsByPortfolio.get(shadow.id) ?? 0;
      const snapTrades = snap ? Number(snap.closed_today ?? 0) : 0;
      const snapPnl = snap ? Number(snap.realized_pnl_usd ?? 0) : 0;
      const useLive = !snap || (snapTrades === 0 && liveTrades > 0);
      const closedToday = useLive ? liveTrades : snapTrades;
      const realizedToday = useLive ? livePnl : snapPnl;
      const netToday = useLive ? livePnl : (snap ? Number(snap.net_pnl_after_fees_usd ?? 0) : 0);
      const winRateToday: number | null = useLive
        ? (liveTrades > 0 ? (liveWins / liveTrades) * 100 : null)
        : (snap?.win_rate_pct !== undefined && snap?.win_rate_pct !== null ? Number(snap.win_rate_pct) : null);
      const winsToday = useLive ? liveWins : (winRateToday !== null && closedToday > 0 ? Math.round((winRateToday / 100) * closedToday) : 0);
      const lossesToday = closedToday - winsToday;
      const drawdownToday = snap ? Number(snap.drawdown_today_pct ?? 0) : 0;
      const targetProgress = snap ? Number(snap.target_progress_pct ?? 0) : 0;
      const feesToday = snap ? Number(snap.fees_paid_usd ?? 0) : 0;

      const allTimeTrades = tradesByPortfolio.get(shadow.id) ?? 0;
      const allTimeWins = winsByPortfolio.get(shadow.id) ?? 0;
      const allTimeWinRate = allTimeTrades > 0 ? (allTimeWins / allTimeTrades) * 100 : null;

      return {
        id: shadow.id,
        name: shadow.name,
        label: shadow.label,
        base_capital_usd: baseCapital,
        current_capital_usd: baseCapital + cumulativePnl,
        cumulative_pnl_usd: cumulativePnl,
        return_from_inception_pct: baseCapital > 0 ? (cumulativePnl / baseCapital) * 100 : 0,
        open_positions: openPositions,
        deployed_usd: deployedByPortfolio.get(shadow.id) ?? 0,
        today: {
          pnl_usd: realizedToday,
          net_pnl_after_fees_usd: netToday,
          fees_usd: feesToday,
          trades: closedToday,
          wins: winsToday,
          losses: lossesToday,
          win_rate_pct: winRateToday,
          drawdown_pct: drawdownToday,
          target_progress_pct: targetProgress,
        },
        all_time: {
          trades: allTimeTrades,
          wins: allTimeWins,
          losses: allTimeTrades - allTimeWins,
          win_rate_pct: allTimeWinRate,
        },
        kill_switch_active: cfg?.kill_switch_active === true,
        open_symbols: openSyms,
        snapshot_at: snap?.created_at ? String(snap.created_at) : null,
      };
    });

    return { generated_at: new Date().toISOString(), shadows: results };
  }

  /**
   * LISA refonte B.4.a — In-app notifications.
   *
   * Agrège des "items" virtuels depuis plusieurs sources :
   *   - coach_proposals status='pending' (Strategy Coach C.1)
   *   - kill_switch_active=true (anti-spirale ou manuel)
   *
   * Le client gère "unread" via localStorage (last_seen_at) car pas de
   * besoin de cross-device sync à ce stade. Le badge UI = items dont
   * created_at > last_seen client-side.
   */
  async getNotifications(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const client = this.supabase.getClient();

    const [cfgRes, propRes] = await Promise.all([
      client
        .from('lisa_session_configs')
        .select('kill_switch_active, updated_at')
        .eq('portfolio_id', portfolioId)
        .maybeSingle(),
      client
        .from('coach_proposals')
        .select('id, created_at, source, llm_model, feasibility_verdict, feasibility_probability_pct, proposed_lessons, proposed_parameter_changes')
        .eq('portfolio_id', portfolioId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    type Item = {
      id: string;
      kind: 'kill_switch_armed' | 'coach_proposal_pending';
      severity: 'critical' | 'info' | 'warning';
      title: string;
      body: string;
      created_at: string;
      href?: string;
      payload?: Record<string, unknown>;
    };
    const items: Item[] = [];

    const cfg = cfgRes.data as { kill_switch_active?: boolean; updated_at?: string } | null;
    if (cfg?.kill_switch_active) {
      items.push({
        id: `kill_switch:${portfolioId}`,
        kind: 'kill_switch_armed',
        severity: 'critical',
        title: 'Kill-switch anti-spirale armé',
        body: 'TRADER suspendu. Désarme manuellement dans Config LISA pour reprendre les cycles.',
        created_at: cfg.updated_at ?? new Date().toISOString(),
      });
    }

    for (const p of (propRes.data ?? []) as Array<Record<string, unknown>>) {
      const lessons = Array.isArray(p.proposed_lessons) ? p.proposed_lessons.length : 0;
      const params = Array.isArray(p.proposed_parameter_changes) ? p.proposed_parameter_changes.length : 0;
      const verdict = String(p.feasibility_verdict ?? 'UNKNOWN');
      const probPct = p.feasibility_probability_pct as number | null;
      items.push({
        id: `coach:${p.id}`,
        kind: 'coach_proposal_pending',
        severity: verdict === 'UNREALISTIC' ? 'warning' : 'info',
        title: `Proposition Strategy Coach (${String(p.llm_model)})`,
        body: `Verdict ${verdict}${probPct !== null ? ` · ${probPct}%` : ''} · ${lessons} lesson(s) · ${params} param(s) proposé(s)`,
        created_at: String(p.created_at),
        payload: { proposal_id: String(p.id), lessons, params, verdict },
      });
    }

    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items, total: items.length };
  }

  /**
   * LISA refonte B.3 — Désarme le kill-switch (anti-spirale ou manuel).
   * Pas de force-close, juste UPDATE kill_switch_active=false.
   * Audit dans lisa_decision_log pour traçabilité.
   */
  async resetKillSwitch(userId: string, portfolioId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);
    const client = this.supabase.getClient();
    await client
      .from('lisa_session_configs')
      .update({ kill_switch_active: false })
      .eq('portfolio_id', portfolioId);
    await client.from('lisa_decision_log').insert({
      portfolio_id: portfolioId,
      kind: 'kill_switch_reset',
      payload: { reset_by: 'user_manual', timestamp: new Date().toISOString() },
    });
    return { ok: true };
  }

  /**
   * LISA refonte B.3 — Liste les scanner_lessons avec filtres.
   * Pas de scoping user (table partagée). Limite défaut 200.
   */
  async listScannerLessons(opts: {
    active?: boolean;
    search?: string;
    scope?: string;
    limit?: number;
  }) {
    const client = this.supabase.getClient();
    let q = client
      .from('scanner_lessons')
      .select('id, lesson_kind, lesson_text, macro_condition, scope, confidence, sample_size, win_rate_observed, avg_pnl_usd, is_active, derived_from_date, created_at, applied, applied_by')
      .order('created_at', { ascending: false })
      .limit(Math.min(opts.limit ?? 200, 1000));
    if (opts.active !== undefined) q = q.eq('is_active', opts.active);
    if (opts.scope) q = q.eq('scope', opts.scope);
    if (opts.search) {
      const term = `%${opts.search}%`;
      q = q.or(`lesson_kind.ilike.${term},lesson_text.ilike.${term}`);
    }
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  /**
   * LISA refonte B.3 — Toggle is_active d'une lesson.
   */
  async setScannerLessonActive(lessonId: string, active: boolean) {
    const { error } = await this.supabase.getClient()
      .from('scanner_lessons')
      .update({ is_active: active })
      .eq('id', lessonId);
    if (error) throw new BadRequestException(error.message);
    return { ok: true, lessonId, is_active: active };
  }

  async triggerKillSwitch(userId: string, portfolioId: string, reason: string) {
    await this.assertPortfolioOwner(userId, portfolioId);

    await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({ kill_switch_active: true, autopilot_enabled: false })
      .eq('portfolio_id', portfolioId);

    // Force-close all open positions
    const openPositions = await this.paperBroker.getPositions(portfolioId, true);
    for (const pos of openPositions) {
      try {
        const quote = await this.fetchLivePrice(pos.symbol);
        // 🛡️ Bug #M Part 3 (#C2) — garde fallback : le kill-switch user est un
        // geste de protection. Si EODHD est down, quote.price='0' (sentinel
        // fallback_unknown) → fermerait tout à $0. On ferme à entry_price
        // (pnl≈0) plutôt qu'au prix corrompu. Pattern risk-monitor.liquidateAll.
        const priceNum = parseFloat(quote.price);
        const corrupt =
          (quote.source != null && quote.source.startsWith('fallback')) ||
          !Number.isFinite(priceNum) ||
          priceNum <= 0;
        const liquidationPx = corrupt ? pos.entryPrice : quote.price;
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_kill',
          livePrice: liquidationPx,
          rationale: `User kill switch: ${reason}`
            + (corrupt ? ' [Bug#M-guard: closed at entry_price]' : ''),
        });
        // Phase 5 — capture outcome (kill switch)
        this.tradeOutcomeRecorder.recordOutcome(pos.id, liquidationPx, 'closed_kill')
          .catch(() => null);
      } catch (e) {
        this.logger.error(`Kill switch close failed for ${pos.symbol}: ${String(e)}`);
      }
    }

    await this.logDecision(portfolioId, 'kill_switch_triggered', {
      summary: `User triggered kill switch — all ${openPositions.length} positions closed`,
      rationale: reason,
      payload: { closedCount: openPositions.length },
      triggeredBy: 'user_manual',
    });

    return { closedPositions: openPositions.length };
  }

  /**
   * Close MANUEL d'une position par l'utilisateur (bouton "Fermer" sur la
   * carte). Close immédiat au prix live, compta complète (realized_pnl, outcome,
   * resync session). À la différence du cron mécanique, on OVERRIDE le rejet
   * staleness : quand l'user clique "Fermer", il VEUT fermer même si le prix
   * LSE est delayed (stale_eodhd). Anti-corruption conservé : si source
   * `fallback_*` OU prix invalide → close à entry_price (pnl≈0) plutôt qu'à
   * un prix aberrant.
   */
  async closePositionManual(userId: string, portfolioId: string, positionId: string) {
    await this.assertPortfolioOwner(userId, portfolioId);

    const { data: row, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, status, entry_price, portfolio_id')
      .eq('id', positionId)
      .maybeSingle();
    if (error || !row) throw new NotFoundException(`Position ${positionId} introuvable`);
    if (row.portfolio_id !== portfolioId) throw new BadRequestException('Position hors portfolio');
    if (row.status !== 'open') throw new BadRequestException(`Position déjà fermée (status=${row.status})`);

    const quote = await this.getLivePrice(String(row.symbol)).catch(() => null);
    const priceNum = quote ? parseFloat(quote.price) : NaN;
    const isFallback = quote?.source != null && quote.source.startsWith('fallback');
    const corrupt = !quote || isFallback || !Number.isFinite(priceNum) || priceNum <= 0;
    // fallback/corrompu → close à entry (pnl≈0, anti-$0). Sinon prix live.
    const closePx = corrupt ? String(row.entry_price) : quote!.price;
    // Override staleness : user veut fermer. On NE passe PAS livePriceSource
    // → le paper-broker skippe le rejet staleness (stale_eodhd LSE accepté).
    // L'anti-corruption fallback_* est déjà géré en amont (closePx=entry).
    const result = await this.paperBroker.closePosition({
      positionId,
      reason: 'closed_user',
      livePrice: closePx,
      rationale: `[manual] Close user @ ${closePx}`
        + (corrupt ? ' [fallback-guard: closed at entry_price]' : ` (source=${quote?.source ?? '?'})`),
      // Close initiée par l'utilisateur → autorisée même sous contrôle manuel.
      allowManualControlled: true,
    });

    // Capture outcome (Phase 5) + resync session (compta Harvest/gainers).
    // resyncSessionFromPositions(sessionId, portfolioId, sessionDate) — on
    // récupère/crée la session du jour pour avoir id + date (cf. pattern
    // daily-profit-governor.onTradeClosed). Best-effort : un échec resync ne
    // doit pas bloquer le close (le realized_pnl est déjà écrit par le broker).
    this.tradeOutcomeRecorder.recordOutcome(positionId, closePx, 'closed_user').catch(() => null);
    try {
      const { data: cfg } = await this.supabase.getClient()
        .from('lisa_session_configs').select('*').eq('portfolio_id', portfolioId).maybeSingle();
      if (cfg) {
        const session = await this.dailySession.createOrGetTodaySession(portfolioId, cfg as never);
        await this.dailySession.resyncSessionFromPositions(session.id, portfolioId, session.sessionDate);
      }
    } catch (e) {
      this.logger.warn(`[close-manual] session resync skip: ${String(e).slice(0, 120)}`);
    }

    await this.logDecision(portfolioId, 'position_closed_manual', {
      summary: `User closed ${row.symbol} (${positionId.slice(0, 8)}) @ ${closePx}`.slice(0, 200),
      rationale: `Manual close button. pnl=${result.realizedPnlUsd ?? '?'} USD`,
      payload: { positionId, symbol: row.symbol, closePrice: closePx, source: quote?.source, corrupt },
      triggeredBy: 'user_manual',
    }).catch(() => null);

    // Apprentissage — capture le contexte de CETTE décision de fermeture user
    // (fire-and-forget). Le cron counterfactuel labellisera GOOD/EARLY/OK +60min.
    if (this.closeDecisionCapture) {
      const ageMin = (Date.now() - new Date(String((result as { entryTimestamp?: string }).entryTimestamp ?? Date.now())).getTime()) / 60_000;
      this.closeDecisionCapture.captureClose({
        positionId,
        portfolioId,
        symbol: String(row.symbol),
        direction: String((result as { direction?: string }).direction ?? 'long'),
        assetClass: (result as { assetClass?: string | null }).assetClass ?? null,
        closerType: 'user_manual',
        entryPrice: Number(row.entry_price),
        exitPrice: Number(closePx),
        pnlPct: result.realizedPnlPct ?? null,
        pnlUsd: result.realizedPnlUsd != null ? Number(result.realizedPnlUsd) : null,
        ageMinutes: Number.isFinite(ageMin) ? ageMin : 0,
        takeProfitPrice: (result as { takeProfitPrice?: number | null }).takeProfitPrice ?? null,
        stopLossPrice: (result as { stopLossPrice?: number | null }).stopLossPrice ?? null,
      });
    }

    return {
      ok: true,
      symbol: row.symbol,
      exitPrice: closePx,
      realizedPnlUsd: result.realizedPnlUsd ?? null,
      realizedPnlPct: result.realizedPnlPct ?? null,
    };
  }

  /**
   * Active/désactive le CONTRÔLE MANUEL sur une position. Quand `enabled=true`,
   * l'auto-trader ne ferme plus jamais cette position (SL/TP/trailing/risk-
   * monitor) — l'utilisateur a la main à 100%. Réversible (`enabled=false` rend
   * la main à l'auto). Le SL reste stocké (repère visuel non-déclencheur).
   */
  async setManualControl(
    userId: string,
    portfolioId: string,
    positionId: string,
    enabled: boolean,
  ): Promise<{ ok: true; positionId: string; manualControl: boolean }> {
    await this.assertPortfolioOwner(userId, portfolioId);

    const { data: row, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, status, portfolio_id')
      .eq('id', positionId)
      .maybeSingle();
    if (error || !row) throw new NotFoundException(`Position ${positionId} introuvable`);
    if (row.portfolio_id !== portfolioId) throw new BadRequestException('Position hors portfolio');
    if (row.status !== 'open') throw new BadRequestException(`Position déjà fermée (status=${row.status})`);

    const { error: upErr } = await this.supabase.getClient()
      .from('lisa_positions')
      .update({ manual_control: enabled })
      .eq('id', positionId)
      .eq('status', 'open');
    if (upErr) throw new Error(`Update manual_control failed: ${upErr.message}`);

    await this.logDecision(portfolioId, 'position_manual_control_toggled', {
      summary: `${enabled ? '🔒 Contrôle manuel ON' : '🤖 Auto rendu'} sur ${row.symbol} (${positionId.slice(0, 8)})`.slice(0, 200),
      rationale: enabled
        ? 'Utilisateur a pris le contrôle 100% : aucun close auto (SL/TP/trailing/risk-monitor) jusqu\'à révocation. SL reste repère non-déclencheur.'
        : 'Utilisateur rend la main à l\'auto-trader : stops/targets ré-activés.',
      payload: { positionId, symbol: row.symbol, manual_control: enabled },
      triggeredBy: 'user_manual',
    }).catch(() => null);

    return { ok: true, positionId, manualControl: enabled };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async assertPortfolioOwner(userId: string, portfolioId: string): Promise<void> {
    const { data, error } = await this.supabase.getClient()
      .from('portfolios')
      .select('id')
      .eq('id', portfolioId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException('Portfolio introuvable');
  }

  /**
   * Attempt to execute a crypto order on Binance when the full guard chain is active:
   *   BINANCE_API_KEY + BINANCE_SECRET_KEY set in env
   *   BINANCE_EXECUTION_ENABLED=true
   * Returns null (paper-only) when any condition is not met.
   * Never throws — execution failure is logged but does not block paper position creation.
   */
  private async tryBinanceExecution(
    symbol: string,
    capitalUsd: string,
    livePrice: string,
  ): Promise<{ externalOrderId: string | null; status: string } | null> {
    // Nom de variable choisi par l'utilisateur sur Railway
    const apiKey = this.config.get<string>('smartvest-lisa') ?? this.config.get<string>('BINANCE_API_KEY');
    const secretKey = this.config.get<string>('BINANCE_SECRET_KEY');
    const execEnabled = this.config.get<string>('BINANCE_EXECUTION_ENABLED') === 'true';

    if (!apiKey || !secretKey || !execEnabled) return null;

    try {
      const adapter = new BinanceAdapter(true);
      await adapter.connect({ provider: 'BINANCE', apiKey, secretKey });

      // Compute quantity from capital / price
      const qty = new Decimal(capitalUsd).dividedBy(new Decimal(livePrice));
      // Binance requires symbol without dashes: BTC → BTCUSDT
      const binanceSymbol = this.toBinanceSymbol(symbol);

      const result = await adapter.placeOrder({
        accountIdExternal: 'spot',
        instrumentRef: binanceSymbol,
        side: 'buy',
        orderType: 'market',
        quantity: qty.toFixed(6),
      });

      this.logger.log(`Binance order: ${binanceSymbol} qty=${qty.toFixed(6)} → ${result.status} orderId=${result.externalOrderId}`);

      if (result.status === 'rejected') {
        this.logger.warn(`Binance order rejected: ${result.message}`);
      }

      return result;
    } catch (e) {
      this.logger.error(`Binance execution error for ${symbol}: ${String(e)}`);
      return null;
    }
  }

  /** Convert ticker to Binance USDT pair symbol (e.g. BTC → BTCUSDT) */
  private toBinanceSymbol(symbol: string): string {
    const s = symbol.toUpperCase().replace(/[/\-\s]/g, '');
    // Already has USDT suffix
    if (s.endsWith('USDT')) return s;
    // Stablecoins — no pair needed, but return as-is
    if (['USDT', 'USDC', 'BUSD'].includes(s)) return s;
    return `${s}USDT`;
  }

  /**
   * Fetch live price via EODHD real-time API.
   * Falls back to Supabase quotes cache, then to a static fallback.
   */
  /** Public wrapper for the price warmer (autopilot cron). */
  async warmPrice(symbol: string): Promise<void> {
    await this.fetchLivePrice(symbol);
  }

  /**
   * Persiste un snapshot live du portfolio dans lisa_portfolio_snapshots.
   * Appelé par le cron lisa-portfolio-snapshot toutes les 5 min pour
   * garantir que le graphique /lisa reste à jour même quand Lisa ne
   * tourne pas (mode event-driven Phase 4 = cycles rares en regime calme).
   *
   * Utilise paperBroker.computeSnapshot() qui calcule la valeur live
   * (cash + positions × prix live), donc le snapshot reflète exactement
   * ce que l'UI top affiche en haut de page (Valeur totale, P&L latent).
   */
  async persistLivePortfolioSnapshot(portfolioId: string): Promise<void> {
    const snap = await this.paperBroker.computeSnapshot(portfolioId);
    const now = new Date().toISOString();
    await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .insert({
        id: randomUUID(),
        portfolio_id: portfolioId,
        timestamp: now,
        cash_usd: snap.cashUsd,
        open_positions_value_usd: snap.openPositionsValueUsd,
        total_value_usd: snap.totalValueUsd,
        realized_pnl_cumulative_usd: snap.realizedPnlCumulativeUsd ?? '0',
        unrealized_pnl_usd: snap.unrealizedPnlUsd ?? '0',
        return_from_inception_pct: snap.returnFromInceptionPct ?? 0,
        open_positions_count: snap.openPositionsCount ?? 0,
        drawdown_from_peak_pct: snap.drawdownFromPeakPct ?? 0,
      });
  }

  /** Public price fetch — used by MechanicalTradingService (no Claude cost). */
  /**
   * Risk-monitor extension : capture pathEff + persistence + market_ch1m @ open
   * pour une position venant d'être créée. Best-effort silencieux.
   * - pathEff/persistence via mtfPersistence.analyze
   * - market_ch1m via lookup du symbole dans top_gainers_log (snapshot le plus proche
   *   de l'entry, capture toutes classes uniformément)
   */
  private async captureRiskMonitorFeaturesAtEntry(
    positionId: string,
    symbol: string,
    livePrice: number,
  ): Promise<void> {
    try {
      const update: Record<string, unknown> = {};
      // mtfPersistence — récupère pathEff + persistence multi-TF temps réel
      if (this.mtfPersistence && livePrice > 0) {
        try {
          const analyzed = await this.mtfPersistence.analyze({ symbol, currentPrice: livePrice });
          if (analyzed) {
            if (analyzed.pathQuality?.overallEfficiency != null) {
              update.path_eff_at_entry = analyzed.pathQuality.overallEfficiency;
            }
            if (analyzed.persistenceScore != null) {
              update.persistence_score_at_entry = analyzed.persistenceScore;
            }
            if (analyzed.persistenceCount) {
              update.persistence_count_at_entry = analyzed.persistenceCount;
            }
          }
        } catch (e) {
          this.logger.debug(`[risk-monitor-capture] mtfPersistence ${symbol}: ${String(e).slice(0, 120)}`);
        }
      }
      // market_ch1m : lookup top_gainers_log au plus proche de maintenant (proxy entry)
      try {
        const { data } = await this.supabase.getClient()
          .from('top_gainers_log')
          .select('change_pct')
          .eq('symbol', symbol)
          .order('captured_at', { ascending: false })
          .limit(1);
        if (data?.[0]?.change_pct != null) {
          update.market_ch1m_at_entry = Number(data[0].change_pct);
        }
      } catch (e) {
        this.logger.debug(`[risk-monitor-capture] top_gainers_log ${symbol}: ${String(e).slice(0, 120)}`);
      }
      if (Object.keys(update).length === 0) return;
      const { error } = await this.supabase.getClient()
        .from('lisa_positions')
        .update(update)
        .eq('id', positionId);
      if (error) {
        this.logger.debug(`[risk-monitor-capture] update ${positionId}: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`[risk-monitor-capture] exception ${symbol}: ${String(e).slice(0, 150)}`);
    }
  }

  async getLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    return this.fetchLivePrice(symbol);
  }

  /**
   * PR #250 — Expose paperBroker au scanner Gainers déterministe pour
   * `openPositionDirect` (bypass pipeline LLM proposal/approveProposal).
   */
  getPaperBroker(): PaperBrokerService {
    return this.paperBroker;
  }

  /**
   * Cross-validation oracle pour les indicateurs macro (VIX, DXY).
   *
   * Le brief mécanique appelle `getLivePrice` qui passe par `toEodhdTicker`
   * et un fallback générique (historique de bugs : VIX=100 si EODHD échoue).
   * Cette méthode est un SECOND oracle indépendant qui contacte directement
   * EODHD avec le ticker indice (^VIX.INDX, DX-Y.NYB.FOREX) et fallback
   * sur des valeurs réalistes (18.5, 102.3). Si la valeur retournée par
   * les deux oracles diverge au-delà du seuil, le consumer décide de
   * traiter comme donnée non-fiable.
   *
   * Aucun coût Claude — appel HTTP EODHD direct (gratuit dans le quota).
   */
  async fetchMacroIndicator(
    key: 'VIX' | 'DXY',
  ): Promise<{ value: number; source: 'eodhd' | 'fallback' }> {
    // PR #234 (PR6.9) : tickers canoniques EODHD (drop deprecated formats)
    const ticker = key === 'VIX' ? 'VIX.INDX' : 'DXY.INDX';
    const fallback = key === 'VIX' ? 18.5 : 102.3;
    const eodhKey = this.config.get<string>('EODHD_API_KEY');

    if (!eodhKey || eodhKey === 'demo') {
      return { value: fallback, source: 'fallback' };
    }

    try {
      const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { value: fallback, source: 'fallback' };
      const d = (await res.json()) as Record<string, unknown>;
      const v = Number(d['close'] ?? d['previousClose'] ?? d['open']);
      if (!Number.isFinite(v) || v <= 0) return { value: fallback, source: 'fallback' };
      return { value: v, source: 'eodhd' };
    } catch {
      return { value: fallback, source: 'fallback' };
    }
  }

  private async fetchLivePrice(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    const raw = await this.fetchLivePriceInner(symbol);
    // 🛡️ ZERO_PRICE_GUARD centralisé (incident SEE.LSE 14/05/2026, -$1574) :
    // tout prix <= 0, NaN ou non parsable retourné par fetchLivePriceInner
    // est re-taggé `fallback_unknown` AVANT d'atteindre les consumers. Couvre
    // les chemins qui ne validaient pas (price > 0) leur retour : realtime
    // cache stale à 0, supabase_quotes corrompu, twelvedata candle vide
    // (intraday-router lignes 580-585 : tdLast.close non validé), EODHD
    // /real-time avec close=0 derrière proxy router, etc.
    //
    // Plutôt que de patcher chaque source individuellement, on impose UN
    // invariant sortant : un prix avec source non-fallback DOIT être > 0.
    // Sinon → on re-tag fallback_unknown (sentinel '0', source qui matche
    // déjà tous les garde-fous existants `isFallbackSource` /
    // `startsWith('fallback')` dans mechanical-trading, risk-monitor,
    // rebound-monitor, paper-broker R5 inline).
    const priceNum = Number(raw.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      if (!raw.source.startsWith('fallback')) {
        this.logger.error(
          `[ZERO_PRICE_REJECT] ${symbol}: price=${raw.price} (source=${raw.source}) retourné non-positif — re-tag fallback_unknown (anti-incident SEE.LSE)`,
        );
        return { symbol: raw.symbol, price: '0', asOf: raw.asOf, source: 'fallback_unknown' };
      }
    }
    return this.tagStaleness(raw);
  }

  /**
   * P19-staleness — Tag les quotes périmés avec préfixe `stale_<source>`.
   *
   * Cas catché : TD `/quote` et EODHD `/real-time` retournent `data.close` =
   * dernier OHLC close, qui post-cloche est l'EOD close de la session précédente.
   * `data.timestamp` (TD ms / EODHD sec) est alors lointain. Sans ce tag, les
   * consumers voient `source='twelvedata'` (non-fallback) et exécutent des
   * actions destructives (close à l'EOD close = break-even artificiel).
   *
   * Seuils per-class (fix 26/05 — 0 ouvertures Asia nuit du 25→26/05) :
   * - crypto 24/7 high-frequency : 60s
   * - US/Canada liquides : 180s baseline
   * - EU liquidité moyenne : 300s
   * - Asia small caps + lunch breaks Tokyo/Seoul : 600s
   *
   * `fallback*` n'est pas re-taggé (déjà non-actionnable). `stale_*` non plus
   * (idempotent). Consumers existants (`isFallbackSource` qui catche
   * `startsWith('fallback')`) doivent être étendus pour aussi catcher `stale_`.
   */
  private getStalenessThresholdSec(symbol: string): number {
    const cls = marketForSymbol(symbol);
    switch (cls) {
      case 'crypto': return 60;
      case 'us':     return 180;
      // EU bumped 900→1800s (26/05 12:25 UTC) : EODHD /api/real-time renvoie
      // données délayées 15-20 min par licensing LSE/Euronext non-pro. Seuil
      // 900s rejetait quasi tous les ticks EU. À revert à 900s dès activation
      // BCXE Cboe Europe (TD add-on en attente account manager — request
      // soumise 26/05 11:30 UTC). BCXE = true real-time <1 sec.
      case 'eu':     return 3600;  // 04/06 bumped 1800→3600s (user "ouvre les 3 EU") : LSE EODHD délayé >30min sur certains noms (DEBS/0MDT). Accepte un quote jusqu'à 1h. Sanity-bound 30% reste le filet anti-prix-aberrant.
      case 'asia':   return 1800;  // bumped 600→1800s (Asia small caps lunch breaks Tokyo/Seoul/HK)
      default:       return 180;
    }
  }

  private tagStaleness(q: { symbol: string; price: string; asOf: string; source: string }):
    { symbol: string; price: string; asOf: string; source: string }
  {
    if (!q.source || q.source.startsWith('fallback') || q.source.startsWith('stale_')) return q;
    const asOfMs = Date.parse(q.asOf);
    if (!Number.isFinite(asOfMs)) return q;
    const ageSec = (Date.now() - asOfMs) / 1000;
    const thresholdSec = this.getStalenessThresholdSec(q.symbol);
    if (ageSec > thresholdSec) {
      this.logger.debug(
        `[live-price] ${q.symbol} STALE quote tagged (source=${q.source} → stale_${q.source}, age=${Math.round(ageSec)}s, threshold=${thresholdSec}s)`,
      );
      return { ...q, source: `stale_${q.source}` };
    }
    return q;
  }

  private async fetchLivePriceInner(symbol: string): Promise<{ symbol: string; price: string; asOf: string; source: string }> {
    const eodhKey = this.config.get<string>('EODHD_API_KEY');
    const now = new Date().toISOString();
    let eodhdTicker: string | null = null;

    // 0. Realtime cache (Binance WS pour crypto, refresh EODHD pour le reste)
    const cached = this.realtimePrice.getCached(symbol);
    if (cached) {
      return { symbol, price: cached.price, asOf: cached.asOf, source: cached.source };
    }

    // 0-crypto. FIX chicken-egg crypto (03/06/2026) : le WS Binance ne souscrit
    // que les positions DÉJÀ ouvertes (cf. lisa-autopilot updateActiveCryptoSymbols).
    // Un NOUVEAU candidat crypto (NEAR, OP...) n'a donc pas de cache WS → tombait
    // en `stale_eodhd` → STALE_GUARD bloquait l'ouverture → position jamais ouverte
    // → WS jamais souscrit → boucle. On casse la boucle : pour tout symbole
    // convertible en paire Binance, fetch REST direct (ticker/24hr, lastPrice
    // frais). source='binance_rest' (NON-stale → STALE_GUARD passe). Binance
    // market data = public, pas de clé. Fonctionne depuis Fly (BNBUSDT prouvé).
    const binSym = this.binanceMarket.toBinanceSymbol(symbol);
    if (binSym) {
      const ticker = await this.binanceMarket.getTicker24h(binSym).catch(() => null);
      if (ticker && Number.isFinite(ticker.lastPrice) && ticker.lastPrice > 0) {
        // Alimente le cache realtime pour les checks suivants (cohérence + coût).
        this.realtimePrice.setCached(symbol, String(ticker.lastPrice), 'binance_ws', now);
        return { symbol, price: String(ticker.lastPrice), asOf: now, source: 'binance_rest' };
      }
    }

    // 0bis. Asie (Corée/Chine) : EODHD ne couvre pas le live sur ces marchés
    // (intraday récurremment auto-blacklisté → la cascade EODHD ci-dessous
    // tomberait en `fallback_unknown` → garde-fou fallback skippe tout stop/TP
    // → position non protégeable). TwelveData-first pour les suffixes concernés
    // (KO/KQ/SHG/SHE par défaut). Échec TD → on continue la cascade existante :
    // jamais de stop sur prix non fiable. No-op (retourne null instantané) pour
    // tous les autres marchés → US/EU inchangés.
    const tdLive = await Promise.resolve()
      .then(() => this.intradayRouter.getLiveQuote(symbol))
      .catch(() => null);
    if (tdLive) {
      // P19-staleness — asOf = vrai timestamp du quote TD (pas now). Permet
      // aux consumers (early-exit-guard, R5 sanity) de détecter quote stale
      // post-cloche. data.close de /quote = EOD close si marché fermé.
      const tdAsOf = Number.isFinite(tdLive.quoteTsMs) && tdLive.quoteTsMs > 0
        ? new Date(tdLive.quoteTsMs).toISOString()
        : now;
      return { symbol, price: String(tdLive.price), asOf: tdAsOf, source: tdLive.source };
    }

    // Hard cap EODHD : si quota jour dépassé, on renvoie le cache même
    // périmé (ou fallback statique) pour ne pas violer la limite 100k/j.
    const quotaStatus = await this.realtimePrice.canCallEodhd();
    if (quotaStatus === 'blocked') {
      // Essai dernière chance : cache même trop vieux
      const anyCached = this.realtimePrice.snapshot().find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
      if (anyCached) {
        return { symbol, price: anyCached.price, asOf: new Date(Date.now() - anyCached.ageMs).toISOString(), source: `${anyCached.source}_stale` };
      }
      const fb = this.getFallbackPrice(symbol);
      // Si symbole inconnu de la table fallback : marqué 'fallback_unknown'
      // → garde-fou consumer DOIT skipper toute action destructive.
      return { symbol, price: fb ?? '0', asOf: now, source: fb ? 'fallback_quota_cap' : 'fallback_unknown' };
    }

    // 1. Try EODHD real-time endpoint
    if (eodhKey && eodhKey !== 'demo') {
      const tStart = Date.now();
      // Enregistre le call dans la sliding window RATE LIMIT 1000/min
      this.realtimePrice.recordEodhdCall();
      try {
        eodhdTicker = this.toEodhdTicker(symbol);
        const url = `https://eodhd.com/api/real-time/${encodeURIComponent(eodhdTicker)}?api_token=${eodhKey}&fmt=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const latencyMs = Date.now() - tStart;
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const price = data['close'] ?? data['previousClose'] ?? data['open'];
          if (price && Number(price) > 0) {
            // P19-staleness — EODHD /real-time renvoie `timestamp` (Unix sec).
            // Post-cloche, ce timestamp est celui du dernier tick = peut être
            // l'EOD close de la session précédente. On propage le vrai asOf
            // pour que les consumers détectent la staleness.
            const tsSec = Number(data['timestamp']);
            const eodhdAsOf = Number.isFinite(tsSec) && tsSec > 0
              ? new Date(tsSec * 1000).toISOString()
              : now;
            this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: true, statusCode: res.status, latencyMs, priceUsd: Number(price), calledBy: 'live_price' });
            this.realtimePrice.setCached(symbol, String(price), 'eodhd', eodhdAsOf);
            return { symbol, price: String(price), asOf: eodhdAsOf, source: 'eodhd' };
          }
          this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'live_price', errorMessage: 'empty_price_field' });
        } else {
          this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'live_price', errorMessage: `HTTP_${res.status}` });
        }
      } catch (e) {
        this.logger.warn(`EODHD price fetch failed for ${symbol}: ${String(e)}`);
        this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'eodhd', success: false, latencyMs: Date.now() - tStart, calledBy: 'live_price', errorMessage: String(e).slice(0, 200) });
      }
    }

    // 2. Supabase quotes cache
    const { data: quote } = await this.supabase.getClient()
      .from('quotes')
      .select('price, as_of')
      .ilike('asset_id', `%${symbol}%`)
      .order('as_of', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (quote) {
      this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'supabase_quotes', success: true, priceUsd: Number(quote.price), calledBy: 'live_price' });
      return { symbol, price: String(quote.price), asOf: quote.as_of as string, source: 'supabase_quotes' };
    }

    // 3. Static fallback (simulation still works without live data)
    this.logger.warn(`No quote found for ${symbol}, returning fallback price`);
    const fallback = this.getFallbackPrice(symbol);
    if (fallback === null) {
      // Symbole inconnu de la table : pas de fallback plausible. On signale
      // explicitement 'fallback_unknown' → garde-fou consumer DOIT skipper.
      // Incident 27/04 : ancien code retournait $100 → stop trigger fake price.
      this.logger.error(`[FALLBACK_UNKNOWN] No fallback known for ${symbol} — returning sentinel '0' with source='fallback_unknown'`);
      this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'fallback', success: false, calledBy: 'live_price', errorMessage: 'fallback_unknown_symbol' });
      return { symbol, price: '0', asOf: now, source: 'fallback_unknown' };
    }
    this.logEodhdCall({ ticker: symbol, eodhdTicker, source: 'fallback', success: true, priceUsd: Number(fallback), calledBy: 'live_price' });
    return { symbol, price: fallback, asOf: now, source: 'fallback' };
  }

  /**
   * Log fire-and-forget d'un appel EODHD (ou équivalent). Ne JAMAIS bloquer
   * le chemin live-price — on swallow les erreurs et on n'attend pas la promesse.
   */
  private logEodhdCall(row: {
    ticker: string;
    eodhdTicker: string | null;
    /** PR D — `yahoo` + `stooq` ajoutés pour la cascade multi-provider
     *  VIX/DXY (incident 27/04).
     *  P0-C — `fred` ajouté pour us10y/us2y cascade (FRED Federal Reserve). */
    source: 'eodhd' | 'fallback' | 'supabase_quotes' | 'yahoo' | 'stooq' | 'fred';
    success: boolean;
    statusCode?: number;
    latencyMs?: number;
    priceUsd?: number;
    calledBy: 'live_price' | 'market_snapshot';
    errorMessage?: string;
  }): void {
    (async () => {
      try {
        const { error } = await this.supabase.getClient().from('eodhd_request_log').insert({
          ticker: row.ticker,
          eodhd_ticker: row.eodhdTicker,
          source: row.source,
          success: row.success,
          status_code: row.statusCode ?? null,
          latency_ms: row.latencyMs ?? null,
          price_usd: row.priceUsd ?? null,
          called_by: row.calledBy,
          error_message: row.errorMessage ?? null,
        });
        if (error) this.logger.warn(`eodhd_request_log insert failed: ${error.message}`);
      } catch { /* swallow — log is fire-and-forget */ }
    })();
  }

  /**
   * Convert SmartVest/Binance symbol to EODHD ticker format.
   * BTC → BTC-USD.CC, USDJPY → USDJPY.FOREX, AAPL → AAPL.US
   */
  private toEodhdTicker(symbol: string): string {
    const s = symbol.toUpperCase();
    const cryptoMap: Record<string, string> = {
      'BTC': 'BTC-USD.CC', 'BTCUSDT': 'BTC-USD.CC', 'BITCOIN': 'BTC-USD.CC',
      'BTC-SPOT': 'BTC-USD.CC', 'BTC-USD': 'BTC-USD.CC',
      'ETH': 'ETH-USD.CC', 'ETHUSDT': 'ETH-USD.CC', 'ETHEREUM': 'ETH-USD.CC',
      'ETH-SPOT': 'ETH-USD.CC', 'ETH-USD': 'ETH-USD.CC',
      'SOL': 'SOL-USD.CC', 'SOLUSDT': 'SOL-USD.CC',
      'BNB': 'BNB-USD.CC', 'BNBUSDT': 'BNB-USD.CC',
      'XRP': 'XRP-USD.CC', 'XRPUSDT': 'XRP-USD.CC',
      'ADA': 'ADA-USD.CC', 'ADAUSDT': 'ADA-USD.CC',
      'DOGE': 'DOGE-USD.CC', 'DOGEUSDT': 'DOGE-USD.CC',
      'DOT': 'DOT-USD.CC', 'AVAX': 'AVAX-USD.CC',
      'MATIC': 'MATIC-USD.CC', 'LINK': 'LINK-USD.CC',
      'ATOM': 'ATOM-USD.CC', 'UNI': 'UNI-USD.CC',
      'LTC': 'LTC-USD.CC', 'LTCUSDT': 'LTC-USD.CC',
    };
    if (cryptoMap[s]) return cryptoMap[s];

    // Commodities futures → remplacer par ETFs US tradables (EODHD ne couvre
    // pas les futures .COMM, mais les ETFs équivalents ont une liquidité OK).
    const commodityMap: Record<string, string> = {
      'GC.COMM': 'GLD.US', 'GOLD': 'GLD.US', 'GC': 'GLD.US', 'XAU': 'GLD.US',
      'SI.COMM': 'SLV.US', 'SILVER': 'SLV.US', 'SI': 'SLV.US', 'XAG': 'SLV.US',
      'HG.COMM': 'CPER.US', 'COPPER': 'CPER.US', 'HG': 'CPER.US',
      'NG.COMM': 'UNG.US', 'NATGAS': 'UNG.US', 'NG': 'UNG.US',
      'BZ.COMM': 'BNO.US', 'BRENT': 'BNO.US', 'BZ': 'BNO.US',
      'CL.COMM': 'USO.US', 'WTI': 'USO.US', 'CL': 'USO.US', 'OIL': 'USO.US',
      'PL.COMM': 'PPLT.US', 'PLATINUM': 'PPLT.US',
      'PA.COMM': 'PALL.US', 'PALLADIUM': 'PALL.US',
    };
    if (commodityMap[s]) return commodityMap[s];

    // Indices & volatility — pour VIX et DXY on veut la VALEUR de l'indice,
    // pas le prix d'un ETF proxy (VXX ≠ VIX spot, UUP ≈ 27 vs DXY ≈ 102).
    // Les ETFs d'actions (SPY, QQQ, DIA, IWM) restent OK comme proxy tradable.
    //
    // PR #234 (PR6.9) : VIX/DXY canoniques per CLAUDE.md §6 quater + vendor
    // eodhd-claude-skills :
    //   - VIX = `VIX.INDX` (sans caret, format pur EODHD)
    //   - DXY = `DXY.INDX` puis fallback `USDX.INDX` (DX-Y.NYB.FOREX deprecated)
    // Les anciens alias (`^VIX.INDX`, `DX-Y.NYB.FOREX`) sont conservés en
    // entrée pour back-compat mais redirigés vers le nouveau ticker canonique.
    const indexMap: Record<string, string> = {
      'VIX': 'VIX.INDX', 'VIX.US': 'VIX.INDX', 'VIX.INDX': 'VIX.INDX',
      '^VIX': 'VIX.INDX', '^VIX.INDX': 'VIX.INDX',
      'DXY': 'DXY.INDX', 'DXY.US': 'DXY.INDX', 'DXY.INDX': 'DXY.INDX',
      'DX-Y.NYB': 'DXY.INDX', 'DX-Y.NYB.FOREX': 'DXY.INDX', '^DXY': 'DXY.INDX',
      'USDX': 'DXY.INDX', 'USDX.INDX': 'DXY.INDX',
      'SPX': 'SPY.US', '^SPX': 'SPY.US', 'SPX.INDX': 'SPY.US',
      'NDX': 'QQQ.US', '^NDX': 'QQQ.US', 'NDX.INDX': 'QQQ.US',
      'DJI': 'DIA.US', '^DJI': 'DIA.US',
      'RUT': 'IWM.US', '^RUT': 'IWM.US',
    };
    if (indexMap[s]) return indexMap[s];

    // Bonds & yields — ETFs ou indices yield EODHD
    const bondMap: Record<string, string> = {
      'US10Y': 'TNX.INDX', 'US10Y.BOND': 'TNX.INDX',
      'US2Y': 'IRX.INDX', 'US2Y.BOND': 'IRX.INDX',
      'US5Y': 'FVX.INDX', 'US5Y.BOND': 'FVX.INDX',
      'US30Y': 'TYX.INDX', 'US30Y.BOND': 'TYX.INDX',
      'TLT': 'TLT.US', 'IEF': 'IEF.US', 'SHY': 'SHY.US',
    };
    if (bondMap[s]) return bondMap[s];

    // Already EODHD format (contains a dot)
    if (s.includes('.')) return s;

    // FX pairs: USDJPY → USDJPY.FOREX, EUR-USD → EURUSD.FOREX
    const cleanFx = s.replace('-', '');
    const fxPairs = new Set([
      'USDJPY', 'EURUSD', 'GBPUSD', 'AUDUSD', 'USDCHF', 'USDCAD',
      'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'USDMXN', 'USDINR',
      'USDCNH', 'USDBRL', 'USDTRY', 'USDZAR', 'EURCAD', 'EURCHF',
    ]);
    if (fxPairs.has(cleanFx)) return `${cleanFx}.FOREX`;

    // VIX / volatility products
    if (s === 'VXX' || s === 'UVXY' || s === 'SVXY') return `${s}.US`;

    // Default: US equity/ETF
    return `${s}.US`;
  }

  /** Approximate fallback prices (order-of-magnitude, simulation only).
   *
   * Doit couvrir tous les tickers macro que `getLivePrice` peut recevoir, sinon
   * le default `100.00` est interprété comme valeur réelle par les briefings
   * (ex. VIX=100 → choc marché simulé → cascade défensive en boucle).
   *
   * Les valeurs ici sont volontairement statiques et "plausibles", elles
   * servent uniquement de filet de sécurité quand EODHD échoue ET le cache
   * Supabase est vide. Un système de fallback ne doit JAMAIS retourner une
   * valeur cohérente dans la plage de panique d'un agent en aval.
   *
   * Retourne `null` si le symbole est inconnu — le caller DOIT alors traiter
   * comme "pas de prix disponible" et skipper toute décision destructive.
   * Incident 27/04/2026 : LMT non listé → fallback générique $100 → stop
   * triggered sur prix factice → liquidation -80 % d'une position $513.
   */
  private getFallbackPrice(symbol: string): string | null {
    const s = symbol.toUpperCase().replace('-', '');
    const prices: Record<string, string> = {
      // Crypto majors (CRYPTO_PAIRS)
      'BTC': '79000', 'BTCUSDT': '79000', 'BTCSPOT': '79000', 'BTCUSD': '79000',
      'ETH': '1800', 'ETHUSDT': '1800', 'ETHSPOT': '1800',
      'SOL': '130', 'SOLUSDT': '130',
      'BNB': '550', 'BNBUSDT': '550',
      'XRP': '2.1', 'XRPUSDT': '2.1',
      'ADA': '0.7', 'ADAUSDT': '0.7',
      // Crypto alts (CRYPTO_ALTS) — Bug observé 02/06 : ICPUSDT pump 4/6
      // persistence score=0.67 mais skip cause `fallback_unknown`. Ces
      // fallbacks débloquent les opens crypto quand Binance temporairement
      // indispo. Prix indicatifs juin 2026, à recalibrer trimestriellement.
      'DOT': '7', 'DOTUSDT': '7',
      'POL': '0.30', 'POLUSDT': '0.30', 'MATIC': '0.30', 'MATICUSDT': '0.30',
      'AVAX': '40', 'AVAXUSDT': '40',
      'LINK': '18', 'LINKUSDT': '18',
      'DOGE': '0.15', 'DOGEUSDT': '0.15',
      'SHIB': '0.000020', 'SHIBUSDT': '0.000020',
      'TRX': '0.15', 'TRXUSDT': '0.15',
      'ATOM': '7', 'ATOMUSDT': '7',
      'LTC': '90', 'LTCUSDT': '90',
      'UNI': '7', 'UNIUSDT': '7',
      'AAVE': '115', 'AAVEUSDT': '115',
      'ARB': '0.70', 'ARBUSDT': '0.70',
      'OP': '1.5', 'OPUSDT': '1.5',
      'SUI': '1.3', 'SUIUSDT': '1.3',
      'APT': '7', 'APTUSDT': '7',
      'SEI': '0.45', 'SEIUSDT': '0.45',
      'TIA': '5', 'TIAUSDT': '5',
      'BCH': '400', 'BCHUSDT': '400',
      'INJ': '14', 'INJUSDT': '14',
      'NEAR': '5', 'NEARUSDT': '5',
      'ICP': '7', 'ICPUSDT': '7',
      'STX': '1.5', 'STXUSDT': '1.5',
      'FIL': '4', 'FILUSDT': '4',
      'IMX': '1', 'IMXUSDT': '1',
      // Métaux & matières premières
      'GOLD': '3300', 'GC': '3300', 'GLD': '310', 'IAU': '50',
      'SILVER': '33', 'SLV': '31', 'SI': '33',
      'USO': '75', 'BRENT': '78', 'CL': '78',
      // Equity / ETFs principaux
      'SPY': '545', 'QQQ': '455', 'IWM': '195',
      'AAPL': '195', 'MSFT': '405', 'NVDA': '870', 'AMZN': '195',
      // Defense names (univers récurrent en geopolitical_stress)
      'LMT': '510', 'RTX': '175', 'NOC': '500', 'GD': '300', 'BA': '180', 'GE': '200',
      // Energy / Mining usuels
      'XLE': '95', 'XOM': '115', 'CVX': '160', 'GDX': '40', 'NEM': '55',
      // FX (paires sans tiret)
      'USDJPY': '155', 'EURUSD': '1.08', 'GBPUSD': '1.27',
      'USDCHF': '0.90', 'AUDUSD': '0.64', 'USDCAD': '1.38',
      // Volatilité
      'VIX': '18.5', 'VXX': '18', 'UVXY': '8',
      // FX index
      'DXY': '102.3',
      // Bonds / yields (approximations en %)
      'US10Y': '4.2', 'TNX': '4.2',
      'US2Y': '3.9', 'IRX': '3.9',
      'US5Y': '4.1', 'FVX': '4.1',
      'US30Y': '4.4', 'TYX': '4.4',
      'TLT': '90', 'IEF': '95', 'HYG': '76', 'LQD': '108',
    };
    return prices[s] ?? null;
  }

  /**
   * Refactor market_snapshot tâche B (17/05) — détermine si le marché d un
   * ticker macro est ouvert à l instant t.
   *
   * - FOREX (.FOREX)         : ouvert dimanche 22h UTC → vendredi 22h UTC
   * - Commodities (.COMM)    : suivent forex (24/5)
   * - US equities (.US)      : lun-ven 13h-21h UTC (tolère pre/post market)
   * - Crypto (.CC)           : toujours ouvert (24/7)
   * - Indices Yahoo (^TNX, ^IRX, ^VIX) et DX-Y.NYB : pas de filtre weekend ici
   *
   * Si fermé : le caller doit retourner null sans appel HTTP ni log d erreur,
   * pour économiser ~2300 calls EODHD/jour (mesuré 17 mai dimanche matin).
   * Visible (public) pour les tests unitaires Jest.
   */
  isMacroTickerMarketOpen(ticker: string, now: Date = new Date()): boolean {
    const day = now.getUTCDay(); // 0=dimanche, 6=samedi
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();

    // Crypto et indices Yahoo : pas de filtre weekend ici
    if (ticker.endsWith('.CC')) return true;
    if (ticker.startsWith('^') || ticker === 'DX-Y.NYB') return true;

    // FOREX : ouvert dimanche 22h UTC → vendredi 22h UTC
    if (ticker.endsWith('.FOREX')) {
      if (day === 6) return false; // samedi fermé toute la journée
      if (day === 0 && minuteOfDay < 22 * 60) return false; // dimanche avant 22h UTC
      if (day === 5 && minuteOfDay >= 22 * 60) return false; // vendredi après 22h UTC
      return true;
    }

    // Commodities : même règle que forex
    if (ticker.endsWith('.COMM')) {
      if (day === 6) return false;
      if (day === 0 && minuteOfDay < 22 * 60) return false;
      if (day === 5 && minuteOfDay >= 22 * 60) return false;
      return true;
    }

    // US equities (.US) : lun-ven 13h-21h UTC (tolère pre/post market étendu)
    if (ticker.endsWith('.US')) {
      if (day === 0 || day === 6) return false; // weekend
      if (minuteOfDay < 13 * 60 || minuteOfDay >= 21 * 60) return false;
      return true;
    }

    // Par défaut : considérer ouvert (ne pas filtrer agressivement)
    return true;
  }

  /**
   * PR #341 — détermine si TOUS les `attempts` d'une cascade ciblent des
   * marchés fermés (.US/.FOREX/.COMM hors session). Si oui, le caller skip
   * silencieusement les calls HTTP.
   *
   * Exemptions : FRED (EOD officiel servi 24/7), Yahoo indices (^VIX, ^TNX,
   * ^IRX), DX-Y.NYB, crypto (.CC) — ces sources renvoient un last-close
   * acceptable même hors session.
   *
   * Visible (public) pour tests unitaires Jest.
   */
  isCascadeFullyClosed(
    attempts: Array<{
      ticker: string;
      source?: 'eodhd' | 'yahoo' | 'stooq' | 'fred';
      multiplier?: number;
      quality?: 'live' | 'proxy';
    }>,
    now: Date = new Date(),
  ): boolean {
    if (attempts.length === 0) return false;
    return attempts.every((a) => {
      const src = a.source ?? 'eodhd';
      if (src === 'fred') return false;
      if (a.ticker.startsWith('^') || a.ticker === 'DX-Y.NYB') return false;
      if (a.ticker.endsWith('.CC')) return false;
      // PR #363 — Yahoo FX/futures continuous (GC=F, SI=F, EURUSD=X,
      // USDJPY=X, etc.) servent un last-close 24/7. Ne pas skip weekend.
      if (src === 'yahoo' && (a.ticker.endsWith('=F') || a.ticker.endsWith('=X'))) return false;
      return !this.isMacroTickerMarketOpen(a.ticker, now);
    });
  }

  /**
   * Refactor market_snapshot tâche C (17/05) — fetch dédié crypto via
   * endpoint live (/api/real-time) avec timeout long (5s) et SANS retry.
   *
   * Constat 17/05 sur 7j : BTC-USD.CC et ETH-USD.CC ont 40-50 % d erreurs
   * timeout via `fetchWithRetry` (1500ms × 3) — l endpoint /real-time est
   * stable mais répond parfois lentement sur les CC. Un seul fetch avec 5s
   * de tolérance suffit. Log conservé sous `calledBy='market_snapshot'`
   * pour permettre la mesure du gain post-deploy.
   */
  private async fetchLivePriceForMacro(ticker: string, eodhKey: string): Promise<number | null> {
    const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
    const tStart = Date.now();
    let statusCode: number | null = null;
    let priceUsd: number | null = null;

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      statusCode = res.status;
      if (!res.ok) {
        this.logEodhdCall({
          ticker, eodhdTicker: ticker, source: 'eodhd', success: false,
          statusCode, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot',
          errorMessage: `HTTP_${statusCode}`,
        });
        return null;
      }
      const d = await res.json() as Record<string, unknown>;
      const v = Number(d['close'] ?? d['previousClose'] ?? d['open'] ?? d['last']);
      if (Number.isFinite(v) && v > 0) {
        priceUsd = v;
        this.logEodhdCall({
          ticker, eodhdTicker: ticker, source: 'eodhd', success: true,
          statusCode, latencyMs: Date.now() - tStart, priceUsd, calledBy: 'market_snapshot',
        });
        return v;
      }
      this.logEodhdCall({
        ticker, eodhdTicker: ticker, source: 'eodhd', success: false,
        statusCode, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot',
        errorMessage: 'empty_price_field',
      });
      return null;
    } catch (e) {
      this.logEodhdCall({
        ticker, eodhdTicker: ticker, source: 'eodhd', success: false,
        latencyMs: Date.now() - tStart, calledBy: 'market_snapshot',
        errorMessage: String(e).slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Fetch live market snapshot via EODHD avec **fallback chain à 3 niveaux** :
   *
   *   1. LIVE   : ticker primaire EODHD
   *   2. PROXY  : ETF approximatif (ex: VXX→VIX, UUP→DXY) si LIVE échoue
   *   3. FALLBACK : valeur hardcoded statique (DANGER — masque le problème)
   *
   * RETEX 27/04 : tickers ^VIX.INDX, DX-Y.NYB.FOREX, US10Y.BOND, GC.COMM,
   * SI.COMM, BZ.COMM, etc. retournent systématiquement empty_price_field
   * ou HTTP 404. Lisa recevait donc 18.5/102.3/4.2 hardcoded sur 100% des
   * cycles → briefing macro figé → 13 cycles identiques.
   *
   * Le tracking dataQuality (live/proxy/fallback) permet à Lisa de savoir
   * que le snapshot est partiel et d'être conservatrice sur son diagnostic.
   */
  /** Public — utilisé par le kill-switch dataQuality côté autopilot (PATCH 1).
   *  Le caller doit vérifier `result.dataQuality?.degraded` avant de lancer
   *  un cycle Lisa coûteux si `allowDegradedMacro = false`. */
  async fetchMarketSnapshot(): Promise<MarketSnapshot> {
    const eodhKey = this.config.get<string>('EODHD_API_KEY');

    // Static fallback (3e niveau, dernier recours)
    const fallback: MarketSnapshot = {
      timestamp: new Date().toISOString(),
      vix: 18.5, usdDxy: 102.3, us10yYield: 4.2, us2yYield: 3.9,
      brentUsd: 78.0, btcUsd: 105000, ethUsd: 3500, goldUsd: 3300,
      sp500: 5800, nasdaq: 18500, eurUsd: 1.08, usdJpy: 152,
      creditHyOasBps: 320, creditIgOasBps: 95,
      recentNews: [], upcomingEvents: [],
    };

    if (!eodhKey || eodhKey === 'demo') {
      // Pas de clé EODHD → tous les indicateurs sont en fallback hardcoded.
      // On retourne dataQuality.degraded = true pour que l'autopilot skip.
      const allIndicators = ['vix', 'dxy', 'us10y', 'us2y', 'brent', 'gold',
        'silver', 'btc', 'eth', 'spy', 'qqq', 'eurusd', 'usdjpy',
        'creditHyOas', 'creditIgOas'];
      return {
        ...fallback,
        dataQuality: {
          live: [],
          proxy: [],
          fallback: allIndicators,
          degraded: computeDataQualityDegraded(allIndicators),
        },
      };
    }

    const dataQuality = {
      live: [] as string[],
      proxy: [] as string[],
      fallback: [] as string[],
      stale: [] as string[],
    };

    // P0-B — Counters in-memory pour metric macro_quote_source.
    const incCounter = (symbol: string, source: string, status: 'ok' | 'fail') => {
      const key = `${symbol}:${source}:${status}`;
      this.quoteSourceCounters.set(key, (this.quoteSourceCounters.get(key) ?? 0) + 1);
    };

    // Refactor market_snapshot 17/05 — flags rollback en moins de 30s via Fly secrets.
    const weekendSkipEnabled = process.env.MARKET_SNAPSHOT_WEEKEND_SKIP_ENABLED !== 'false';
    const cryptoViaLivePrice = process.env.MARKET_SNAPSHOT_CRYPTO_VIA_LIVE_PRICE !== 'false';

    const fetchNum = async (ticker: string): Promise<number | null> => {
      // Tâche B — skip silencieux si marché fermé (forex/commodities/.US le weekend).
      // Pas de HTTP, pas d entrée eodhd_request_log : c est le coeur de l économie.
      if (weekendSkipEnabled && !this.isMacroTickerMarketOpen(ticker)) {
        return null;
      }
      // Tâche C — crypto via /real-time avec timeout long sans retry (40-50 % moins d erreurs).
      if (cryptoViaLivePrice && ticker.endsWith('.CC')) {
        this.realtimePrice.recordEodhdCall();
        const cv = await this.fetchLivePriceForMacro(ticker, eodhKey);
        incCounter(ticker, 'eodhd', cv != null ? 'ok' : 'fail');
        return cv;
      }
      // P0-B — wrapping fetchWithRetry : timeout 1500ms, retry 2x, backoff 250ms.
      this.realtimePrice.recordEodhdCall();
      const v = await fetchWithRetry(async (signal) => {
        const tStart = Date.now();
        try {
          const url = `https://eodhd.com/api/real-time/${encodeURIComponent(ticker)}?api_token=${eodhKey}&fmt=json`;
          const res = await fetch(url, { signal });
          const latencyMs = Date.now() - tStart;
          if (!res.ok) {
            this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: `HTTP_${res.status}` });
            return null;
          }
          const d = await res.json() as Record<string, unknown>;
          const v = Number(d['close'] ?? d['previousClose'] ?? d['open'] ?? d['last']);
          const ok = isFinite(v) && v > 0;
          if (ok) {
            this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: true, statusCode: res.status, latencyMs, priceUsd: v, calledBy: 'market_snapshot' });
            return v;
          }
          this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: 'empty_price_field' });
          return null;
        } catch (e) {
          this.logEodhdCall({ ticker, eodhdTicker: ticker, source: 'eodhd', success: false, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot', errorMessage: String(e).slice(0, 200) });
          throw e; // remonte pour que fetchWithRetry retente
        }
      }, { maxAttempts: 3, backoffMs: 250, timeoutMs: 1500 });
      incCounter(ticker, 'eodhd', v != null ? 'ok' : 'fail');
      return v;
    };

    /**
     * P0-B — Yahoo Finance fallback pour VIX/DXY. PRIMARY source au lieu
     * de secondary (PR #19 avait yahoo en 2nd, mais yahoo est plus fiable
     * sur VIX que EODHD VIX.INDX qui retourne empty_price_field).
     *
     * Wrap fetchWithRetry : timeout 1500ms, 2 retries, backoff 250ms.
     * Logged via logEodhdCall avec source='yahoo' pour observability.
     */
    const fetchYahoo = async (symbol: string): Promise<number | null> => {
      const v = await fetchWithRetry(async (signal) => {
        const tStart = Date.now();
        try {
          const url = buildYahooChartUrl(symbol);
          const res = await fetch(url, {
            signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartVest/1.0)' },
          });
          const latencyMs = Date.now() - tStart;
          if (!res.ok) {
            this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'yahoo', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: `HTTP_${res.status}` });
            return null;
          }
          const json = await res.json() as unknown;
          const parsed = parseYahooChartResponse(json);
          if (parsed != null) {
            this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'yahoo', success: true, statusCode: res.status, latencyMs, priceUsd: parsed, calledBy: 'market_snapshot' });
            return parsed;
          }
          this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'yahoo', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: 'parser_returned_null' });
          return null;
        } catch (e) {
          this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'yahoo', success: false, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot', errorMessage: String(e).slice(0, 200) });
          throw e;
        }
      }, { maxAttempts: 3, backoffMs: 250, timeoutMs: 1500 });
      incCounter(symbol, 'yahoo', v != null ? 'ok' : 'fail');
      return v;
    };

    const fetchStooq = async (symbol: string): Promise<number | null> => {
      const v = await fetchWithRetry(async (signal) => {
        const tStart = Date.now();
        try {
          const url = buildStooqCsvUrl(symbol);
          const res = await fetch(url, { signal });
          const latencyMs = Date.now() - tStart;
          if (!res.ok) {
            this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'stooq', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: `HTTP_${res.status}` });
            return null;
          }
          const text = await res.text();
          const parsed = parseStooqCsvResponse(text);
          if (parsed != null) {
            this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'stooq', success: true, statusCode: res.status, latencyMs, priceUsd: parsed, calledBy: 'market_snapshot' });
            return parsed;
          }
          this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'stooq', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: 'parser_returned_null' });
          return null;
        } catch (e) {
          this.logEodhdCall({ ticker: symbol, eodhdTicker: symbol, source: 'stooq', success: false, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot', errorMessage: String(e).slice(0, 200) });
          throw e;
        }
      }, { maxAttempts: 3, backoffMs: 250, timeoutMs: 1500 });
      incCounter(symbol, 'stooq', v != null ? 'ok' : 'fail');
      return v;
    };

    /**
     * P0-C — FRED `series/observations` pour DGS10, DGS2, etc. Inerte si
     * `FRED_API_KEY` non set. 120 req/min limit (largement sous notre rythme).
     *
     * Note : FRED publie en fin de journée US (~16:00 EST), donc en intraday
     * la valeur est celle du business day précédent. Pas idéal pour scalp
     * intraday mais largement OK comme baseline macro.
     */
    const fredKey = this.config.get<string>('FRED_API_KEY') ?? null;
    const fetchFred = async (seriesId: string): Promise<number | null> => {
      const url = buildFredObservationsUrl(seriesId, fredKey);
      if (!url) return null;
      const v = await fetchWithRetry(async (signal) => {
        const tStart = Date.now();
        try {
          const res = await fetch(url, { signal });
          const latencyMs = Date.now() - tStart;
          if (!res.ok) {
            this.logEodhdCall({ ticker: seriesId, eodhdTicker: seriesId, source: 'fred', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: `HTTP_${res.status}` });
            return null;
          }
          const json = await res.json() as unknown;
          const parsed = parseFredObservationsResponse(json);
          if (parsed != null) {
            this.logEodhdCall({ ticker: seriesId, eodhdTicker: seriesId, source: 'fred', success: true, statusCode: res.status, latencyMs, priceUsd: parsed, calledBy: 'market_snapshot' });
            return parsed;
          }
          this.logEodhdCall({ ticker: seriesId, eodhdTicker: seriesId, source: 'fred', success: false, statusCode: res.status, latencyMs, calledBy: 'market_snapshot', errorMessage: 'fred_parser_returned_null' });
          return null;
        } catch (e) {
          this.logEodhdCall({ ticker: seriesId, eodhdTicker: seriesId, source: 'fred', success: false, latencyMs: Date.now() - tStart, calledBy: 'market_snapshot', errorMessage: String(e).slice(0, 200) });
          throw e;
        }
      }, { maxAttempts: 3, backoffMs: 250, timeoutMs: 1500 });
      incCounter(seriesId, 'fred', v != null ? 'ok' : 'fail');
      return v;
    };

    /**
     * Tente plusieurs tickers en cascade. Retourne la 1re valeur valide
     * + identifie la qualité (live primary OU proxy ETF).
     *
     * PR D — chaque attempt peut spécifier `source`.
     * P0-C — `'fred'` ajouté pour us10y/us2y/VIX cascade (FRED Federal Reserve).
     */
    const fetchCascade = async (
      indicator: string,
      attempts: Array<{
        ticker: string;
        source?: 'eodhd' | 'yahoo' | 'stooq' | 'fred';
        multiplier?: number;
        quality: 'live' | 'proxy';
      }>,
    ): Promise<number | null> => {
      // PR #341 — early-return silencieux si TOUS les tickers de la cascade
      // ciblent des marchés fermés (.US/.FOREX/.COMM hors session). Évite 9
      // ERROR logs/heure le weekend sur cron market_snapshot (silver, gold,
      // lqd, hyg, usdjpy, eurusd, qqq, spy, brent) en short-circuitant avant
      // tout call HTTP qui retournerait null de toute façon.
      //
      // Exemptions :
      //   - source 'fred' : sert l'EOD officiel même le weekend
      //   - ticker '^...' ou 'DX-Y.NYB' (Yahoo) : last-close servi 24/7
      //   - ticker '.CC' (crypto) : 24/7
      //
      // Kill-switch : LISA_MACRO_WEEKEND_FILTER_ENABLED=false (default ON).
      const macroWeekendFilterEnabled =
        process.env.LISA_MACRO_WEEKEND_FILTER_ENABLED !== 'false';
      if (macroWeekendFilterEnabled && this.isCascadeFullyClosed(attempts)) {
        const cached = this.lastKnownMacroValues.get(indicator);
        if (cached && Date.now() - cached.timestamp < this.LAST_KNOWN_TTL_MS) {
          dataQuality.stale.push(
            `${indicator}(last_known_age=${Math.round((Date.now() - cached.timestamp) / 60_000)}min, weekend_skip)`,
          );
          this.logger.debug(
            `[macro] ${indicator} weekend skip — serving last-known $${cached.value.toFixed(2)} (age ${Math.round((Date.now() - cached.timestamp) / 60_000)}min)`,
          );
          return cached.value;
        }
        dataQuality.fallback.push(indicator);
        this.logger.debug(
          `[macro] ${indicator} weekend skip — all sources closed, falling through to hardcoded default (silent)`,
        );
        return null;
      }

      for (const a of attempts) {
        const source = a.source ?? 'eodhd';
        let v: number | null = null;
        if (source === 'eodhd') v = await fetchNum(a.ticker);
        else if (source === 'yahoo') v = await fetchYahoo(a.ticker);
        else if (source === 'stooq') v = await fetchStooq(a.ticker);
        else if (source === 'fred') v = await fetchFred(a.ticker);
        if (v !== null) {
          const finalValue = a.multiplier ? v * a.multiplier : v;
          if (a.quality === 'live') {
            // P0-B — toujours tagger la source réelle utilisée (vs PR #19
            // qui ne taggait que les non-eodhd). Permet de distinguer
            // `vix(via eodhd:VIX.INDX)` de `vix(via yahoo:^VIX)` dans les
            // dashboards d'observability.
            dataQuality.live.push(`${indicator}(via ${source}:${a.ticker})`);
          } else {
            dataQuality.proxy.push(`${indicator}(via ${source}:${a.ticker})`);
          }
          // P0-B — on conserve la valeur en last-known cache pour stale
          // serving sur les cycles suivants en cas de panne providers.
          this.lastKnownMacroValues.set(indicator, { value: finalValue, timestamp: Date.now() });
          return finalValue;
        }
      }

      // P0-B — Toutes les sources ont échoué. On tente le last-known cache
      // (TTL 24h) AVANT de tomber sur le fallback hardcoded. La valeur est
      // marquée `dataQuality.stale=true` pour que le caller (Lisa) sache
      // qu'elle est datée.
      const cached = this.lastKnownMacroValues.get(indicator);
      if (cached && Date.now() - cached.timestamp < this.LAST_KNOWN_TTL_MS) {
        dataQuality.stale.push(`${indicator}(last_known_age=${Math.round((Date.now() - cached.timestamp) / 60_000)}min)`);
        this.logger.error(
          `[macro] ${indicator} all sources failed — serving last-known $${cached.value.toFixed(2)} (age ${Math.round((Date.now() - cached.timestamp) / 60_000)}min)`,
        );
        return cached.value;
      }

      // Pas de last-known utilisable → fallback hardcoded final.
      dataQuality.fallback.push(indicator);
      this.logger.error(
        `[macro] ${indicator} all sources failed AND no last-known cache — falling through to hardcoded default`,
      );
      return null;
    };

    // ── Lance toutes les requêtes en parallèle ─────────────────────
    const [
      vix, dxy, us10y, us2y, brent, btc, eth, gold,
      spy, qqq, eurusd, usdjpy,
      silver, hyg, lqd,
    ] = await Promise.all([
      // VIX cascade — P0-B : YAHOO PRIMARY (était 2nd en PR #19 → ne
      // résolvait jamais en prod 28/04 04:00 UTC). Ordre :
      // VIX cascade — Pas de dépendance AlphaVantage (pas de clé user dispo).
      //   1. yahoo:^VIX     (primary, no auth, intraday)
      //   2. fred:VIXCLS    (Fed officiel EOD, FRED_API_KEY gratuit)
      //   3. eodhd:VIX.INDX (legacy, souvent empty_price_field)
      //   4. stooq:^vix     (CSV public no-auth)
      //   5. eodhd:VXX.US   (proxy ETF, decay vs VIX)
      // Chaque attempt : retry 2 backoff 250ms timeout 1500ms.
      // Si tout échoue → last-known cache (24h TTL) avant fallback hardcoded.
      fetchCascade('vix', [
        { ticker: '^VIX', source: 'yahoo', quality: 'live' },
        { ticker: 'VIXCLS', source: 'fred', quality: 'live' },
        { ticker: 'VIX.INDX', source: 'eodhd', quality: 'live' },
        { ticker: '^vix', source: 'stooq', quality: 'live' },
        { ticker: 'VXX.US', source: 'eodhd', quality: 'proxy' },
      ]),
      // DXY cascade — Pas de dépendance AlphaVantage. FRED DTWEX* est un
      // index trade-weighted différent de DXY (méthodologie distincte) →
      // pas inclus pour ne pas tromper Lisa avec une valeur sémantiquement
      // différente. UUP ETF proxy en bout de chaîne couvre la dégradation.
      fetchCascade('dxy', [
        { ticker: 'DX-Y.NYB', source: 'yahoo', quality: 'live' },
        { ticker: 'DXY.INDX', source: 'eodhd', quality: 'live' },
        { ticker: 'USDX.INDX', source: 'eodhd', quality: 'live' },
        { ticker: '^dxy', source: 'stooq', quality: 'live' },
        { ticker: 'UUP.US', source: 'eodhd', multiplier: 4.1, quality: 'proxy' },
      ]),
      // us10y cascade — Pas de dépendance AlphaVantage TREASURY_YIELD.
      //   1. yahoo:^TNX     (primary, intraday)
      //   2. eodhd:TNX.INDX (legacy, souvent empty)
      //   3. fred:DGS10     (Fed officiel EOD, FRED gratuit)
      //   4. stooq:us10yb.u (CSV public)
      //   + last-known cache 24h
      fetchCascade('us10y', [
        { ticker: '^TNX', source: 'yahoo', quality: 'live' },
        { ticker: 'TNX.INDX', source: 'eodhd', quality: 'live' },
        { ticker: 'DGS10', source: 'fred', quality: 'live' },
        { ticker: 'us10yb.u', source: 'stooq', quality: 'live' },
      ]),
      // us2y cascade similaire
      fetchCascade('us2y', [
        { ticker: '^IRX', source: 'yahoo', quality: 'live' }, // 13-week T-Bill (proxy court terme)
        { ticker: 'IRX.INDX', source: 'eodhd', quality: 'live' },
        { ticker: 'DGS2', source: 'fred', quality: 'live' },
      ]),
      // Brent : .COMM 404 systématique côté EODHD → retiré (refactor A 17/05).
      // Cascade conservée avec USO ETF proxy (× 1.05 ≈ proche WTI/Brent).
      fetchCascade('brent', [
        { ticker: 'USO.US', multiplier: 1.05, quality: 'proxy' },
      ]),
      // Crypto : OK
      fetchCascade('btc', [
        { ticker: 'BTC-USD.CC', quality: 'live' },
      ]),
      fetchCascade('eth', [
        { ticker: 'ETH-USD.CC', quality: 'live' },
      ]),
      // Gold cascade — PR #363 (19/05/2026) : YAHOO PRIMARY car EODHD
      // XAUUSD.FOREX renvoie HTTP 200 empty_price_field 14-50% du temps
      // (audit 19/05 18h UTC, 4 ERROR LisaService macro/h corrélés).
      // Yahoo GC=F (gold futures continuous) = data temps réel sans auth.
      //   1. yahoo:GC=F        (primary)
      //   2. eodhd:XAUUSD.FOREX (legacy, fréquemment empty)
      //   3. eodhd:GLD.US x10  (ETF proxy)
      fetchCascade('gold', [
        { ticker: 'GC=F', source: 'yahoo', quality: 'live' },
        { ticker: 'XAUUSD.FOREX', source: 'eodhd', quality: 'live' },
        { ticker: 'GLD.US', source: 'eodhd', multiplier: 10, quality: 'proxy' },
      ]),
      // ETFs OK directs
      fetchCascade('spy', [{ ticker: 'SPY.US', quality: 'live' }]),
      fetchCascade('qqq', [{ ticker: 'QQQ.US', quality: 'live' }]),
      // EURUSD cascade — PR #363 : YAHOO PRIMARY (EURUSD=X) car EODHD
      // EURUSD.FOREX renvoie occasionnellement empty_price_field.
      fetchCascade('eurusd', [
        { ticker: 'EURUSD=X', source: 'yahoo', quality: 'live' },
        { ticker: 'EURUSD.FOREX', source: 'eodhd', quality: 'live' },
      ]),
      // USDJPY cascade — PR #363 : YAHOO PRIMARY (USDJPY=X) même motif.
      fetchCascade('usdjpy', [
        { ticker: 'USDJPY=X', source: 'yahoo', quality: 'live' },
        { ticker: 'USDJPY.FOREX', source: 'eodhd', quality: 'live' },
      ]),
      // Silver cascade — PR #363 : YAHOO PRIMARY (SI=F silver futures)
      // car XAGUSD.FOREX 16 empty/h observés 19/05 18h UTC.
      fetchCascade('silver', [
        { ticker: 'SI=F', source: 'yahoo', quality: 'live' },
        { ticker: 'XAGUSD.FOREX', source: 'eodhd', quality: 'live' },
        { ticker: 'SLV.US', source: 'eodhd', quality: 'proxy' },
      ]),
      // HYG ETF pour proxy de credit HY OAS spread
      fetchCascade('hyg', [{ ticker: 'HYG.US', quality: 'live' }]),
      // LQD ETF pour proxy de credit IG OAS spread
      fetchCascade('lqd', [{ ticker: 'LQD.US', quality: 'live' }]),
    ]);

    void silver;

    // ── Credit OAS — proxy linéaire via prix ETF ───────────────────────
    // Baselines avr 2026 : HYG ≈ $78 ↔ HY OAS ~320bps · LQD ≈ $108 ↔ IG OAS ~95bps.
    // Sensibilité ~30bps par 1% de variation de prix (approximation grossière,
    // duration HY ~3-4y, IG ~7y). Direction fiable, niveau ±15-25%.
    // Si l'ETF ne répond pas → fallback hardcoded marqué comme tel.
    const HYG_BASE_PRICE = 78;
    const HYG_BASE_OAS = 320;
    const LQD_BASE_PRICE = 108;
    const LQD_BASE_OAS = 95;
    const BPS_PER_PCT = 30;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

    let creditHyOasBps = fallback.creditHyOasBps;
    if (hyg !== null) {
      const pctDelta = (hyg / HYG_BASE_PRICE - 1) * 100;
      creditHyOasBps = clamp(Math.round(HYG_BASE_OAS - pctDelta * BPS_PER_PCT), 80, 1500);
      dataQuality.proxy.push('creditHyOas(via HYG)');
    } else {
      dataQuality.fallback.push('creditHyOas');
    }

    let creditIgOasBps = fallback.creditIgOasBps;
    if (lqd !== null) {
      const pctDelta = (lqd / LQD_BASE_PRICE - 1) * 100;
      creditIgOasBps = clamp(Math.round(LQD_BASE_OAS - pctDelta * BPS_PER_PCT), 30, 800);
      dataQuality.proxy.push('creditIgOas(via LQD)');
    } else {
      dataQuality.fallback.push('creditIgOas');
    }

    // PATCH 1 — calcul du flag dégradé pour le kill-switch autopilot.
    const dataQualityWithDegraded = {
      ...dataQuality,
      degraded: computeDataQualityDegraded(dataQuality.fallback),
    };

    // P1 — Classifier le régime tactique courant à partir des indicateurs
    // qu'on vient de fetcher. Le service cache 5 min en interne et persiste
    // dans market_regimes_log.
    //
    // PR feat/regime-inputs-binance — enrichissement des inputs depuis
    // Binance Spot/Futures :
    //  - btc24hReturnPct exact via /api/v3/ticker/24hr (priceChangePct)
    //  - btcFundingPct via /fapi/v1/premiumIndex (fundingRatePct, 8h period)
    //
    // Inputs encore null (cycles à venir) :
    //  - atr14BtcPct, atr50BtcPct → EodhdTechnicalService BTC bars
    //  - newsScore → NewsRankerService aggregate
    //  - realized1hPct → BinanceMarketService 1m klines 60min
    //  - redditSpikeSigma → RedditService
    let tacticalRegime: ReturnType<typeof this.marketRegime.peekCurrentRegime> = null;
    try {
      // Fetch Binance enrichment (avec timeout court + parallèle pour éviter
      // de bloquer le snapshot si Binance ralentit).
      // - 24h ticker : btc24hReturnPct
      // - futures premium index : btcFundingPct
      // - 51 daily klines : ATR14 + ATR50 BTC pour détection RANGE
      // - 61 1m klines : realized 1h vol pour détection VOL_SPIKE intraday
      const [ticker24h, futureStats, dailyKlines, minute1Klines] = await Promise.all([
        this.binanceMarket.getTicker24h('BTCUSDT').catch(() => null),
        this.binanceMarket.getFutureStats('BTCUSDT').catch(() => null),
        this.binanceMarket.getKlines('BTCUSDT', '1d', 51).catch(() => null),
        this.binanceMarket.getKlines('BTCUSDT', '1m', 61).catch(() => null),
      ]);

      const btc24hReturnPct =
        ticker24h && Number.isFinite(ticker24h.priceChangePct)
          ? ticker24h.priceChangePct
          : null;
      const btcFundingPct =
        futureStats && Number.isFinite(futureStats.fundingRatePct)
          ? futureStats.fundingRatePct
          : null;

      // ATR14 / ATR50 en % du dernier close (BTC daily). Pure helper, no I/O.
      let atr14BtcPct: number | null = null;
      let atr50BtcPct: number | null = null;
      if (dailyKlines && dailyKlines.length >= 51) {
        atr14BtcPct = computeAtrPct(dailyKlines, 14);
        atr50BtcPct = computeAtrPct(dailyKlines, 50);
      }

      // P1 PR D — realized 1h vol depuis 1m klines (60 returns).
      // Trigger VOL_SPIKE si > 3%. Complementary à VIX (cross-asset macro).
      let realized1hPct: number | null = null;
      if (minute1Klines && minute1Klines.length >= 61) {
        realized1hPct = computeRealizedVolPct(minute1Klines, 60);
      }

      const inputs = {
        btc24hReturnPct,
        btcFundingPct,
        vix: vix ?? null,
        atr14BtcPct,
        atr50BtcPct,
        newsScore: null as number | null,
        realized1hPct,
        redditSpikeSigma: null as number | null,
      };

      // P2-A — Healthcheck fail-fast : si ≥2 indicateurs macro core
      // (vix/dxy/us10y/us2y/realized1hPct) sont null ou en fallback >24h,
      // on log un WARN structuré pour signaler que le verdict
      // HORS_TRAJECTOIRE qui sortira de cette classification est peu fiable.
      // Pure check, non-bloquant — on continue la classification.
      const health = assertRegimeInputsHealthy(
        {
          vix: vix ?? null,
          dxy: dxy ?? null,
          us10y: us10y ?? null,
          us2y: us2y ?? null,
          realized1hPct,
        },
        { fallback: dataQuality.fallback },
      );
      if (health.shouldWarn) {
        this.logger.warn(
          `[regime-healthcheck] ${health.degraded.length}/5 macro inputs degraded: ${health.degraded.join(', ')} — HORS_TRAJECTOIRE potentially unreliable this cycle`,
        );
      }

      tacticalRegime = await this.marketRegime.getCurrentRegime(inputs);
    } catch (e) {
      this.logger.warn(`[regime] classify failed (non-blocking): ${String(e).slice(0, 100)}`);
    }

    // SPY ≈ SP500/10, QQQ ≈ NASDAQ/40
    const finalSnapshot: MarketSnapshot = {
      timestamp: new Date().toISOString(),
      vix: vix ?? fallback.vix,
      usdDxy: dxy ?? fallback.usdDxy,
      us10yYield: us10y ?? fallback.us10yYield,
      us2yYield: us2y ?? fallback.us2yYield,
      brentUsd: brent ?? fallback.brentUsd,
      btcUsd: btc ?? fallback.btcUsd,
      ethUsd: eth ?? fallback.ethUsd,
      goldUsd: gold ?? fallback.goldUsd,
      sp500: spy ? spy * 10 : fallback.sp500,
      nasdaq: qqq ? qqq * 40 : fallback.nasdaq,
      eurUsd: eurusd ?? fallback.eurUsd,
      usdJpy: usdjpy ?? fallback.usdJpy,
      creditHyOasBps,
      creditIgOasBps,
      dataQuality: dataQualityWithDegraded,
      recentNews: [],
      upcomingEvents: [],
      ...(tacticalRegime
        ? {
            tacticalRegime: {
              regime: tacticalRegime.regime,
              reasons: tacticalRegime.reasons,
              sizingMultiplier: tacticalRegime.sizingMultiplier,
              stopLossPct: tacticalRegime.stopLossPct,
              takeProfitPct: tacticalRegime.takeProfitPct,
              takeProfitLadderPct: tacticalRegime.takeProfitLadderPct,
            },
          }
        : {}),
    };

    // Fix C (01/06) — Log persistant best-effort dans lisa_market_snapshot_log
    // (migration 0186) pour traçabilité historique. Fire-and-forget : ne bloque
    // pas le retour si l'insert échoue.
    void this.persistMarketSnapshot(finalSnapshot).catch(() => undefined);

    return finalSnapshot;
  }

  /**
   * Fix C (01/06) — Persist le market snapshot dans lisa_market_snapshot_log.
   * Best-effort fire-and-forget. Si la table n'existe pas (migration 0186 pas
   * appliquée), l'insert échoue silencieusement (catch côté caller).
   */
  private async persistMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
    const dq = (snapshot as unknown as { dataQuality?: { live?: unknown[]; proxy?: unknown[]; fallback?: unknown[] } }).dataQuality;
    const fallbackCount = Array.isArray(dq?.fallback) ? dq!.fallback!.length : 0;
    const proxyCount = Array.isArray(dq?.proxy) ? dq!.proxy!.length : 0;
    const { error } = await this.supabase.getClient()
      .from('lisa_market_snapshot_log')
      .insert({
        snapshot: snapshot as unknown as Record<string, unknown>,
        vix: snapshot.vix ?? null,
        dxy: snapshot.usdDxy ?? null,
        us10y: snapshot.us10yYield ?? null,
        brent: snapshot.brentUsd ?? null,
        fallback_count: fallbackCount,
        proxy_count: proxyCount,
      });
    if (error && !/relation .* does not exist/.test(error.message)) {
      this.logger.debug(`[market-snapshot-log] insert failed: ${error.message.slice(0, 120)}`);
    }
  }

  /**
   * P0-B — Snapshot read-only des compteurs `macro_quote_source{...}`.
   * Format des clés : `${symbol}:${source}:${status}`. Exposé pour
   * dump dans /metrics ou inspection ad-hoc côté admin.
   *
   * Exemple :
   *   { '^VIX:yahoo:ok': 41, '^VIX:yahoo:fail': 2,
   *     'VIX.INDX:eodhd:fail': 43, 'VXX.US:eodhd:ok': 2 }
   */
  getMacroQuoteSourceCounters(): Record<string, number> {
    return Object.fromEntries(this.quoteSourceCounters);
  }

  /**
   * P0-B — Reset compteurs (test helper / admin manual reset).
   */
  resetMacroQuoteSourceCounters(): void {
    this.quoteSourceCounters.clear();
  }

  /**
   * P0-B — Snapshot du cache last-known (debug). Retourne les valeurs
   * stockées + leur âge en minutes.
   */
  getLastKnownMacroValues(): Array<{ indicator: string; value: number; ageMinutes: number }> {
    const now = Date.now();
    return Array.from(this.lastKnownMacroValues.entries()).map(([indicator, { value, timestamp }]) => ({
      indicator,
      value,
      ageMinutes: Math.round((now - timestamp) / 60_000),
    }));
  }

  /**
   * Calcule les métriques historiques du portefeuille sur 7-30 j pour le
   * bloc # MISSION injecté dans le prompt Claude (v2 : portfolio trajectory
   * optimizer). Fail-safe : toute métrique indisponible est null, Lisa sait
   * alors "historique insuffisant" plutôt que de voir un 0 trompeur.
   */
  private async computeHistoryMetrics(portfolioId: string): Promise<HistoryMetrics> {
    const client = this.supabase.getClient();
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 86_400_000;
    const sevenDaysAgo = new Date(now - SEVEN_DAYS_MS).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString();

    // 1. Snapshots 30 j — returns + volatility + drawdown
    const { data: snapshots } = await client
      .from('lisa_portfolio_snapshots')
      .select('timestamp, total_value_usd, return_from_inception_pct, drawdown_from_peak_pct')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', thirtyDaysAgo)
      .order('timestamp', { ascending: true });

    let netReturnFromInceptionPct: number | null = null;
    let netReturn7dPct: number | null = null;
    let netReturn30dPct: number | null = null;
    let drawdownFromPeakPct: number | null = null;
    let realizedVolatility7dPct: number | null = null;

    if (snapshots && snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      netReturnFromInceptionPct = Number(latest.return_from_inception_pct);
      drawdownFromPeakPct = Number(latest.drawdown_from_peak_pct);

      const sevenCutoff = now - SEVEN_DAYS_MS;
      const oldestIn7d = snapshots.find((s) => new Date(s.timestamp as string).getTime() >= sevenCutoff);
      if (oldestIn7d) {
        const pStart = Number(oldestIn7d.total_value_usd);
        const pEnd = Number(latest.total_value_usd);
        if (pStart > 0) netReturn7dPct = ((pEnd - pStart) / pStart) * 100;
      }
      const oldest30 = snapshots[0];
      const p30 = Number(oldest30.total_value_usd);
      if (p30 > 0) {
        netReturn30dPct = ((Number(latest.total_value_usd) - p30) / p30) * 100;
      }

      // Volatilité : écart-type des returns quotidiens sur 7 j
      // On garde le dernier snapshot de chaque jour (YYYY-MM-DD) pour lisser
      // les échantillons multiples dans la même journée.
      const byDay = new Map<string, number>();
      for (const s of snapshots) {
        const dayKey = String(s.timestamp).slice(0, 10);
        byDay.set(dayKey, Number(s.total_value_usd));
      }
      const dailyValues = Array.from(byDay.entries()).sort().slice(-8); // 8 jours = 7 returns
      if (dailyValues.length >= 3) {
        const returns: number[] = [];
        for (let i = 1; i < dailyValues.length; i++) {
          const prev = dailyValues[i - 1][1];
          const cur = dailyValues[i][1];
          if (prev > 0) returns.push(((cur - prev) / prev) * 100);
        }
        if (returns.length >= 2) {
          const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
          const variance = returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length;
          realizedVolatility7dPct = Math.sqrt(variance);
        }
      }
    }

    // 2. Positions fermées — win rate + streak + frictions 7 j
    const { data: closedPositions } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp, estimated_entry_cost_usd, status')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .order('exit_timestamp', { ascending: false })
      .limit(200);

    let winRatePct: number | null = null;
    let tpHitRatePct: number | null = null;
    let closedPositionsCount = 0;
    let recentStreak: RecentStreak = null;
    let tradingFrictionsUsd = 0;

    if (closedPositions && closedPositions.length > 0) {
      closedPositionsCount = closedPositions.length;
      // P19u — Dual win-rate metric :
      //   - winRatePct  = trades nets gagnants / total (économique, après fees)
      //   - tpHitRatePct = trades dont status='closed_target' / total (intent-based)
      // Avant P19u : seul winRatePct exposé. Avec fees IBKR forfaitaires irréalistes
      // (10bps × 2), 5/7 TP_HIT comptaient comme LOSS car fees > gross PnL → Lisa
      // apprenait "TP n'est pas un win" alors que la stratégie A FONCTIONNÉ.
      const wins = closedPositions.filter((p) => Number(p.realized_pnl_usd ?? 0) > 0).length;
      const tpHits = closedPositions.filter((p) => p.status === 'closed_target').length;
      winRatePct = (wins / closedPositionsCount) * 100;
      tpHitRatePct = (tpHits / closedPositionsCount) * 100;

      const firstPnl = Number(closedPositions[0].realized_pnl_usd ?? 0);
      if (firstPnl !== 0) {
        const isWin = firstPnl > 0;
        let count = 0;
        for (const p of closedPositions) {
          const pnl = Number(p.realized_pnl_usd ?? 0);
          if (pnl === 0) break;
          if ((pnl > 0) === isWin) count++;
          else break;
        }
        recentStreak = { kind: isWin ? 'wins' : 'losses', count };
      }

      tradingFrictionsUsd = closedPositions
        .filter((p) => p.exit_timestamp && new Date(p.exit_timestamp as string).getTime() >= now - SEVEN_DAYS_MS)
        .reduce((sum, p) => sum + Number(p.estimated_entry_cost_usd ?? 0), 0);
    }

    // 3. Coûts Claude 7 j
    const { data: recentProposals } = await client
      .from('lisa_proposals')
      .select('claude_cost_usd')
      .eq('portfolio_id', portfolioId)
      .gte('generated_at', sevenDaysAgo);
    const claudeUsd = (recentProposals ?? []).reduce(
      (sum, p) => sum + Number(p.claude_cost_usd ?? 0),
      0,
    );

    // 4. Coûts EODHD 7 j — plan All-In-One est à tarif fixe, donc on
    // approxime via un marginal cost par call ($0.0001/call = $1 pour 10k
    // appels). C'est une indication d'échelle pour Lisa, pas une facture.
    const { count: eodhdCount } = await client
      .from('eodhd_request_log')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('source', 'eodhd')
      .gte('timestamp', sevenDaysAgo);
    const eodhdUsd = (eodhdCount ?? 0) * 0.0001;

    const totalCost7d = claudeUsd + eodhdUsd + tradingFrictionsUsd;
    const avgDailyCostUsd7d = totalCost7d > 0 ? totalCost7d / 7 : null;

    // 5. Dernier cycle mécanique — briefing pour Lisa
    const { data: lastCycleSummary } = await client
      .from('lisa_mechanical_cycle_summary')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('cycle_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let lastMechanicalCycle: import('@smartvest/ai-analyst').MechanicalCycleSummary | null = null;
    if (lastCycleSummary) {
      lastMechanicalCycle = {
        cycleAt: lastCycleSummary.cycle_at as string,
        directiveId: (lastCycleSummary.directive_id as string | null) ?? null,
        directiveAgeMinutes: (lastCycleSummary.directive_age_minutes as number | null) ?? null,
        opensCount: (lastCycleSummary.opens_count as number) ?? 0,
        closesStopCount: (lastCycleSummary.closes_stop_count as number) ?? 0,
        closesTargetCount: (lastCycleSummary.closes_target_count as number) ?? 0,
        closesInvalidatedCount: (lastCycleSummary.closes_invalidated_count as number) ?? 0,
        netPnlSinceProposalUsd: Number(lastCycleSummary.net_pnl_since_proposal_usd ?? 0),
        grossWinsUsd: Number(lastCycleSummary.gross_wins_usd ?? 0),
        grossLossesUsd: Number(lastCycleSummary.gross_losses_usd ?? 0),
        winRatePct: lastCycleSummary.win_rate_pct != null ? Number(lastCycleSummary.win_rate_pct) : null,
        avgHoldMinutes: lastCycleSummary.avg_hold_minutes != null ? Number(lastCycleSummary.avg_hold_minutes) : null,
        largestWinPct: lastCycleSummary.largest_win_pct != null ? Number(lastCycleSummary.largest_win_pct) : null,
        largestLossPct: lastCycleSummary.largest_loss_pct != null ? Number(lastCycleSummary.largest_loss_pct) : null,
        stopsClusterFlag: (lastCycleSummary.stops_cluster_flag as boolean) ?? false,
        stopsClusterWindowMinutes: (lastCycleSummary.stops_cluster_window_minutes as number | null) ?? null,
        exposurePct: lastCycleSummary.exposure_pct != null ? Number(lastCycleSummary.exposure_pct) : null,
        cashUsd: lastCycleSummary.cash_usd != null ? Number(lastCycleSummary.cash_usd) : null,
        openPositionsCount: (lastCycleSummary.open_positions_count as number) ?? 0,
        drawdownSinceDirectivePct: lastCycleSummary.drawdown_since_directive_pct != null ? Number(lastCycleSummary.drawdown_since_directive_pct) : null,
        vixLevel: lastCycleSummary.vix_level != null ? Number(lastCycleSummary.vix_level) : null,
        dxyLevel: lastCycleSummary.dxy_level != null ? Number(lastCycleSummary.dxy_level) : null,
      };
    }

    return {
      netReturnFromInceptionPct,
      netReturn7dPct,
      netReturn30dPct,
      drawdownFromPeakPct,
      realizedVolatility7dPct,
      winRatePct,
      // P19u — Dual win-rate : tpHitRatePct expose le taux de TP touchés
      // indépendant du PnL net (anti-bias UI quand fees mangent les profits
      // sur micro-moves). UI affiche les deux : "TP hit rate" + "Net win rate".
      tpHitRatePct,
      closedPositionsCount,
      recentStreak,
      avgDailyCostUsd7d,
      costBreakdown: {
        claudeUsd,
        eodhdUsd,
        tradingFrictionsUsd,
      },
      lastMechanicalCycle,
    };
  }

  async getAgentStatus(_userId: string, portfolioId: string) {
    const client = this.supabase.getClient();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [directiveRes, cyclesRes, actionsRes, wakeupsRes] = await Promise.all([
      // Directive active
      client
        .from('lisa_mechanical_directives')
        .select('generated_at, valid_until, market_momentum, trajectory_status, risk_posture, target_symbols, favored_asset_classes, avoided_asset_classes, tactical_overrides')
        .eq('portfolio_id', portfolioId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Derniers cycles mécaniques
      client
        .from('lisa_mechanical_cycle_summary')
        .select('cycle_at, directive_age_minutes, opens_count, closes_stop_count, closes_target_count, closes_invalidated_count, net_pnl_since_proposal_usd, win_rate_pct, avg_hold_minutes, largest_win_pct, largest_loss_pct, stops_cluster_flag, exposure_pct, cash_usd, open_positions_count, drawdown_since_directive_pct, vix_level, dxy_level')
        .eq('portfolio_id', portfolioId)
        .order('cycle_at', { ascending: false })
        .limit(20),

      // Actions récentes de l'agent dans le decision log
      client
        .from('lisa_decision_log')
        .select('timestamp, kind, summary, payload')
        .eq('portfolio_id', portfolioId)
        .in('kind', ['autopilot_cycle_completed', 'autopilot_cycle_started', 'position_opened', 'position_closed'])
        .order('timestamp', { ascending: false })
        .limit(30),

      // P5.5 — Wake-ups agent → Lisa du jour (pour affichage UI dashboard)
      client
        .from('lisa_decision_log')
        .select('timestamp, summary, payload')
        .eq('portfolio_id', portfolioId)
        .eq('kind', 'agent_wake_up_triggered')
        .gte('timestamp', todayStart.toISOString())
        .order('timestamp', { ascending: false })
        .limit(20),
    ]);

    return {
      directive: directiveRes.data ?? null,
      cycles: cyclesRes.data ?? [],
      recentActions: actionsRes.data ?? [],
      // P5.5 — Wake-ups agent → Lisa (dashboard UI)
      agentWakeUps: {
        today: wakeupsRes.data ?? [],
        countToday: wakeupsRes.data?.length ?? 0,
        dailyBudget: 8,
      },
    };
  }

  /**
   * Dérive le statut d'avancement vs la trajectoire cible sur l'horizon
   * configuré. Utilise netReturn dans la fenêtre 7j (proxy) comparée à
   * la cible extrapolée depuis return_target_daily_pct ou _monthly_pct.
   */
  /**
   * Construit le contexte DAILY_HARVEST à injecter dans le briefing Lisa.
   * Retourne undefined si le portfolio n'est PAS en mode DAILY_HARVEST.
   *
   * Lit la config + crée la session du jour si absente + calcule le progress.
   * Idempotent : peut être appelé plusieurs fois par cycle sans effet de bord.
   */
  private async buildDailyHarvestContext(portfolioId: string): Promise<DailyHarvestBriefingContext | undefined> {
    // 1. Lire le mode + la config
    const { data: cfgRow } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('capital_discipline_mode, daily_harvest_config')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    const mode = (cfgRow?.capital_discipline_mode as CapitalDisciplineMode | undefined) ?? 'NONE';
    if (mode !== 'DAILY_HARVEST') return undefined;

    const config = cfgRow?.daily_harvest_config as DailyHarvestConfig | null;
    if (!config) return undefined;

    // 2. Récupérer ou créer la session du jour
    const session = await this.dailySession.createOrGetTodaySession(portfolioId, config);

    // 3. Calculer la progression (pure function)
    const progress = this.dailySession.computeProgress(session, config);

    // 4. Mapper vers le DTO du briefing
    return {
      active: true,
      state: progress.state,
      targetAmountUsd: progress.targetAmountUsd,
      realizedTodayUsd: progress.realizedToday,
      securedTodayUsd: progress.securedToday,
      remainingToTargetUsd: progress.remainingToTarget,
      progressPct: progress.progressPct,
      tradesCount: progress.tradesCount,
      tradesRemainingBeforeCap: progress.tradesRemainingBeforeCap,
      lossRemainingBeforeLockUsd: progress.lossRemainingBeforeLock,
      sweepMode: config.profitSweepMode,
      workingCapitalUsd: config.workingCapitalBaseUsd,
    };
  }

  private computeTrajectoryStatus(
    objectives: PerformanceObjectives,
    metrics: HistoryMetrics,
  ): { status: TrajectoryStatus | null; targetExtrapolatedPct: number | null } {
    // Priorité : daily > monthly > annual pour extrapoler sur 7 j
    let targetPerDay: number | null = null;
    if (objectives.returnTargetDailyPct !== null) {
      targetPerDay = objectives.returnTargetDailyPct;
    } else if (objectives.returnTargetMonthlyPct !== null) {
      targetPerDay = objectives.returnTargetMonthlyPct / 30;
    } else if (objectives.returnTargetAnnualPct !== null) {
      targetPerDay = objectives.returnTargetAnnualPct / 365;
    }

    if (targetPerDay === null || metrics.netReturn7dPct === null) {
      return { status: null, targetExtrapolatedPct: null };
    }

    const targetExtrapolatedPct = targetPerDay * 7;
    const realised = metrics.netReturn7dPct;

    // Règle HORS_TRAJECTOIRE : drawdown 7d < seuil OU coûts > seuil_costs
    //
    // P0-D — incident 28/04 06:11+ UTC : avec `realised < 0` strict, un
    // drawdown -0.01% (bruit) déclenchait HORS_TRAJECTOIRE → bot bloqué
    // 6h sur 1 position latente, P&L 0 → impossible d'atteindre $100/j.
    //
    // Nouveau : seuil configurable via env, default -0.5% (drift normal
    // accepté, vrai drawdown >0.5% déclenche). cost share threshold
    // configurable aussi (default 0.5 = 50% pour préserver le sens
    // original du guard).
    const drawdownThresholdPct = Number(
      this.config.get<string>('HORS_TRAJ_DRAWDOWN_THRESHOLD_PCT') ?? '-0.5',
    );
    const costShareThreshold = Number(
      this.config.get<string>('HORS_TRAJ_COST_SHARE_THRESHOLD') ?? '0.5',
    );

    const bruteGain = realised; // proxy — 7d return net suffit ici
    const costShare =
      metrics.avgDailyCostUsd7d !== null && bruteGain > 0
        ? (metrics.avgDailyCostUsd7d * 7) / ((bruteGain / 100) * 10_000) // % de gains réalisés absorbés par coûts (10k capital ref)
        : 0;

    let status: TrajectoryStatus;
    let trigger: string | null = null;
    if (realised < drawdownThresholdPct) {
      status = 'HORS_TRAJECTOIRE';
      trigger = `realised=${realised.toFixed(3)}% < drawdown_threshold=${drawdownThresholdPct}%`;
    } else if (costShare > costShareThreshold) {
      status = 'HORS_TRAJECTOIRE';
      trigger = `cost_share=${(costShare * 100).toFixed(1)}% > threshold=${(costShareThreshold * 100).toFixed(0)}%`;
    } else if (realised >= targetExtrapolatedPct * 1.1) {
      status = 'EN_AVANCE';
    } else if (realised >= targetExtrapolatedPct * 0.8) {
      status = 'DANS_LE_PLAN';
    } else {
      status = 'EN_RETARD';
    }

    // P0-D — diagnostic log INFO avec valeurs exactes (utile post-incident
    // 28/04 où on voyait `HORS_TRAJECTOIRE` répété sans connaître pourquoi).
    // Niveau log dépend du status :
    //   - HORS_TRAJECTOIRE : log INFO (condition rare, on veut la voir)
    //   - autres : log DEBUG (cycle nominal, pas de bruit)
    const msg =
      `[trajectory] status=${status} realised_7d=${realised.toFixed(3)}% ` +
      `target_7d=${targetExtrapolatedPct.toFixed(3)}% ` +
      `cost_share=${(costShare * 100).toFixed(1)}% ` +
      `thresholds(drawdown=${drawdownThresholdPct}%, cost=${(costShareThreshold * 100).toFixed(0)}%)` +
      (trigger ? ` TRIGGER=${trigger}` : '');
    if (status === 'HORS_TRAJECTOIRE') {
      this.logger.log(msg);
    } else {
      this.logger.debug(msg);
    }

    return { status, targetExtrapolatedPct };
  }

  private async logDecision(
    portfolioId: string,
    kind: string,
    entry: { summary: string; rationale: string; payload: Record<string, unknown>; triggeredBy: string },
  ): Promise<void> {
    try {
      await this.decisionLog.append({
        portfolioId,
        kind,
        summary: entry.summary,
        rationale: entry.rationale,
        payload: entry.payload,
        triggeredBy: entry.triggeredBy as 'user_manual' | 'autopilot_cron' | 'risk_monitor' | 'corpus_trigger' | 'market_event',
      });
    } catch (e) {
      this.logger.warn(`Decision log append failed: ${String(e)}`);
    }
  }

  // Helper exposé pour le log d'une petite valeur numérique
  private roundDecimal(v: string | number, precision = 2): string {
    return new Decimal(v).toFixed(precision);
  }

  /**
   * Récupère le solde du compte Binance externe de l'utilisateur via l'API
   * privée signed (/api/v3/account). Lecture seule — ne peut rien trader.
   *
   * Retourne une vue enrichie : par asset, solde libre + bloqué, prix USD
   * courant, valeur totale en USD. Les stablecoins valent 1$ par défaut.
   *
   * Si BINANCE_API_KEY n'est pas configuré → retourne configured: false.
   */
  async fetchBinanceBalance(): Promise<{
    configured: boolean;
    balances: Array<{ asset: string; free: string; locked: string; total: string; usdPrice: string; usdValue: string }>;
    totalUsd: string;
    lastSyncAt: string | null;
    error?: string;
  }> {
    const apiKey = this.config.get<string>('BINANCE_API_KEY') ?? this.config.get<string>('smartvest-lisa');
    const secretKey = this.config.get<string>('BINANCE_SECRET_KEY');

    if (!apiKey || !secretKey) {
      return { configured: false, balances: [], totalUsd: '0.00', lastSyncAt: null };
    }

    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}&recvWindow=5000`;
      const signature = createHmac('sha256', secretKey).update(queryString).digest('hex');
      const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

      const res = await fetch(url, {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          configured: true,
          balances: [],
          totalUsd: '0.00',
          lastSyncAt: null,
          error: `Binance API ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data = await res.json() as {
        balances: Array<{ asset: string; free: string; locked: string }>;
        updateTime: number;
      };

      const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI', 'USDP']);

      const nonZero = data.balances
        .map((b) => ({
          asset: b.asset,
          free: new Decimal(b.free),
          locked: new Decimal(b.locked),
          total: new Decimal(b.free).plus(b.locked),
        }))
        .filter((b) => b.total.gt(0));

      const enriched = await Promise.all(nonZero.map(async (b) => {
        let usdPrice = new Decimal(0);
        if (STABLECOINS.has(b.asset)) {
          usdPrice = new Decimal(1);
        } else {
          try {
            const quote = await this.fetchLivePrice(b.asset);
            usdPrice = new Decimal(quote.price);
          } catch {
            usdPrice = new Decimal(0);
          }
        }
        return {
          asset: b.asset,
          free: b.free.toFixed(8),
          locked: b.locked.toFixed(8),
          total: b.total.toFixed(8),
          usdPrice: usdPrice.toFixed(8),
          usdValue: b.total.mul(usdPrice).toFixed(2),
        };
      }));

      enriched.sort((a, b) => new Decimal(b.usdValue).minus(a.usdValue).toNumber());

      const totalUsd = enriched.reduce((s, b) => s.plus(b.usdValue), new Decimal(0));

      return {
        configured: true,
        balances: enriched,
        totalUsd: totalUsd.toFixed(2),
        lastSyncAt: new Date(data.updateTime).toISOString(),
      };
    } catch (e) {
      this.logger.warn(`Binance balance fetch failed: ${String(e)}`);
      return {
        configured: true,
        balances: [],
        totalUsd: '0.00',
        lastSyncAt: null,
        error: String(e).slice(0, 200),
      };
    }
  }

  /** Borne de temps : début du jour courant en UTC (00:00 UTC). */
  private startOfTodayUtc(): string {
    const now = new Date();
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      0, 0, 0, 0,
    )).toISOString();
  }

  /** Borne de temps : début du mois calendaire courant en UTC. */
  private startOfMonthUtc(): string {
    const now = new Date();
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), 1,
      0, 0, 0, 0,
    )).toISOString();
  }

  /** Cache du taux USD→EUR récupéré dynamiquement depuis Frankfurter (BCE). */
  private cachedUsdEurRate: number | null = null;
  private cachedUsdEurRateAsOf = 0;

  /**
   * Taux de change USD→EUR en live depuis l'API Frankfurter (source BCE).
   * Mise à jour toutes les 24h, cache en mémoire. En cas d'échec : env var
   * USD_EUR_RATE, sinon 0.855 en dernier recours.
   *
   * Frankfurter publie les taux de référence BCE mis à jour chaque jour
   * ouvré vers 16h CET. API gratuite, pas de clé, pas de quota.
   */
  private async usdToEurRate(): Promise<number> {
    const CACHE_MS = 24 * 60 * 60 * 1000;
    if (this.cachedUsdEurRate && Date.now() - this.cachedUsdEurRateAsOf < CACHE_MS) {
      return this.cachedUsdEurRate;
    }
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { rates?: { EUR?: number } };
        const rate = data.rates?.EUR;
        if (typeof rate === 'number' && rate > 0.5 && rate < 2) {
          this.cachedUsdEurRate = rate;
          this.cachedUsdEurRateAsOf = Date.now();
          return rate;
        }
      }
    } catch {
      // fall through to fallback
    }
    // Fallback : env var ou défaut
    const raw = this.config.get<string>('USD_EUR_RATE');
    const parsed = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.855;
  }

  /**
   * Statistiques EODHD agrégées depuis eodhd_request_log.
   * Fenêtres CALENDAIRES UTC : "today" = depuis 00:00 UTC, "thisMonth" = depuis
   * le 1er du mois 00:00 UTC. Aligné avec le reset réel d'EODHD.
   */
  async fetchEodhdStats(): Promise<{
    today: { total: number; success: number; failures: number; fallbacks: number; avgLatencyMs: number };
    thisMonth: { calls: number; subscriptionUsd: number; subscriptionEur: number };
    all: { total: number; success: number };
    lastCallAsOf: string | null;
    usdEurRate: number;
  }> {
    const client = this.supabase.getClient();
    const startOfToday = this.startOfTodayUtc();
    const startOfMonth = this.startOfMonthUtc();

    const [rowsToday, rowsMonth, allCount, allSuccessCount, lastCall] = await Promise.all([
      client
        .from('eodhd_request_log')
        .select('source, success, latency_ms')
        .gte('timestamp', startOfToday),
      client
        .from('eodhd_request_log')
        .select('source', { count: 'exact', head: true })
        .gte('timestamp', startOfMonth)
        .eq('source', 'eodhd'),
      client
        .from('eodhd_request_log')
        .select('*', { count: 'exact', head: true }),
      client
        .from('eodhd_request_log')
        .select('*', { count: 'exact', head: true })
        .eq('success', true),
      client
        .from('eodhd_request_log')
        .select('timestamp')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const rows = (rowsToday.data ?? []) as Array<{ source: string; success: boolean; latency_ms: number | null }>;
    const eodhdRows = rows.filter((r) => r.source === 'eodhd');
    const latencies = eodhdRows.map((r) => r.latency_ms).filter((n): n is number => typeof n === 'number' && n > 0);

    // Abonnement EODHD (fixe mensuel, payé peu importe le nb d'appels).
    // Configurable via env var EODHD_MONTHLY_COST_USD, défaut 99.99 (plan
    // All-In-One avec quota 100k appels/jour).
    const subRaw = this.config.get<string>('EODHD_MONTHLY_COST_USD');
    const subscriptionUsd = subRaw && !isNaN(parseFloat(subRaw)) ? parseFloat(subRaw) : 99.99;
    const rate = await this.usdToEurRate();

    return {
      today: {
        total: eodhdRows.length,
        success: eodhdRows.filter((r) => r.success).length,
        failures: eodhdRows.filter((r) => !r.success).length,
        fallbacks: rows.filter((r) => r.source !== 'eodhd').length,
        avgLatencyMs: latencies.length > 0
          ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
          : 0,
      },
      thisMonth: {
        calls: rowsMonth.count ?? 0,
        subscriptionUsd,
        subscriptionEur: subscriptionUsd * rate,
      },
      all: {
        total: allCount.count ?? 0,
        success: allSuccessCount.count ?? 0,
      },
      lastCallAsOf: (lastCall.data?.timestamp as string | undefined) ?? null,
      usdEurRate: rate,
    };
  }

  /**
   * Statistiques Claude agrégées depuis lisa_proposals.
   * Fenêtres CALENDAIRES UTC identiques à fetchEodhdStats.
   */
  async fetchClaudeStats(): Promise<{
    today: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    thisMonth: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costEur: number };
    all: { requests: number; costUsd: number; costEur: number };
    usdEurRate: number;
  }> {
    const client = this.supabase.getClient();
    const startOfToday = this.startOfTodayUtc();
    const startOfMonth = this.startOfMonthUtc();
    const rate = await this.usdToEurRate();

    const [today, month, all] = await Promise.all([
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd')
        .gte('generated_at', startOfToday),
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd')
        .gte('generated_at', startOfMonth),
      client
        .from('lisa_proposals')
        .select('claude_input_tokens, claude_output_tokens, claude_cost_usd'),
    ]);

    const agg = (rows: Array<{ claude_input_tokens: number | null; claude_output_tokens: number | null; claude_cost_usd: number | null }> | null) => {
      const list = rows ?? [];
      const inputTokens = list.reduce((s, r) => s + (Number(r.claude_input_tokens) || 0), 0);
      const outputTokens = list.reduce((s, r) => s + (Number(r.claude_output_tokens) || 0), 0);
      const costUsd = list.reduce((s, r) => s + (Number(r.claude_cost_usd) || 0), 0);
      return {
        requests: list.length,
        inputTokens,
        outputTokens,
        costUsd,
        costEur: costUsd * rate,
      };
    };

    const allStats = agg(all.data as never);
    return {
      today: agg(today.data as never),
      thisMonth: agg(month.data as never),
      all: { requests: allStats.requests, costUsd: allStats.costUsd, costEur: allStats.costEur },
      usdEurRate: rate,
    };
  }

  /**
   * V2 GeminiOpportunityScout — open public pour news positive macro.
   * Wrappe paperBroker.openPositionDirect avec garde anti-stale price.
   * Retourne la position ouverte, ou null si prix non fiable / open échoue.
   *
   * Pattern symétrique à MechanicalTradingService.closeForRiskManager
   * (V2 RiskManager). Évite d'injecter PaperBrokerService directement dans
   * le scout (PaperBroker n'est PAS @Injectable, instancié manuellement ici).
   */
  async openForOpportunityScout(cmd: {
    portfolioId: string;
    symbol: string;
    assetClass: string;
    venue: string;
    notionalUsd: number;
    livePrice: number;
    stopLossPrice: string;
    takeProfitPrice: string;
    horizonDays?: number;
    maxOpenPositions?: number;
    rationale: string;
  }): Promise<{ id: string } | null> {
    // Re-vérif prix fraîcheur (au cas où le scout a un cache un peu vieux)
    const fresh = await this.fetchLivePrice(cmd.symbol).catch(() => null);
    if (!fresh || (fresh.source && (fresh.source.startsWith('stale_') || fresh.source.startsWith('fallback')))) {
      this.logger.warn(`[opportunity-scout] ${cmd.symbol} open annulé — prix source=${fresh?.source ?? 'null'}`);
      return null;
    }
    const verifiedPrice = parseFloat(fresh.price);
    if (!Number.isFinite(verifiedPrice) || verifiedPrice <= 0) return null;

    try {
      const pos = await this.paperBroker.openPositionDirect({
        portfolioId: cmd.portfolioId,
        symbol: cmd.symbol,
        assetClass: cmd.assetClass,
        direction: 'long',
        venue: cmd.venue,
        capitalAllocationUsd: cmd.notionalUsd.toFixed(2),
        livePrice: verifiedPrice.toFixed(6),
        stopLossPrice: cmd.stopLossPrice,
        takeProfitPrice: cmd.takeProfitPrice,
        horizonDays: cmd.horizonDays ?? 1,
        source: 'opportunity_scout',
        maxOpenPositions: cmd.maxOpenPositions,
        livePriceSource: fresh.source,
      });
      return { id: pos.id };
    } catch (e) {
      this.logger.warn(`[opportunity-scout] openPositionDirect ${cmd.symbol} failed: ${String(e).slice(0, 200)}`);
      return null;
    }
  }

  /**
   * Snapshot macro cached. Re-fetch si plus vieux que maxAgeSec.
   * Évite à des services tiers (LiveTraderAgent, ShadowSizingOrchestrator) de
   * payer 15-20 calls API + 3s latency à chaque cycle 5min.
   *
   * Le cache n'est PAS partagé avec le pipeline Lisa principal (qui appelle
   * fetchMarketSnapshot() directement pour garantir la fraîcheur d'un proposal).
   */
  async getRecentMarketSnapshot(maxAgeSec: number = 120): Promise<MarketSnapshot> {
    const now = Date.now();
    if (this.lastMarketSnapshotCache && (now - this.lastMarketSnapshotCache.fetchedAt) < maxAgeSec * 1000) {
      return this.lastMarketSnapshotCache.snap;
    }
    const fresh = await this.fetchMarketSnapshot();
    this.lastMarketSnapshotCache = { snap: fresh, fetchedAt: now };
    return fresh;
  }

  /**
   * Close une position par id via le paperBroker. Pattern symétrique à
   * openForOpportunityScout. Utilisé par LiveTraderAgent quand Gemini propose
   * un action_kind='close' sur un symbol qu'il détient.
   *
   * Le caller résout symbol → positionId via son state (positions ouvertes
   * du portfolio). Sanity bound : refuse si livePrice diverge > 30% d'entry
   * (anti-corruption cache, cf. règle "checkStopTarget [SANITY_BOUND]").
   */
  async closeForOpportunityScout(cmd: {
    positionId: string;
    symbol?: string;
    livePrice: number;
    livePriceSource?: string;
    reason: 'closed_target' | 'closed_stop' | 'closed_invalidated' | 'closed_user' | 'closed_kill' | 'closed_expired';
    rationale: string;
  }): Promise<{ closed: boolean; error?: string }> {
    // Garde-fous prix source (cf. Phase 3 — fix LMT/SEE.LSE :$0 → SL destructive).
    // Nuance 28/05/2026 : si marché vraiment fermé (exchange-session check) ET
    // source = `stale_*` (prix = last close valide, juste pas frais), on autorise
    // la close. Le `fallback_*` reste TOUJOURS bloquant (= prix corrompu $0 / NaN).
    let marketClosed = false;
    if (cmd.livePriceSource) {
      const src = cmd.livePriceSource;
      if (src.startsWith('fallback')) {
        // Prix corrompu ou inconnu : on bloque toujours (anti-bug LMT/SEE.LSE).
        return { closed: false, error: `price source unreliable (fallback): ${src}` };
      }
      if (src.startsWith('stale_')) {
        // Stale : on accepte UNIQUEMENT si marché vraiment fermé. Sinon suspect.
        const inSession = cmd.symbol ? isInExchangeSession(cmd.symbol, new Date()) : true;
        if (inSession) {
          return { closed: false, error: `price source stale on open market: ${src} (suspect)` };
        }
        // Marché fermé + stale : OK, on propage marketClosed=true au paper-broker R5 sanity.
        marketClosed = true;
      }
    }
    if (!Number.isFinite(cmd.livePrice) || cmd.livePrice <= 0) {
      return { closed: false, error: `invalid livePrice ${cmd.livePrice}` };
    }
    try {
      await this.paperBroker.closePosition({
        positionId: cmd.positionId,
        reason: cmd.reason,
        livePrice: cmd.livePrice.toFixed(6),
        rationale: cmd.rationale.slice(0, 500),
        ...(cmd.livePriceSource ? { livePriceSource: cmd.livePriceSource } : {}),
        ...(marketClosed ? { marketClosed: true } : {}),
      });
      return { closed: true };
    } catch (e) {
      return { closed: false, error: String(e).slice(0, 200) };
    }
  }
}
