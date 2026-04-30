/**
 * P19x.10 (29/04/2026) — Admin endpoint pour appliquer les migrations Supabase
 * manquantes en runtime.
 *
 * Pourquoi : audit user via Comet a révélé 2 trous DB :
 *   - 0036_corpus_micro_5_1_svb_banking_2023.sql : NON appliquée (trou)
 *   - 0090_p12_vault_harvest_baseline.sql        : NON appliquée (trou)
 * Le script CI `scripts/apply-migrations.mjs` tourne au boot du container
 * (Dockerfile CMD), MAIS si une migration plante (FK manquante, RLS, etc.)
 * il continue à la suivante en log FAIL — DB reste désynchronisée silencieusement.
 *
 * Cet endpoint expose le même mécanisme manuellement, avec :
 *   - Auth via header `x-admin-token` matchant secret Fly `ADMIN_TOKEN`
 *   - Mode dry-run via `?dry_run=true` (liste sans appliquer)
 *   - Retour JSON détaillé `{applied, skipped, failed}` avec checksums SHA256
 *
 * Usage :
 *   curl -H "x-admin-token: $ADMIN_TOKEN" \
 *     "https://smartvest.fly.dev/admin/migrations/apply-missing?dry_run=true"
 *
 * Sécurité :
 *   - 401 si header absent
 *   - 403 si ADMIN_TOKEN env var absent (endpoint disabled)
 *   - 403 si token mismatch (constant-time compare)
 *   - Aucune donnée user-supplied n'atteint le SQL — fichiers sont du repo bundlé
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface MigrationFile {
  filename: string;
  version: number;
  sha256: string;
  sql: string;
}

interface ApplyResult {
  applied: Array<{ filename: string; sha256: string; latencyMs: number }>;
  skipped: Array<{ filename: string; reason: 'already_applied' | 'not_in_repo' }>;
  failed: Array<{ filename: string; error: string; status?: number }>;
  dry_run: boolean;
  total_files: number;
  total_applied_db: number;
  missing_count: number;
}

@Controller('admin/migrations')
export class AdminMigrationsController {
  private readonly logger = new Logger(AdminMigrationsController.name);

  constructor(private readonly config: ConfigService) {}

  @Get('apply-missing')
  async applyMissing(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('dry_run') dryRunRaw?: string,
  ): Promise<ApplyResult> {
    this.assertAdmin(providedToken);
    const dryRun = String(dryRunRaw ?? '').toLowerCase() === 'true';

    const projectRef = this.config.get<string>('SUPABASE_PROJECT_REF') ?? 'mfuutigfhrawccotinpo';
    const supabaseToken = this.config.get<string>('SUPABASE_ACCESS_TOKEN');
    if (!supabaseToken) {
      throw new HttpException(
        { message: 'SUPABASE_ACCESS_TOKEN not set on Fly — cannot reach Management API', code: 'NO_ACCESS_TOKEN' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // 1. Charge les fichiers du repo (bundlés dans l'image)
    const files = this.readMigrationFiles();

    // 2. Charge l'état DB
    const apiUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
    const appliedRows = await this.runSql(
      apiUrl,
      supabaseToken,
      'select filename, sha256 from _smartvest_migrations order by filename;',
    );
    const appliedMap = new Map<string, string>();
    if (appliedRows.ok) {
      try {
        const rows = JSON.parse(appliedRows.body);
        for (const row of Array.isArray(rows) ? rows : []) {
          appliedMap.set(row.filename, row.sha256);
        }
      } catch { /* empty result */ }
    } else if (appliedRows.status === 404 || appliedRows.body.includes('does not exist')) {
      // Tracking table doesn't exist yet — bootstrap it
      if (!dryRun) {
        const init = await this.runSql(
          apiUrl,
          supabaseToken,
          'create table if not exists _smartvest_migrations ( filename text primary key, sha256 text not null, applied_at timestamptz not null default now() );',
        );
        if (!init.ok) {
          throw new HttpException(
            { message: 'Failed to bootstrap _smartvest_migrations table', body: init.body },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        }
      }
    }

    // 3. Diff
    const result: ApplyResult = {
      applied: [],
      skipped: [],
      failed: [],
      dry_run: dryRun,
      total_files: files.length,
      total_applied_db: appliedMap.size,
      missing_count: 0,
    };

    const missing = files.filter((f) => !appliedMap.has(f.filename));
    result.missing_count = missing.length;

    // Items déjà appliquées (logging)
    for (const f of files) {
      if (appliedMap.has(f.filename)) {
        result.skipped.push({ filename: f.filename, reason: 'already_applied' });
      }
    }

    // 4. Apply missing (or dry-run report)
    for (const f of missing) {
      if (dryRun) {
        result.applied.push({ filename: f.filename, sha256: f.sha256, latencyMs: 0 });
        continue;
      }

      const t0 = Date.now();
      const r = await this.runSql(apiUrl, supabaseToken, f.sql);
      const latencyMs = Date.now() - t0;

      const alreadyExists = !r.ok && this.isAlreadyExistsError(r.body);
      if (r.ok || alreadyExists) {
        // Record dans tracker
        const escaped = f.filename.replace(/'/g, "''");
        const ins = await this.runSql(
          apiUrl,
          supabaseToken,
          `insert into _smartvest_migrations (filename, sha256) values ('${escaped}', '${f.sha256}') on conflict (filename) do nothing;`,
        );
        if (!ins.ok) {
          this.logger.warn(`[admin/migrations] tracker insert failed for ${f.filename}: ${ins.body.slice(0, 120)}`);
        }
        result.applied.push({ filename: f.filename, sha256: f.sha256, latencyMs });
      } else {
        const failure: { filename: string; error: string; status?: number } = {
          filename: f.filename,
          error: String(r.body).slice(0, 500),
        };
        if (typeof r.status === 'number') failure.status = r.status;
        result.failed.push(failure);
      }
    }

    this.logger.log(
      `[admin/migrations] dry_run=${dryRun} files=${result.total_files} ` +
      `applied_db=${result.total_applied_db} missing=${result.missing_count} ` +
      `applied=${result.applied.length} failed=${result.failed.length}`,
    );

    return result;
  }

  /**
   * Auth admin par header `x-admin-token`. Constant-time compare.
   */
  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (!providedToken) {
      throw new HttpException(
        { message: 'x-admin-token header required', code: 'NO_TOKEN' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    // timingSafeEqual requires equal-length buffers ; pad to same length safely
    const a = Buffer.from(expected);
    const b = Buffer.from(providedToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'BAD_TOKEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Lit les fichiers de migration depuis le filesystem de l'image.
   *
   * Path résolution :
   *  - Container Fly : Dockerfile copie `supabase/migrations` vers `/app/supabase/migrations`.
   *    cwd à runtime = `/app/apps/api` → fichier accessible via `/app/supabase/migrations`.
   *  - Local dev : cwd = repo root → `supabase/migrations`.
   * On try les 2 paths.
   */
  private readMigrationFiles(): MigrationFile[] {
    const candidates = ['/app/supabase/migrations', 'supabase/migrations', '../../supabase/migrations'];
    const dir = candidates.find((p) => existsSync(p));
    if (!dir) {
      throw new HttpException(
        { message: 'Migrations directory not found on filesystem', tried: candidates },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((filename) => {
        const sql = readFileSync(join(dir, filename), 'utf-8');
        const sha256 = createHash('sha256').update(sql).digest('hex');
        // Extract numeric version prefix (0036, 0090...)
        const match = filename.match(/^(\d+)/);
        const version = match ? Number(match[1]) : 0;
        return { filename, version, sha256, sql };
      });
  }

  private async runSql(
    apiUrl: string,
    token: string,
    sql: string,
  ): Promise<{ ok: boolean; status?: number; body: string }> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: sql }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await res.text();
        if (res.ok) return { ok: true, status: res.status, body };
        if (res.status === 503 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        return { ok: false, status: res.status, body };
      } catch (e) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        return { ok: false, status: 0, body: String(e).slice(0, 500) };
      }
    }
    return { ok: false, status: 0, body: 'exhausted' };
  }

  private isAlreadyExistsError(body: string): boolean {
    const s = String(body).toLowerCase();
    return (
      s.includes('already exists') ||
      s.includes('duplicate key') ||
      s.includes('42p07') || // duplicate_table
      s.includes('42710')    // duplicate_object (index, constraint)
    );
  }
}
