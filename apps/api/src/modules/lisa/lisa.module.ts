import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { PerformanceModule } from '../performance/performance.module';
import { BotLabModule } from '../bot-lab/bot-lab.module';
// PR6.3 — Shadow wiring : GainersShadowRunService inject dans TopGainersScannerService
import { GainersModule } from '../gainers-scanner';
import { LisaController } from './lisa.controller';
import { AutopilotController } from './autopilot.controller';
import { LisaService } from './services/lisa.service';
import { LisaAutopilotService } from './services/lisa-autopilot.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { EodhdTechnicalService } from './services/eodhd-technical.service';
import { EodhdIntradayService } from './services/eodhd-intraday.service';
import { TickerBlacklistService } from './services/ticker-blacklist.service';
import { ExchangeHoursService } from './services/exchange-hours.service';
import { BinanceMarketService } from './services/binance-market.service';
import { EodhdMacroService } from './services/eodhd-macro.service';
import { EodhdScreenerService } from './services/eodhd-screener.service';
// PR #344 P1 — logger EODHD partagé (instrumentation quota)
import { EodhdLoggerService } from './services/eodhd-logger.service';
import { EodhdInsiderService } from './services/eodhd-insider.service';
import { EodhdOptionsService } from './services/eodhd-options.service';
import { BinanceLiquidationsService } from './services/binance-liquidations.service';
import { MarketRegimeService } from './services/market-regime.service';
import { EodhdFxWsService } from './services/eodhd-fx-ws.service';
import { PortfolioCorrelationService } from './services/portfolio-correlation.service';
import { AgentLisaSyncService } from './services/agent-lisa-sync.service';
import { MechanicalTradingService } from './services/mechanical-trading.service';
import { OptionBrokerService } from './services/option-broker.service';
import { EodhdCalendarService } from './services/eodhd-calendar.service';
import { NewsRankerService } from './services/news-ranker.service';
import { StockTwitsService } from './services/stocktwits.service';
import { RedditService } from './services/reddit.service';
import { TwitterService } from './services/twitter.service';
import { NewsAggregatorService } from './services/news-aggregator.service';
import { LisaMemoryService } from './services/lisa-memory.service';
import { MaterialChangeDetectorService } from './services/material-change-detector.service';
import { TradeOutcomeRecorderService } from './services/trade-outcome-recorder.service';
import { LisaPerformanceAnalyticsService } from './services/lisa-performance-analytics.service';
import { TradingStatsService } from './services/trading-stats.service';
import { DailySessionService } from './services/daily-session.service';
import { ProfitSweepService } from './services/profit-sweep.service';
import { DailyProfitGovernor } from './services/daily-profit-governor.service';
import { MacroModeService } from './services/macro-mode.service';
import { ApiCostTrackerService } from './services/api-cost-tracker.service';
import { GeminiBudgetGuardService } from './services/gemini-budget-guard.service';
import { ReboundMonitorService } from './services/rebound-monitor.service';
import { ReboundScannerService } from './services/rebound-scanner.service';
import { OhlcvCacheService } from './services/ohlcv-cache.service';
import { TopGainersScannerService } from './services/top-gainers-scanner.service';
import { GainersUserShadowService } from './services/gainers-user-shadow.service';
import { ShadowSizingOrchestratorService } from './services/shadow-sizing-orchestrator.service';
import { LiveTraderAgentService } from './services/live-trader-agent.service';
import { MistralShadowService } from './services/mistral-shadow.service';
import { MistralLargeShadowService } from './services/mistral-large-shadow.service';
import { LlmABShadowService } from './services/llm-ab-shadow.service';
import { LlmAccuracyService } from './services/llm-accuracy.service';
import { MainScannerPostMortemService } from './services/main-scanner-postmortem.service';
import { DailyDigestService } from './services/daily-digest.service';
import { PushNotificationsService } from './services/push-notifications.service';
import { StrategyCoachService } from './services/strategy-coach.service';
import { TraderRetrospectiveService } from './services/trader-retrospective.service';
import { LessonAutoApplyService } from './services/lesson-auto-apply.service';
import { LearningLoopAuditService } from './services/learning-loop-audit.service';
import { ScannerLessonsContextService } from './services/scanner-lessons-context.service';
import { ConfigSanityValidatorService } from './services/config-sanity-validator.service';
import { RealTimeLessonDetectorService } from './services/realtime-lesson-detector.service';
import { MarketCloseReportService } from './services/market-close-report.service';
import { GainersAutoRelaxService } from './services/gainers-auto-relax.service';
import { PostSlBackfillService } from './services/post-sl-backfill.service';
import { ShadowExitSimulatorService } from './services/shadow-exit-simulator.service';
import { ShadowSignalsCleanupService } from './services/shadow-signals-cleanup.service';
import { MicroMomentumProbeService } from './services/micro-momentum-probe.service';
import { OperatingModeService } from './services/operating-mode.service';
import { MultiTimeframePersistenceService } from './services/multi-tf-persistence.service';
import { EodhdQuotaService } from './services/eodhd-quota.service';
import { YahooIntradayService } from './services/yahoo-intraday.service';
import { IntradayCacheService } from './services/intraday-cache.service';
import { PersistenceProbabilityService } from './services/persistence-probability.service';
import { ScannerLlmRouterService } from './services/scanner-llm-router.service';
import { DailyCatalystBriefService } from './services/daily-catalyst-brief.service';
import { OpenPositionRiskMonitorService } from './services/open-position-risk-monitor.service';
import { CorrelationGuardService } from './services/correlation-guard.service';
import { DailyRetrospectiveService } from './services/daily-retrospective.service';
import { AdaptiveCooldownService } from './services/adaptive-cooldown.service';
import { DebateGateService } from './services/debate-gate.service';
import { DebateGateMetricsStore } from './services/debate-gate-metrics.store';
import { EarlyExitGuardService } from './services/early-exit-guard.service';
import { FeatureABTuningService } from './services/feature-ab-tuning.service';
import { EventEngineService } from './services/event-engine.service';
import { EodhdNewsService } from './services/eodhd-news.service';
import { EodhdNewsCollectorService } from './services/eodhd-news-collector.service';
import { SymbolAtrCacheService } from './services/symbol-atr-cache.service';
import { EodhdEconomicEventsService } from './services/eodhd-economic-events.service';
import { MacroVetoService } from './services/macro-veto.service';
// Phase B — Weekly P9 ML refit cron auto-logging insights
import { ProbabilityRefitCronService } from '../gainers-scanner/automations/probability-refit-cron.service';
// PR6.8 RCFT — Cron daily 00:30 UTC qui suit forward returns des shadow signals
import { SignalForwardTrackerService } from '../gainers-scanner/automations/signal-forward-tracker.service';
// Phase 5 N1 PR-1 — Quick Wins (sessions + symbols + cleanup)
import {
  QuickWinsPipelineService,
  QwDecisionLoggerService,
  Qw1SessionFilterService,
  Qw3WarmupExtendedService,
  Qw4RegimeFilterService,
  Qw6SymbolBlacklistService,
  Qw7CooldownPostTpUsService,
  Qw8BoostPostSlService,
  Qw9ScoreFloorService,
  Qw11AssetClassGateService,
  Qw14aFridayEuBoostService,
  Qw15FirstTradeBoostService,
  Qw17RepeatSymbolCapService,
  Qw18ExchangeMultiplierService,
  Qw27PathEffFloorService,
  Qw45ForceCloseUsLargeService,
  Qw46AsiaDowSkipService,
  Qw47LseSkipService,
} from './quick-wins';
// Phase 5 N1 PR-2 — matrice TP/SL par asset_class
import { AssetClassTpSlConfigService } from './services/asset-class-tpsl-config.service';
// PR #338 — UI Phase 5 N1+N2
import { AssetClassTpslService } from './services/asset-class-tpsl.service';
import { QuickWinsStatsService } from './services/quick-wins-stats.service';
import { RiskStateService } from './services/risk-state.service';
// Phase 5 N1 PR-3+PR-4 — circuit breaker + sanity R5 hotfix
import { LisaCircuitBreakerService } from './services/circuit-breaker.service';
import { SanityR5Service } from './services/sanity-r5.service';
// Phase 5 N2 — Kelly fractional sizing per asset_class
import { AssetClassKellyConfigService } from './services/asset-class-kelly-config.service';
import { KellyRecomputeService } from './services/kelly-recompute.service';
// PR #342 POC — TwelveData service (lecture seule, indicateurs Supertrend/RSI/ATR)
import { TwelveDataService } from './services/twelve-data.service';
// PR #352 — Router intraday TD-first avec fallback EODHD (flag-gated)
import { IntradayProviderRouter } from './services/intraday-provider-router.service';
// R&D batch — services env-gated OFF par défaut (audit 23/05 propositions sérieuses)
import { GeminiRiskManagerService } from './services/research/gemini-risk-manager.service';
import { GeminiOpportunityScoutService } from './services/research/gemini-opportunity-scout.service';
import { CryptoFundingFadeService } from './services/research/crypto-funding-fade.service';
import { EventNarrativeInterpreterService } from './services/research/event-narrative-interpreter.service';
import { HourlyEdgeAnalyzerService } from './services/research/hourly-edge-analyzer.service';
import { SizingABTestService } from './services/research/sizing-ab-test.service';

@Module({
  imports: [SupabaseModule, PerformanceModule, BotLabModule, GainersModule],
  controllers: [LisaController, AutopilotController],
  providers: [
    LisaService,
    LisaAutopilotService,
    DecisionLogService,
    RealtimePriceService,
    EodhdEnrichmentService,
    EodhdTechnicalService,
    EodhdIntradayService,
    // Bug #R9 / #R10 — Universe pre-filter + auto-blacklist 404 strikes
    TickerBlacklistService,
    ExchangeHoursService,
    BinanceMarketService,
    EodhdMacroService,
    EodhdScreenerService,
    // PR #344 P1 — logger EODHD partagé (instrumentation quota)
    EodhdLoggerService,
    EodhdInsiderService,
    EodhdOptionsService,
    BinanceLiquidationsService,
    EodhdFxWsService,
    PortfolioCorrelationService,
    AgentLisaSyncService,
    MechanicalTradingService,
    OptionBrokerService,
    EodhdCalendarService,
    NewsRankerService,
    StockTwitsService,
    RedditService,
    TwitterService,
    NewsAggregatorService,
    LisaMemoryService,
    MaterialChangeDetectorService,
    TradeOutcomeRecorderService,
    LisaPerformanceAnalyticsService,
    TradingStatsService,
    // DAILY_HARVEST (Phase 1+2) — CRUD + sweep + governor (state machine)
    DailySessionService,
    ProfitSweepService,
    DailyProfitGovernor,
    // Macro mode (INVESTMENT / HARVEST presets)
    MacroModeService,
    // PATCH 4 — running total + hard-stop budget API
    ApiCostTrackerService,
    // PR2 cost-cuts (H) — kill-switch quotidien Gemini avec override manuel
    GeminiBudgetGuardService,
    // P1 — classifier de régime tactique (BULL/BEAR/RANGE/VOL_SPIKE/NEWS_SHOCK)
    MarketRegimeService,
    // P3-A — cron monitor pour rebound_positions (TP/SL/timeout toutes les 5 min)
    ReboundMonitorService,
    // P3-A.2 — cron scanner watchlist (toutes les 15 min, heures marché US)
    ReboundScannerService,
    // P3-C — cache OHLCV daily (cron 21:30 UTC) + watchlist universe
    OhlcvCacheService,
    // P5-PIVOT-TOP-GAINERS — scanner momentum cross-asset (gated par STRATEGY_MODE=top_gainers)
    TopGainersScannerService,
    // PR #280 — Shadow user-pipeline (regret cost via /lisa/gainers-shadow-regret)
    GainersUserShadowService,
    // Shadow sizing × AI auto-tuner — 3 profiles (high/middle/small) avec cron 30min,
    // kill-switch drawdown auto, fees alerts, target progress vs $200/jour.
    ShadowSizingOrchestratorService,
    // Live Trader Agent — portfolio dédié $10k piloté à 100% par Gemini Pro.
    // Cron 5min decision + cron 02:00 UTC post-mortem nightly + memory store.
    LiveTraderAgentService,
    // MistralShadowService — A/B shadow 3-way (Pro/Flash/Mistral) pour mesurer
    // concordance avant migration éventuelle TRADER vers Mistral Large 3 (74%
    // moins cher que Gemini Pro). Activation MISTRAL_API_KEY + MISTRAL_SHADOW_ENABLED.
    MistralShadowService,
    // PR #521 — 2e instance dédiée Mistral Large 3 (cheap tier) pour 4-way A/B
    MistralLargeShadowService,
    // PR #523 — LlmABShadowService générique pour 4 call sites peripheriques
    // (scanner_postmortem, strategy_coach, daily_brief, risk_monitor)
    LlmABShadowService,
    // PR #535 — boucle feedback "qui a raison ?" sur les shadows : backfill outcomes
    // depuis lisa_positions closed → Brier + correlation par provider → /admin/llm-accuracy
    LlmAccuracyService,
    // MainScannerPostMortemService — apprentissage Gemini Pro sur le scanner gainers
    // (cron 02:30 UTC : analyse 24h × 4 portfolios → lessons macro-conditionnelles).
    MainScannerPostMortemService,
    // DailyDigestService (B.4.b) — email récap quotidien via Resend (09:00 UTC).
    // Requires RESEND_API_KEY + DAILY_DIGEST_FROM_EMAIL Fly secrets, sinon DRY mode.
    DailyDigestService,
    // PushNotificationsService (B.4.c) — Web Push API trigger-only.
    // Requires VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (sinon subscribe OK, sends SKIP).
    PushNotificationsService,
    // StrategyCoachService (C.1) — cron hourly @ minute 17, Gemini Flash + Pro
    // escalations. Génère coach_proposals consommées par UI review (C.2).
    StrategyCoachService,
    // TraderRetrospectiveService (C.4) — cron daily 02:00 UTC. Analyse trades
    // TRADER veille via Gemini Pro, INSERT scanner_lessons scope='trader_agent_only'
    // is_active=true (réinjectées dans system prompt trader cycle suivant).
    TraderRetrospectiveService,
    // ScannerLessonsContextService — fournit le bloc Markdown des lessons actives
    // à injecter dans les system prompts (signal validation, ranking, risk manager, macro veto).
    // Cache TTL 5 min pour éviter requêtes DB répétées (scanner ~500 calls/cycle).
    ScannerLessonsContextService,
    // LessonAutoApplyService — boucle d'amélioration continue : auto-applique les
    // proposed_config_change à haute confiance (≥0.85, sample ≥10) sur les 4 portfolios
    // gainers. Cron hourly. Cibles env vars → manual review (Fly secrets).
    LessonAutoApplyService,
    // 01/06 — LearningLoopAuditService : exposé via admin/verify-learning-loop
    // pour panel UI (8 checks Supabase) ET réutilisable depuis le script CLI.
    LearningLoopAuditService,
    // ConfigSanityValidatorService — cron hourly :17, détecte anti-patterns (R/R inversé,
    // min_chg trop strict, max_open trop bas) et applique DIRECTEMENT les fixes en DB
    // au confidence ≥ 0.95. Insère aussi une lesson gate_calibration pour audit.
    ConfigSanityValidatorService,
    // RealTimeLessonDetectorService — cron */5min, détecte automatiquement 5 patterns
    // (BIG_WIN/BIG_LOSS/SL_GAP/TP_DOUBLE/ORPHAN_PRE_CLOSE) et insère lessons direct
    // dans trader_agent_memory ou scanner_lessons. Anti-spam 24h par pattern.
    RealTimeLessonDetectorService,
    // Market Close Reports — comparatif 5 portfolios à chaque cloche (Asia/EU/US) + daily wrap.
    MarketCloseReportService,
    // PR #282 — Auto-relax adaptive : lit cumulative_regret 7j et propose/auto-applique relax
    GainersAutoRelaxService,
    // PR #292 — Backfill post_sl_path JSONB (analysis rebound/ATR post closed_stop)
    PostSlBackfillService,
    // PR6.5 — Worker exit-simulator : replay BLOC 4 state machine sur shadow signals ACCEPT
    ShadowExitSimulatorService,
    ShadowSignalsCleanupService,
    MicroMomentumProbeService,
    // P7-MODE-GAINERS-BADGE — toggle 3-modes opératoires (UI badge → DB strategy_mode)
    OperatingModeService,
    // P8-MULTI-TIMEFRAME-PERSISTENCE — fetch + score multi-TF (1m/5m/10m/15m/30m/1h)
    MultiTimeframePersistenceService,
    // OpenPositionRiskMonitor — cron 5min, thesis_health_score → CLOSE/TIGHTEN_SL/RAISE_TP/MOMENTUM_RIDE
    OpenPositionRiskMonitorService,
    // Feature #1 — Cross-position correlation guard (anti-cascade 24/05)
    CorrelationGuardService,
    // Feature #3 — Rétrospective journalière narrative (Gemini Pro 22:00 UTC)
    DailyRetrospectiveService,
    // Feature #4 — Adaptive cooldown per symbol (weekly refresh)
    AdaptiveCooldownService,
    // AXEES T1+T2 wiring — debate gate (default ACTIVE / blocking ; override DEBATE_GATE_ENABLED=false).
    DebateGateMetricsStore,
    DebateGateService,
    // Miracle #3 — Early exit guard via Gemini (T+5-15min on opens)
    EarlyExitGuardService,
    // Miracle #4 — Auto-tuning A/B (snapshot daily + analyze 14j window)
    FeatureABTuningService,
    // P19a — Yahoo Finance intraday fallback (Korea KOSPI, small-caps, etc.)
    YahooIntradayService,
    // P19i — Intraday OHLCV cache Supabase (last_known < 15 min, fallback chain)
    IntradayCacheService,
    // P9 — logistic regression P(win) sur features persistence + empirical law
    PersistenceProbabilityService,
    // P17 — LLM router multi-vendor pour scanner Gainers (Gemini/GPT-nano/Codestral/Claude)
    ScannerLlmRouterService,
    // Daily catalyst brief via Gemini (cron 04:00 UTC, env-gated)
    DailyCatalystBriefService,
    // Phase D-1 — Event-driven engine scheduling + pre-snapshot (cron 1min)
    EventEngineService,
    // Étape 1 — news EODHD persistées (fondation grounding Gemini)
    EodhdNewsService,
    EodhdNewsCollectorService,
    SymbolAtrCacheService,
    EodhdEconomicEventsService,
    // PR Action 3 — LLM macro veto cron hourly (gate scanner cycle entries)
    MacroVetoService,
    // P19v (30/04/2026) — Quota service centralisé EODHD (cost map + auto-throttle)
    EodhdQuotaService,
    // Phase B — Cron Sunday 02:00 UTC qui refit P9 logistic regression et auto-log
    // un insight `ml_refit` avec metrics (AUC, accuracy, sample_size, accepted/rejected).
    ProbabilityRefitCronService,
    // PR6.8 RCFT — Cron daily 00:30 UTC qui suit forward returns shadow signals
    // (T+24h + T+72h) et compute outcome (champion/failure/neutral) pour FP-rate.
    SignalForwardTrackerService,
    // Phase 5 N1 PR-1 — Quick Wins (sessions + symbols + repeat caps + exchange mult)
    QwDecisionLoggerService,
    Qw1SessionFilterService,
    Qw6SymbolBlacklistService,
    Qw11AssetClassGateService,
    Qw14aFridayEuBoostService,
    Qw17RepeatSymbolCapService,
    Qw18ExchangeMultiplierService,
    // PR #361 — cooldown/boost basis-position-history
    Qw7CooldownPostTpUsService,
    Qw8BoostPostSlService,
    QuickWinsPipelineService,
    // Phase 5 N1 PR-2 — matrice TP/SL DB-driven (read-only, cache 60s, fail-open)
    AssetClassTpSlConfigService,
    // PR #338 — UI Phase 5 N1+N2 (lecture/écriture matrice TP/SL, agrégation QW stats, état de risque)
    AssetClassTpslService,
    QuickWinsStatsService,
    RiskStateService,
    // Phase 5 N1 PR-3+PR-4 — nouveaux QWs + circuit breaker + sanity R5
    Qw3WarmupExtendedService,
    Qw4RegimeFilterService,
    Qw9ScoreFloorService,
    Qw15FirstTradeBoostService,
    Qw27PathEffFloorService,
    Qw45ForceCloseUsLargeService,
    Qw46AsiaDowSkipService,
    Qw47LseSkipService,
    LisaCircuitBreakerService,
    SanityR5Service,
    // Phase 5 N2 — Kelly fractional sizing (lecture cache + worker cron horaire)
    AssetClassKellyConfigService,
    KellyRecomputeService,
    // PR #342 POC — TwelveData (flags consumer OFF par défaut, aucun impact runtime)
    TwelveDataService,
    // PR #352 — Router intraday TD-first (flag OFF par défaut → passthrough EODHD)
    IntradayProviderRouter,
    // R&D batch (23/05 propositions sérieuses, ENV-gated OFF par défaut)
    GeminiRiskManagerService,
    GeminiOpportunityScoutService,
    CryptoFundingFadeService,
    EventNarrativeInterpreterService,
    HourlyEdgeAnalyzerService,
    SizingABTestService,
  ],
  exports: [
    LisaService,
    DecisionLogService,
    DebateGateMetricsStore,
    RealtimePriceService,
    EodhdTechnicalService,
    EodhdIntradayService,
    ExchangeHoursService,
    BinanceMarketService,
    EodhdMacroService,
    EodhdScreenerService,
    EodhdInsiderService,
    EodhdOptionsService,
    BinanceLiquidationsService,
    EodhdFxWsService,
    PortfolioCorrelationService,
    AgentLisaSyncService,
    OptionBrokerService,
    EodhdCalendarService,
    NewsRankerService,
    StockTwitsService,
    RedditService,
    TwitterService,
    NewsAggregatorService,
    LisaMemoryService,
    MaterialChangeDetectorService,
    DailySessionService,
    ProfitSweepService,
    DailyProfitGovernor,
    MacroModeService,
    EodhdQuotaService,
    // Hotfix 02/05/2026 : TopGainersScannerService était provider mais pas exporté.
    // AdminGainersStatusController (importe LisaModule via forwardRef) crashait au
    // boot NestJS avec "Nest can't resolve dependencies of AdminGainersStatusController
    // (?, ConfigService). Make sure TopGainersScannerService at index [0] is available
    // in the AdminModule context." → empêchait app.listen → port 3001 jamais bindé →
    // Fly proxy fail. Cf. PR #200.
    TopGainersScannerService,
    // PR #356 — exports TD + router pour AdminProvidersStatusController qui
    // expose /admin/providers-status. Même pattern que TopGainersScannerService
    // export hotfix PR #200 (forwardRef LisaModule ↔ AdminModule).
    TwelveDataService,
    IntradayProviderRouter,
    TickerBlacklistService,
    // PR #358 — export pour AdminQwPipelineToggleController qui expose
    // /admin/qw-pipeline-toggle (toggle runtime QUICK_WINS_PIPELINE_ENABLED).
    QuickWinsPipelineService,
    // Exports pour AdminEventEngineForceController : force-pull manuel des
    // caches alimentés par cron quotidien (économic events 03:30 UTC,
    // ATR cache 21:30 UTC lun-ven).
    EodhdEconomicEventsService,
    SymbolAtrCacheService,
    // Export pour AdminShadowSizingController (cf. /admin/shadow-sizing/status).
    ShadowSizingOrchestratorService,
    // Export pour AdminTraderAgentController (cf. /admin/trader-agent/status).
    LiveTraderAgentService,
    // Export pour AdminScannerPostMortemController (cf. /admin/scanner-postmortem/{status,run}).
    MainScannerPostMortemService,
    // Export pour AdminLessonAutoApplyController (cf. /admin/lesson-auto-apply/{status,run}).
    LessonAutoApplyService,
    // Export pour AdminMarketCloseReportsController.
    MarketCloseReportService,
    // PR #536 hotfix — Export pour AdminLlmAccuracyController (cf. /admin/llm-accuracy).
    LlmAccuracyService,
    // 01/06 — Export pour AdminLearningLoopAuditController.
    LearningLoopAuditService,
  ],
})
export class LisaModule {}
