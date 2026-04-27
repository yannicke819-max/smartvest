import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { PerformanceModule } from '../performance/performance.module';
import { LisaController } from './lisa.controller';
import { LisaService } from './services/lisa.service';
import { LisaAutopilotService } from './services/lisa-autopilot.service';
import { DecisionLogService } from './services/decision-log.service';
import { RealtimePriceService } from './services/realtime-price.service';
import { EodhdEnrichmentService } from './services/eodhd-enrichment.service';
import { EodhdTechnicalService } from './services/eodhd-technical.service';
import { EodhdIntradayService } from './services/eodhd-intraday.service';
import { ExchangeHoursService } from './services/exchange-hours.service';
import { BinanceMarketService } from './services/binance-market.service';
import { EodhdMacroService } from './services/eodhd-macro.service';
import { EodhdScreenerService } from './services/eodhd-screener.service';
import { EodhdInsiderService } from './services/eodhd-insider.service';
import { EodhdOptionsService } from './services/eodhd-options.service';
import { BinanceLiquidationsService } from './services/binance-liquidations.service';
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
import { DailySessionService } from './services/daily-session.service';
import { ProfitSweepService } from './services/profit-sweep.service';
import { DailyProfitGovernor } from './services/daily-profit-governor.service';

@Module({
  imports: [SupabaseModule, PerformanceModule],
  controllers: [LisaController],
  providers: [
    LisaService,
    LisaAutopilotService,
    DecisionLogService,
    RealtimePriceService,
    EodhdEnrichmentService,
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
    // DAILY_HARVEST (Phase 1+2) — CRUD + sweep + governor (state machine)
    DailySessionService,
    ProfitSweepService,
    DailyProfitGovernor,
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
  ],
})
export class LisaModule {}
