/**
 * ShadowSignalsCleanupService — rétention 30j sur gainers_user_shadow_signals.
 *
 * La table est append-only avec >50 inserts/cycle scanner (toutes 5 min) →
 * grossit ~600k rows/mois. Sans cleanup, en 6 mois on a 3-4M rows, queries
 * d'analytics deviennent lentes (audit-eu-rejects, sizing-ab-test, etc.).
 *
 * Cron daily 03:30 UTC : DELETE WHERE created_at < NOW() - 30 days. Idempotent,
 * best-effort, fail silently si Supabase indispo (la table peut absorber un
 * jour de pause de cleanup sans souci).
 *
 * Gating : SHADOW_SIGNALS_CLEANUP_ENABLED (default true en prod ; mettre
 * false pour pause manuelle). Rétention configurable via
 * SHADOW_SIGNALS_RETENTION_DAYS (default 30, range [7, 365]).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class ShadowSignalsCleanupService {
  private readonly logger = new Logger(ShadowSignalsCleanupService.name);
  private readonly enabled: boolean;
  private readonly retentionDays: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('SHADOW_SIGNALS_CLEANUP_ENABLED') ?? 'true').toLowerCase() === 'true';
    const rawDays = parseInt(this.config.get<string>('SHADOW_SIGNALS_RETENTION_DAYS') ?? '30', 10);
    this.retentionDays = Number.isFinite(rawDays) && rawDays >= 7 && rawDays <= 365 ? rawDays : 30;
    if (this.enabled) {
      this.logger.log(`[shadow-cleanup] ENABLED — rétention ${this.retentionDays}j · cron daily 03:30 UTC`);
    }
  }

  /** Cron daily 03:30 UTC — avant l'open Asia (00:00 UTC) ? Plus tard (03:30) pour éviter contention. */
  @Cron('30 3 * * *', { name: 'shadow-signals-cleanup', timeZone: 'UTC' })
  async cronCleanup(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    await this.cleanup().catch((e) =>
      this.logger.warn(`[shadow-cleanup] cron failed: ${String(e).slice(0, 200)}`),
    );
  }

  /** Exposé pour tests + endpoint admin debug futur. */
  async cleanup(): Promise<{ deleted: number; cutoffIso: string }> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000);
    const cutoffIso = cutoff.toISOString();
    const { error, count } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .delete({ count: 'exact' })
      .lt('created_at', cutoffIso);
    if (error) {
      this.logger.warn(`[shadow-cleanup] delete failed: ${error.message}`);
      throw error;
    }
    const deleted = count ?? 0;
    if (deleted > 0) {
      this.logger.log(`[shadow-cleanup] ${deleted} rows < ${cutoffIso} purged (rétention ${this.retentionDays}j)`);
    } else {
      this.logger.debug(`[shadow-cleanup] 0 rows à purger (table déjà clean ou trop jeune)`);
    }
    return { deleted, cutoffIso };
  }
}
