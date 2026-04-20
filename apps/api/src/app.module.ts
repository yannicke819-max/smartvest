import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    FeatureFlagsModule,
    HealthModule,
    PortfolioModule,
  ],
})
export class AppModule {}
