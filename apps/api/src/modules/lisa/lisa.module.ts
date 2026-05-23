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
import { ReboundMonitorService } from './services/rebound-monitor.service';
import { ReboundScannerService } from './services/rebound-scanner.service';
import { OhlcvCacheService } from './services/ohlcv-cache.service';
import { TopGainersScannerService } from './services/top-gainers-scanner.service';
import { GainersUserShadowService } from './services/gainers-user-shadow.service';
import { GainersAutoRelaxService } from './services/gainers-auto-relax.service';
import { PostSlBackfillService } from './services/post-sl-backfill.service';
import { ShadowExitSimulatorService } from './services/shadow-exit-simulator.service';
import { MicroMomentumProbeService } from './services/micro-momentum-probe.service';
import { OperatingModeService } from './services/operating-mode.service';
import { MultiTimeframePersistenceService } from './services/multi-tf-persistence.service';
import { EodhdQuotaService } from './services/eodhd-quota.service';
import { YahooIntradayService } from './services/yahoo-intraday.service';
import { IntradayCacheService } from './services/intraday-cache.service';
import { PersistenceProbabilityService } from './services/persistence-probability.service';
import { ScannerLlmRouterService } from './services/scanner-llm-router.service';
import { DailyCatalystBriefService } from './services/daily-catalyst-brief.service';
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
    // PR #282 — Auto-relax adaptive : lit cumulative_regret 7j et propose/auto-applique relax
    GainersAutoRelaxService,
    // PR #292 — Backfill post_sl_path JSONB (analysis rebound/ATR post closed_stop)
    PostSlBackfillService,
    // PR6.5 — Worker exit-simulator : replay BLOC 4 state machine sur shadow signals ACCEPT
    ShadowExitSimulatorService,
    MicroMomentumProbeService,
    // P7-MODE-GAINERS-BADGE — toggle 3-modes opératoires (UI badge → DB strategy_mode)
    OperatingModeService,
    // P8-MULTI-TIMEFRAME-PERSISTENCE — fetch + score multi-TF (1m/5m/10m/15m/30m/1h)
    MultiTimeframePersistenceService,
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
  ],
  exports: [
    LisaService,
    DecisionLogService,
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
  ],
})
export class LisaModule {}
