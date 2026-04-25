import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { OptimizerService } from './optimizer.service';

/**
 * Cron quotidien (03h UTC) : pour chaque user avec auto-apply enabled,
 * lance un walk-forward sur les 90 derniers jours et applique si les
 * 4 garde-fous sont OK.
 *
 * Volontairement simple : tourne en série (un user à la fois) pour ne pas
 * blast EODHD ni la DB. Si l'utilisateur a beaucoup d'utilisateurs
 * simultanément, on basculera sur une queue.
 */
@Injectable()
export class AutoApplyCronService {
  private readonly logger = new Logger(AutoApplyCronService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly optimizer: OptimizerService,
  ) {}

  // Tous les jours à 03h05 UTC (un peu après le close US)
  @Cron('0 5 3 * * *', { name: 'optimizer-auto-apply', timeZone: 'UTC' })
  async runDailyAutoApply(): Promise<void> {
    const { data: states, error } = await this.supabase.getClient()
      .from('optimizer_auto_state')
      .select('user_id')
      .eq('enabled', true);

    if (error) {
      this.logger.warn(`Auto-apply cron: list users failed ${error.message}`);
      return;
    }

    const users = (states ?? []) as Array<{ user_id: string }>;
    if (users.length === 0) {
      this.logger.debug('Auto-apply cron: aucun user avec auto-apply activé.');
      return;
    }

    this.logger.log(`Auto-apply cron: ${users.length} user(s) à traiter.`);

    const today = new Date();
    const toDate = today.toISOString().slice(0, 10);
    const fromDate = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);

    for (const u of users) {
      try {
        const result = await this.optimizer.run(u.user_id, {
          mode: 'auto_apply',
          fromDate,
          toDate,
          initialCapitalUsd: 10_000,
          trainRatio: 0.6,
          maxCandidates: 30,
        });
        const decision = result.applyDecision;
        this.logger.log(
          `Auto-apply user=${u.user_id.slice(0, 8)} → ${decision?.reasonCode ?? 'unknown'} | ${decision?.reasonText ?? ''}`,
        );
      } catch (e) {
        this.logger.warn(`Auto-apply cron failed for ${u.user_id}: ${String(e)}`);
      }
    }
  }
}
