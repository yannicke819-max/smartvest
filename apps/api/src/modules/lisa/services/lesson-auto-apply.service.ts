/**
 * LessonAutoApplyService — boucle d'amélioration continue.
 *
 * Lit `scanner_lessons` chaque heure et applique les `proposed_config_change`
 * à haute confiance (default confidence ≥ 0.85 AND sample_size ≥ 10).
 *
 * Politique de sécurité :
 *   - Auto-apply UNIQUEMENT pour les cibles `lisa_session_configs.<col>` (DB UPDATE
 *     scoped aux 4 portfolios gainers MAIN/HIGH/MIDDLE/SMALL, jamais TRADER).
 *   - Cibles env vars (`GAINERS_*`, `SCANNER_*`) → log `manual_review_needed`,
 *     pas d'auto-apply car nécessite Fly Management API + redéploiement.
 *   - Marque la lesson `applied=true`, `applied_by='auto'`, `applied_at=now`.
 *   - Écrit `lisa_decision_log` kind=`lesson_auto_applied` avec before/after.
 *
 * Override env :
 *   - LESSON_AUTO_APPLY_ENABLED=false → désactive
 *   - LESSON_AUTO_APPLY_MIN_CONFIDENCE=0.85
 *   - LESSON_AUTO_APPLY_MIN_SAMPLE_SIZE=10
 *
 * Cron : toutes les heures (offset minute 7 pour pas saturer top of hour).
 */

import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

const GAINERS_PORTFOLIO_IDS = [
  '58439d86-3f20-4a60-82a4-307f3f252bc2', // MAIN
  'a0000001-0000-0000-0000-000000000001', // HIGH
  'a0000002-0000-0000-0000-000000000002', // MIDDLE
  'a0000003-0000-0000-0000-000000000003', // SMALL
];

interface LessonRow {
  id: string;
  lesson_kind: string;
  lesson_text: string;
  macro_condition: string | null;
  scope: string;
  confidence: number;
  sample_size: number | null;
  win_rate_observed: number | null;
  avg_pnl_usd: number | null;
  proposed_config_change: Record<string, string | number | boolean | null> | null;
  applied: boolean;
}

@Injectable()
export class LessonAutoApplyService {
  private readonly logger = new Logger(LessonAutoApplyService.name);
  private enabled = false;
  private minConfidence = 0.85;
  private minSampleSize = 10;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('LESSON_AUTO_APPLY_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.minConfidence = Number(this.config.get<string>('LESSON_AUTO_APPLY_MIN_CONFIDENCE') ?? '0.85');
    this.minSampleSize = Number(this.config.get<string>('LESSON_AUTO_APPLY_MIN_SAMPLE_SIZE') ?? '10');

    this.logger.log(
      `[lesson-auto-apply] onModuleInit fired — enabled=${this.enabled} ` +
      `minConfidence=${this.minConfidence} minSampleSize=${this.minSampleSize}`,
    );

    if (this.enabled) {
      try {
        const job = new CronJob('7 * * * *', () => {
          this.runCycle().catch((e) =>
            this.logger.error(`[lesson-auto-apply] cron failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('lesson-auto-apply', job);
        job.start();
        this.logger.log('[lesson-auto-apply] ENABLED — cron hourly @ minute 7');
      } catch (e) {
        this.logger.error(`[lesson-auto-apply] cron register failed: ${String(e).slice(0, 200)}`);
      }
    }
  }

  /** Manual trigger via admin endpoint. */
  async runCycle(): Promise<{ scanned: number; applied: number; needsReview: number; errors: number }> {
    const sb = this.supabase.getClient();
    const { data, error } = await sb
      .from('scanner_lessons')
      .select('id, lesson_kind, lesson_text, macro_condition, scope, confidence, sample_size, win_rate_observed, avg_pnl_usd, proposed_config_change, applied')
      .eq('is_active', true)
      .eq('applied', false)
      .gte('confidence', this.minConfidence)
      .gte('sample_size', this.minSampleSize)
      .not('proposed_config_change', 'is', null);

    if (error) {
      this.logger.error(`[lesson-auto-apply] fetch failed: ${error.message}`);
      return { scanned: 0, applied: 0, needsReview: 0, errors: 1 };
    }

    const lessons = (data ?? []) as LessonRow[];
    let appliedCount = 0;
    let needsReviewCount = 0;
    let errorCount = 0;

    for (const lesson of lessons) {
      try {
        const change = lesson.proposed_config_change;
        if (!change || typeof change !== 'object' || Object.keys(change).length === 0) {
          continue;
        }

        // Inspection des cibles : DB column (`lisa_session_configs.<col>`) auto-applicable,
        // env vars manual review.
        const targets = Object.keys(change);
        const dbColumnTargets = targets.filter((t) => t.startsWith('lisa_session_configs.'));
        const envVarTargets = targets.filter((t) => !t.startsWith('lisa_session_configs.'));

        if (envVarTargets.length > 0) {
          // Log pour review humaine, ne pas appliquer.
          await this.logDecision(lesson, 'lesson_needs_manual_review', {
            reason: 'env_var_target_requires_fly_secret',
            env_targets: envVarTargets,
            db_targets: dbColumnTargets,
          });
          needsReviewCount++;
          continue;
        }

        // Apply chaque DB column change sur les 4 portfolios gainers
        for (const target of dbColumnTargets) {
          const col = target.replace('lisa_session_configs.', '');
          const value = change[target];
          const { error: updErr } = await sb
            .from('lisa_session_configs')
            .update({ [col]: value })
            .in('portfolio_id', GAINERS_PORTFOLIO_IDS);

          if (updErr) {
            this.logger.warn(
              `[lesson-auto-apply] UPDATE ${col}=${JSON.stringify(value)} failed: ${updErr.message}`,
            );
            errorCount++;
            continue;
          }

          this.logger.log(
            `[lesson-auto-apply] APPLIED lesson=${lesson.id.slice(0, 8)} ${col}=${JSON.stringify(value)} ` +
            `confidence=${lesson.confidence} sample=${lesson.sample_size}`,
          );
        }

        // Marquer la lesson appliquée
        await sb
          .from('scanner_lessons')
          .update({
            applied: true,
            applied_at: new Date().toISOString(),
            applied_by: 'auto',
          })
          .eq('id', lesson.id);

        await this.logDecision(lesson, 'lesson_auto_applied', {
          targets: dbColumnTargets,
          values: dbColumnTargets.reduce<Record<string, unknown>>((acc, t) => {
            acc[t] = change[t];
            return acc;
          }, {}),
        });

        appliedCount++;
      } catch (e) {
        this.logger.warn(
          `[lesson-auto-apply] lesson ${lesson.id.slice(0, 8)} failed: ${String(e).slice(0, 200)}`,
        );
        errorCount++;
      }
    }

    this.logger.log(
      `[lesson-auto-apply] cycle done — scanned=${lessons.length} ` +
      `applied=${appliedCount} needsReview=${needsReviewCount} errors=${errorCount}`,
    );

    return { scanned: lessons.length, applied: appliedCount, needsReview: needsReviewCount, errors: errorCount };
  }

  /** Status pour endpoint admin observability. */
  async getStatus(): Promise<{
    enabled: boolean;
    minConfidence: number;
    minSampleSize: number;
    pendingHighConfidence: number;
    appliedTotal: number;
    needsReviewTotal: number;
  }> {
    const sb = this.supabase.getClient();
    const { count: pending } = await sb
      .from('scanner_lessons')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .eq('applied', false)
      .gte('confidence', this.minConfidence)
      .gte('sample_size', this.minSampleSize);

    const { count: applied } = await sb
      .from('scanner_lessons')
      .select('id', { count: 'exact', head: true })
      .eq('applied', true);

    const { count: needsReview } = await sb
      .from('lisa_decision_log')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'lesson_needs_manual_review')
      .gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString());

    return {
      enabled: this.enabled,
      minConfidence: this.minConfidence,
      minSampleSize: this.minSampleSize,
      pendingHighConfidence: pending ?? 0,
      appliedTotal: applied ?? 0,
      needsReviewTotal: needsReview ?? 0,
    };
  }

  private async logDecision(
    lesson: LessonRow,
    kind: 'lesson_auto_applied' | 'lesson_needs_manual_review',
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.supabase.getClient().from('lisa_decision_log').insert({
        portfolio_id: GAINERS_PORTFOLIO_IDS[0], // MAIN portfolio comme audit dest
        kind,
        rationale: `[lesson-auto-apply] ${lesson.lesson_text.slice(0, 200)} (lesson_id=${lesson.id.slice(0, 8)} ` +
          `confidence=${lesson.confidence} sample=${lesson.sample_size})`,
        payload: { lesson_id: lesson.id, lesson_kind: lesson.lesson_kind, ...extra },
      });
    } catch (e) {
      this.logger.debug(`[lesson-auto-apply] decision_log insert failed: ${String(e).slice(0, 80)}`);
    }
  }
}
