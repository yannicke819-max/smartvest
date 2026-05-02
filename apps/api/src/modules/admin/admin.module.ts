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
import { AdminGainersStatusController } from './admin-gainers-status.controller';
import { AdminGainersBaselineController } from './admin-gainers-baseline.controller';
import { AdminGainersMetricsController } from './admin-gainers-metrics.controller';
import { AdminGainersExtendedController } from './admin-gainers-extended.controller';
import { AdminModePresetsController } from './admin-mode-presets.controller';

@Module({
  imports: [SupabaseModule, forwardRef(() => LisaModule), GainersModule],
  controllers: [
    AdminMigrationsController,
    AdminSupabaseQueryController,
    AdminLogsController,
    AdminEodhdStatusController,
    AdminGainersStatusController,
    AdminGainersBaselineController,
    AdminGainersMetricsController,
    AdminGainersExtendedController,
    AdminModePresetsController,
  ],
})
export class AdminModule {}
