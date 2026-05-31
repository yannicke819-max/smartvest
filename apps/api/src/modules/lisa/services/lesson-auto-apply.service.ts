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

/**
 * Colonnes `lisa_session_configs` que l'auto-apply est autorisé à modifier.
 * Whitelist explicite (sécurité défense en profondeur — empêche un Gemini
 * malveillant ou bug de prompt d'écrire dans capital_usd, autopilot_enabled,
 * kill_switch_active, etc.). Étendre uniquement après validation manuelle
 * que la colonne est calibrable sans risque catastrophique.
 */
const LISA_SESSION_CONFIG_AUTO_APPLY_COLUMNS: ReadonlySet<string> = new Set<string>([
  'gainers_default_sl_pct',
  'gainers_default_tp_pct',
  'gainers_min_persistence_score',
  'gainers_min_path_efficiency',
  'gainers_max_change_pct',
  'gainers_min_change_pct',
  'gainers_fees_aware_buffer',
  'gainers_position_pct',
  'gainers_cycle_minutes',
  'gainers_persistence_top_n',
  'news_shock_close_max_age_minutes_lse',
  'news_shock_close_sentiment_threshold_lse',
]);

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
    } else {
      // 31/05/2026 — log explicite quand désactivé (constat prod : 0 entrée
      // lesson_auto_applied OU lesson_needs_manual_review sur 7j alors que
      // 14 lessons crypto conf ≥ 0.85 disponibles → soupçon flag false).
      this.logger.warn(
        '[lesson-auto-apply] DISABLED (env LESSON_AUTO_APPLY_ENABLED=false) — ' +
        'aucun cycle ne tournera, les lessons high-conf restent applied=false indéfiniment',
      );
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

        // Inspection des cibles : DB column auto-applicable, env vars manual review.
        //
        // 31/05/2026 — Lessons générées par Gemini émettent souvent des keys nues
        // (`gainers_default_sl_pct`, `gainers_min_persistence_score`) sans le
        // préfixe `lisa_session_configs.`. Avant : le parser ne reconnaissait QUE
        // le préfixe → 0% des lessons récentes auto-applicables (vérifié prod :
        // 0 lesson_auto_applied / 0 needs_review sur 7j alors que 14 lessons crypto
        // conf ≥ 0.85 existaient).
        //
        // Fix : whitelist explicite des colonnes auto-applicables (sécurité), accepte
        // les 2 formats (`lisa_session_configs.<col>` et `<col>` nu). Tout ce qui
        // n'est ni dans la whitelist ni env var explicite → noise/meta key (table,
        // portfolio_id_only, note...) → ignoré silencieusement, pas un blocker.
        //
        // Les env vars (commence par majuscule + underscore, ex GAINERS_*) restent
        // en needs_review avec commande fly secrets set prête à copier.
        const targets = Object.keys(change);
        const isMetaKey = (t: string) => ['table', 'portfolio_id_only', 'note', 'comment'].includes(t.toLowerCase());
        const isEnvVar = (t: string) => /^[A-Z][A-Z0-9_]+$/.test(t);
        const stripPrefix = (t: string) => t.startsWith('lisa_session_configs.') ? t.slice('lisa_session_configs.'.length) : t;

        const dbColumnTargets: string[] = [];
        const envVarTargets: string[] = [];
        for (const t of targets) {
          if (isMetaKey(t)) continue;
          const col = stripPrefix(t);
          if (LISA_SESSION_CONFIG_AUTO_APPLY_COLUMNS.has(col)) {
            dbColumnTargets.push(t);
          } else if (isEnvVar(t)) {
            envVarTargets.push(t);
          }
          // Autres keys (snake_case non whitelisté) ignorées silencieusement
          // pour éviter de bloquer toute la lesson sur 1 typo Gemini.
        }

        if (envVarTargets.length > 0 && dbColumnTargets.length === 0) {
          // Lesson 100% env var → needs review humaine, payload contient les
          // commandes fly directement utilisables.
          const flyCommands = envVarTargets.map((t) => `fly secrets set ${t}=${JSON.stringify(change[t])} -a smartvest`);
          await this.logDecision(lesson, 'lesson_needs_manual_review', {
            reason: 'env_var_target_requires_fly_secret',
            env_targets: envVarTargets,
            fly_commands: flyCommands,
          });
          needsReviewCount++;
          continue;
        }

        if (dbColumnTargets.length === 0) {
          // Aucune cible exploitable (que des meta keys + clés non reconnues)
          await this.logDecision(lesson, 'lesson_needs_manual_review', {
            reason: 'no_applicable_target',
            raw_targets: targets,
          });
          needsReviewCount++;
          continue;
        }

        // Apply chaque DB column change sur les 4 portfolios gainers
        // Bug fix 27/05/2026 : utiliser `.select()` pour récupérer les rows
        // affectées et marker `applied=true` uniquement si ≥ 1 UPDATE a
        // réellement changé une row. PostgREST ne lève PAS d'erreur si la
        // colonne n'existe pas (UPDATE silently no-op), donc un check sur
        // `error` seul ne suffit pas — il faut compter les rows retournées.
        let rowsChangedTotal = 0;
        const failedTargets: string[] = [];
        for (const target of dbColumnTargets) {
          const col = target.replace('lisa_session_configs.', '');
          const value = change[target];
          const { data: updated, error: updErr } = await sb
            .from('lisa_session_configs')
            .update({ [col]: value })
            .in('portfolio_id', GAINERS_PORTFOLIO_IDS)
            .select('portfolio_id');

          if (updErr) {
            this.logger.warn(
              `[lesson-auto-apply] UPDATE ${col}=${JSON.stringify(value)} failed: ${updErr.message}`,
            );
            errorCount++;
            failedTargets.push(`${col}:${updErr.message.slice(0, 50)}`);
            continue;
          }

          const rowsChanged = Array.isArray(updated) ? updated.length : 0;
          if (rowsChanged === 0) {
            this.logger.warn(
              `[lesson-auto-apply] UPDATE ${col}=${JSON.stringify(value)} affected 0 rows ` +
              `(column probably missing or rows didn't match). Lesson ${lesson.id.slice(0, 8)} NOT marked applied.`,
            );
            failedTargets.push(`${col}:0_rows_affected`);
            errorCount++;
            continue;
          }

          rowsChangedTotal += rowsChanged;
          this.logger.log(
            `[lesson-auto-apply] APPLIED lesson=${lesson.id.slice(0, 8)} ${col}=${JSON.stringify(value)} ` +
            `(${rowsChanged} rows) confidence=${lesson.confidence} sample=${lesson.sample_size}`,
          );
        }

        // Guard : si AUCUN UPDATE n'a changé de row, ne pas marker applied=true
        // → audit "needs_manual_review" pour visibilité.
        if (rowsChangedTotal === 0) {
          await this.logDecision(lesson, 'lesson_needs_manual_review', {
            reason: 'all_updates_zero_rows',
            db_targets: dbColumnTargets,
            failed_targets: failedTargets,
          });
          needsReviewCount++;
          continue;
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
    // Insert sur lisa_decision_log : triggered_by est NOT NULL + CHECK constraint
    // (cf. daily-catalyst-brief.service:160-162). Valeur compatible : 'autopilot_cron'.
    // summary requis aussi (NOT NULL probable). Sans ces champs l'insert silently fail.
    const { error } = await this.supabase.getClient().from('lisa_decision_log').insert({
      portfolio_id: GAINERS_PORTFOLIO_IDS[0],
      kind,
      triggered_by: 'autopilot_cron',
      summary: `[lesson-auto-apply] ${kind} lesson=${lesson.id.slice(0, 8)} kind=${lesson.lesson_kind}`,
      rationale: `[lesson-auto-apply] ${lesson.lesson_text.slice(0, 200)} (lesson_id=${lesson.id.slice(0, 8)} ` +
        `confidence=${lesson.confidence} sample=${lesson.sample_size})`,
      payload: { lesson_id: lesson.id, lesson_kind: lesson.lesson_kind, ...extra },
    });
    if (error) {
      this.logger.warn(`[lesson-auto-apply] decision_log insert failed: ${error.message}`);
    }
  }
}
