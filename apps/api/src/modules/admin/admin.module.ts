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
 */

import { Module, forwardRef } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LisaModule } from '../lisa/lisa.module';
import { AdminMigrationsController } from './admin-migrations.controller';
import { AdminSupabaseQueryController } from './admin-supabase-query.controller';
import { AdminLogsController } from './admin-logs.controller';
import { AdminEodhdStatusController } from './admin-eodhd-status.controller';
import { AdminGainersStatusController } from './admin-gainers-status.controller';

@Module({
  imports: [SupabaseModule, forwardRef(() => LisaModule)],
  controllers: [
    AdminMigrationsController,
    AdminSupabaseQueryController,
    AdminLogsController,
    AdminEodhdStatusController,
    AdminGainersStatusController,
  ],
})
export class AdminModule {}
