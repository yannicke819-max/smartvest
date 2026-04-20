import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './modules/health/health.module';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    FeatureFlagsModule,
    HealthModule,
    PortfolioModule,
    DashboardModule,
    MarketDataModule,
    ValuationModule,
    SimulationsModule,
    AlertsModule,
    BrokerImportModule,
    PerformanceModule,
    BrokerSyncModule,
  ],
})
export class AppModule {}
