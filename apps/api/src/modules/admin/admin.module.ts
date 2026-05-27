/**
 * P19x.5 + P19x.6 + P19x.10 + P19v — AdminModule
 *
 * Endpoints administrateurs protégés par `ADMIN_TOKEN` (header x-admin-token).
 * Disabled si ADMIN_TOKEN env var absente (return 403).
 *
 * Endpoints :
 *   - GET /admin/migrations/apply-missing[?dry_run=true]    (P19x.10)
 *   - GET /admin/supabase-query/:queryName                   (P19x.5)
 *   - GET /admin/logs/recent[?pattern=&level=&limit=]        (P19x.6)
 *   - GET /admin/eodhd-status                                (P19v 30/04)
 *   - GET /admin/gainers/scanner-status                      (P19x.10)
 *   - POST /admin/gainers/baseline/refresh                   (PR #199)
 *   - GET /admin/gainers/v1-metrics                          (PR #202 Step 10)
 *   - GET /admin/gainers/v1-metrics/signals                  (PR #203 #195)
 *   - GET /admin/gainers/v1-metrics/sessions[.csv]           (PR #203 #195)
 */

import { Module, forwardRef } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LisaModule } from '../lisa/lisa.module';
import { GainersModule } from '../gainers-scanner';
import { AdminMigrationsController } from './admin-migrations.controller';
import { AdminSupabaseQueryController } from './admin-supabase-query.controller';
import { AdminLogsController } from './admin-logs.controller';
import { AdminEodhdStatusController } from './admin-eodhd-status.controller';
import { AdminTdProbeController } from './admin-td-probe.controller';
import { AdminGainersStatusController } from './admin-gainers-status.controller';
import { AdminGainersBaselineController } from './admin-gainers-baseline.controller';
import { AdminGainersMetricsController } from './admin-gainers-metrics.controller';
import { AdminGainersExtendedController } from './admin-gainers-extended.controller';
import { AdminModePresetsController } from './admin-mode-presets.controller';
import { AdminShadowDailyReportController } from './admin-shadow-daily-report.controller';
import { AdminGainersSeedUniverseController } from './admin-gainers-seed-universe.controller';
import { AdminGainersInsightsController } from './admin-gainers-insights.controller';
import { AdminRejectedInsightsController } from './admin-rejected-insights.controller';
import { AdminThresholdTunerController } from './admin-threshold-tuner.controller';
import { AdminProvidersStatusController } from './admin-providers-status.controller';
import { AdminQwPipelineToggleController } from './admin-qw-pipeline-toggle.controller';
import { AdminEventEngineForceController } from './admin-event-engine-force.controller';
import { AdminResearchController } from './admin-research.controller';
import { AdminDebateGateMetricsController } from './admin-debate-gate-metrics.controller';
import { AdminShadowSizingController } from './admin-shadow-sizing.controller';
import { AdminTraderAgentController } from './admin-trader-agent.controller';
import { AdminScannerPostMortemController } from './admin-scanner-postmortem.controller';
import { AdminScannerDebugController } from './admin-scanner-debug.controller';
import { AdminMarketCloseReportsController } from './admin-market-close-reports.controller';

@Module({
  imports: [SupabaseModule, forwardRef(() => LisaModule), GainersModule],
  controllers: [
    AdminMigrationsController,
    AdminSupabaseQueryController,
    AdminLogsController,
    AdminEodhdStatusController,
    AdminTdProbeController,
    AdminGainersStatusController,
    AdminGainersBaselineController,
    AdminGainersMetricsController,
    AdminGainersExtendedController,
    AdminModePresetsController,
    AdminShadowDailyReportController,
    AdminGainersSeedUniverseController,
    AdminGainersInsightsController,
    AdminRejectedInsightsController,
    AdminThresholdTunerController,
    // PR #356 — diagnostic DI IntradayProviderRouter + TwelveDataService.
    AdminProvidersStatusController,
    // PR #358 — toggle runtime QUICK_WINS_PIPELINE_ENABLED sans redeploy.
    AdminQwPipelineToggleController,
    // Force-pull caches event-engine (économic events + ATR) sans attendre cron.
    AdminEventEngineForceController,
    // R&D : exploitation dataset propriétaire top_gainers_log + cross-region.
    AdminResearchController,
    // AXEES T1+T2 — observability du debate gate (default ACTIVE).
    AdminDebateGateMetricsController,
    // Shadow sizing × AI auto-tuner — observability + status des 3 profiles (high/middle/small)
    AdminShadowSizingController,
    // Live Trader Agent (Gemini Pro) — observability + status portfolio dédié $10k
    AdminTraderAgentController,
    // Scanner Post-Mortem (Gemini Pro) — lessons macro-conditionnelles + run manuel
    AdminScannerPostMortemController,
    // Scanner Debug — test EODHD screener par exchange (diagnostic porte d'entrée)
    AdminScannerDebugController,
    // Market Close Reports — comparatif 5 portfolios par session (Asia/EU/US + daily wrap)
    AdminMarketCloseReportsController,
  ],
})
export class AdminModule {}
