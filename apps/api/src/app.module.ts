import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './modules/health/health.module';
import { VersionModule } from './modules/version/version.module';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { ValuationModule } from './modules/valuation/valuation.module';
import { SimulationsModule } from './modules/simulations/simulations.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { BrokerImportModule } from './modules/broker-import/broker-import.module';
import { PerformanceModule } from './modules/performance/performance.module';
import { BrokerSyncModule } from './modules/broker-sync/broker-sync.module';
import { GoalsModule } from './modules/goals/goals.module';
import { MacroModule } from './modules/macro/macro.module';
import { MandatesModule } from './modules/mandates/mandates.module';
import { SuggestionsModule } from './modules/suggestions/suggestions.module';
import { ProposalGeneratorModule } from './modules/proposal-generator/proposal-generator.module';
import { FundingModule } from './modules/funding/funding.module';
import { HyperTradingModule } from './modules/hyper-trading/hyper-trading.module';
import { SniperModule } from './modules/sniper/sniper.module';
import { BrokersModule } from './modules/brokers/brokers.module';
import { LisaModule } from './modules/lisa/lisa.module';
import { BotLabModule } from './modules/bot-lab/bot-lab.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { StrategyOptimizerModule } from './modules/strategy-optimizer/optimizer.module';
import { MonteCarloModule } from './modules/monte-carlo/monte-carlo.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `npm run api:dev` CDs into apps/api via workspaces, so .env.local at
      // the repo root is two levels up. Also check CWD-local paths in case
      // the API is run from a different location. Order = first wins.
      envFilePath: ['../../.env.local', '../../.env', '.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    FeatureFlagsModule,
    HealthModule,
    VersionModule,
    PortfolioModule,
    DashboardModule,
    MarketDataModule,
    ValuationModule,
    SimulationsModule,
    AlertsModule,
    BrokerImportModule,
    PerformanceModule,
    BrokerSyncModule,
    GoalsModule,
    MacroModule,
    MandatesModule,
    SuggestionsModule,
    ProposalGeneratorModule,
    FundingModule,
    HyperTradingModule,
    SniperModule,
    BrokersModule,
    LisaModule,
    BotLabModule,
    BacktestModule,
    StrategyOptimizerModule,
    MonteCarloModule,
  ],
})
export class AppModule {}
