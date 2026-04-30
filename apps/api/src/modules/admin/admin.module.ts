/**
 * P19x.5 + P19x.6 + P19x.10 — AdminModule
 *
 * Endpoints administrateurs protégés par `ADMIN_TOKEN` (header x-admin-token).
 * Disabled si ADMIN_TOKEN env var absente (return 403).
 *
 * Endpoints :
 *   - GET /admin/migrations/apply-missing[?dry_run=true]    (P19x.10)
 *   - GET /admin/supabase-query/:queryName                   (P19x.5)
 *   - GET /admin/logs/recent[?pattern=&level=&limit=]        (P19x.6)
 */

import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminMigrationsController } from './admin-migrations.controller';
import { AdminSupabaseQueryController } from './admin-supabase-query.controller';
import { AdminLogsController } from './admin-logs.controller';

@Module({
  imports: [SupabaseModule],
  controllers: [AdminMigrationsController, AdminSupabaseQueryController, AdminLogsController],
})
export class AdminModule {}
