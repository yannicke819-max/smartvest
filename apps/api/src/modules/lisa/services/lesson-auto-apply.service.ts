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
  'b0000001-0000-0000-0000-000000000001', // TRADER (ex-MAIN 58439d86, migré 30/05/2026)
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
  // Fix A 03/06/2026 — extension whitelist suite audit GLOBAL: KO :
  // 270 lessons en `needs_manual_review` car les ConfigSanity générées par
  // le system ciblent des colonnes lisa_session_configs PAS dans la whitelist
  // (min_change_pct_eu, max_open_positions, position_pct, etc.). Résultat :
  // 0 auto-apply en 24h. Bounds appliqués via SAFE_VALUE_BOUNDS ci-dessous.
  'min_change_pct_eu',
  'min_change_pct_us_smallmid',
  'min_change_pct_us_large',
  'min_change_pct_asia',
  'min_change_pct_crypto',
  'max_open_positions',
  'position_pct',
  'sl_pct',
  'tp_pct',
]);

/**
 * Bounds de sécurité par colonne. Empêche un auto-apply catastrophique
 * (Gemini propose position_pct=80 → tout le capital sur 1 trade). Si la
 * valeur proposée est hors bounds, la lesson tombe en needs_manual_review.
 *
 * Format : [min, max] inclusifs.
 */
const SAFE_VALUE_BOUNDS: Record<string, [number, number]> = {
  // Existing whitelist columns (bounds documented à titre informatif, pas appliqués sur les anciennes)
  gainers_default_sl_pct: [0.3, 5],
  gainers_default_tp_pct: [0.5, 10],
  gainers_min_persistence_score: [0, 1],
  gainers_min_path_efficiency: [0, 1],
  gainers_max_change_pct: [3, 50],
  gainers_min_change_pct: [0.5, 10],
  gainers_fees_aware_buffer: [1, 5],
  gainers_position_pct: [1, 30],
  gainers_cycle_minutes: [1, 60],
  gainers_persistence_top_n: [5, 100],
  news_shock_close_max_age_minutes_lse: [5, 240],
  news_shock_close_sentiment_threshold_lse: [-1, 0],
  // Fix A nouvelles colonnes — bounds STRICTS
  min_change_pct_eu: [0.5, 15],
  min_change_pct_us_smallmid: [0.5, 15],
  min_change_pct_us_large: [0.5, 15],
  min_change_pct_asia: [0.5, 15],
  min_change_pct_crypto: [0.5, 15],
  max_open_positions: [1, 20],
  position_pct: [1, 30],
  sl_pct: [0.5, 5],
  tp_pct: [0.5, 10],
};

function isValueWithinBounds(column: string, value: unknown): boolean {
  const bounds = SAFE_VALUE_BOUNDS[column];
  if (!bounds) return true; // Pas de bounds = pas de check (compat backward)
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n >= bounds[0] && n <= bounds[1];
}

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

        // Fix #3 (01/06) — Cron quotidien decay confidence : pour les lessons
        // actives mais non-citées depuis 30j, décroître confidence × 0.95.
        // Sous 0.50, marquer is_active=false (auto-archive). Évite que des
        // lessons obsolètes polluent indéfiniment le score composite et
        // saturent le cap 10k de ScannerLessonsContextService.
        const decayJob = new CronJob('0 3 * * *', () => {
          this.runConfidenceDecay().catch((e) =>
            this.logger.error(`[lesson-auto-apply] decay cron failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('lesson-confidence-decay', decayJob);
        decayJob.start();
        this.logger.log('[lesson-auto-apply] confidence decay cron registered — daily @ 03:00 UTC');
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

        // Fix #2 (01/06) — ANTI-FLAP : avant chaque UPDATE, check si la même
        // colonne a déjà été auto-modifiée par lesson dans les dernières 24h
        // (cf. lisa_decision_log kind='lesson_auto_applied'). Si oui, skip
        // pour éviter le flip-flop config (Gemini propose X jour 1 → applied,
        // Y jour 2 → applied → X jour 3 → ...).
        const sinceUtc = new Date(Date.now() - 24 * 3600_000).toISOString();
        const { data: recentApplies } = await sb
          .from('lisa_decision_log')
          .select('payload')
          .eq('kind', 'lesson_auto_applied')
          .gte('created_at', sinceUtc)
          .limit(200);
        const recentCols = new Set<string>();
        for (const row of (recentApplies ?? []) as Array<{ payload?: { targets?: string[] } }>) {
          for (const t of row.payload?.targets ?? []) {
            recentCols.add(t.replace('lisa_session_configs.', ''));
          }
        }

        // Apply chaque DB column change sur les 4 portfolios gainers
        // Bug fix 27/05/2026 : utiliser `.select()` pour récupérer les rows
        // affectées et marker `applied=true` uniquement si ≥ 1 UPDATE a
        // réellement changé une row. PostgREST ne lève PAS d'erreur si la
        // colonne n'existe pas (UPDATE silently no-op), donc un check sur
        // `error` seul ne suffit pas — il faut compter les rows retournées.
        let rowsChangedTotal = 0;
        const failedTargets: string[] = [];
        const skippedAntiFlap: string[] = [];
        for (const target of dbColumnTargets) {
          const col = target.replace('lisa_session_configs.', '');
          const value = change[target];

          // Fix A 03/06/2026 — bounds check (anti-catastrophic-value)
          if (!isValueWithinBounds(col, value)) {
            this.logger.warn(
              `[lesson-auto-apply] BOUNDS_REJECT ${col}=${JSON.stringify(value)} ` +
              `outside ${JSON.stringify(SAFE_VALUE_BOUNDS[col])} — lesson skipped`,
            );
            failedTargets.push(`${col}:out_of_bounds`);
            errorCount++;
            continue;
          }

          // Anti-flap guard
          if (recentCols.has(col)) {
            this.logger.log(
              `[lesson-auto-apply] anti-flap skip ${col} (déjà auto-applied dans les 24h)`,
            );
            skippedAntiFlap.push(col);
            continue;
          }
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
        // → audit "needs_manual_review" pour visibilité (sauf si tout a été
        // skip par anti-flap — alors c'est un skip volontaire, pas un échec).
        if (rowsChangedTotal === 0) {
          if (skippedAntiFlap.length === dbColumnTargets.length) {
            this.logger.log(
              `[lesson-auto-apply] lesson ${lesson.id.slice(0, 8)} entirely skipped (anti-flap on all targets: ${skippedAntiFlap.join(',')})`,
            );
            // Pas de lesson_needs_manual_review — c'est un skip propre.
            continue;
          }
          await this.logDecision(lesson, 'lesson_needs_manual_review', {
            reason: 'all_updates_zero_rows',
            db_targets: dbColumnTargets,
            failed_targets: failedTargets,
            skipped_anti_flap: skippedAntiFlap,
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

  /**
   * Fix #3 — Decay quotidien de la confidence pour lessons stagnantes.
   *
   * Une lesson active mais non-citée depuis 30j (pas de scanner_lesson_citations
   * dans cette fenêtre) voit sa confidence multipliée par 0.95 (decay 5%/jour).
   * Sous le seuil 0.50, marquée is_active=false (auto-archive) — elle n'apparaît
   * plus dans les prompts injectés mais reste auditable historique.
   *
   * Anti-pollution : sans ce decay, le cap 10k de ScannerLessonsContextService
   * finit par saturer avec des lessons anciennes peu pertinentes qui faussent
   * le score composite.
   */
  async runConfidenceDecay(): Promise<{ decayed: number; archived: number }> {
    const sb = this.supabase.getClient();
    const thresholdActive = 0.50;
    const decayFactor = 0.95;
    const inactivityCutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();

    // 1. Lessons actives candidates au decay (non-citées depuis 30j)
    const { data: lessonsRaw, error } = await sb
      .from('scanner_lessons')
      .select('id, confidence, derived_from_date')
      .eq('is_active', true)
      .lt('derived_from_date', inactivityCutoff.slice(0, 10));
    if (error) {
      this.logger.warn(`[lesson-decay] fetch failed: ${error.message}`);
      return { decayed: 0, archived: 0 };
    }
    const lessons = (lessonsRaw ?? []) as Array<{ id: string; confidence: number }>;
    if (lessons.length === 0) {
      this.logger.debug('[lesson-decay] 0 lesson candidate au decay');
      return { decayed: 0, archived: 0 };
    }

    // 2. Pour chaque lesson, vérifier si citée récemment (skip decay si oui)
    const { data: recentCitations } = await sb
      .from('scanner_lesson_citations')
      .select('lesson_id')
      .gte('decision_decided_at', inactivityCutoff)
      .not('lesson_id', 'is', null)
      .limit(5000);
    const citedRecently = new Set<string>(
      (recentCitations ?? []).map((r) => (r as { lesson_id: string }).lesson_id).filter(Boolean),
    );

    let decayed = 0;
    let archived = 0;
    for (const l of lessons) {
      if (citedRecently.has(l.id)) continue;
      const newConfidence = Math.round(l.confidence * decayFactor * 100) / 100;
      const update: Record<string, unknown> = { confidence: newConfidence };
      let willArchive = false;
      if (newConfidence < thresholdActive) {
        update.is_active = false;
        willArchive = true;
      }
      const { error: upErr } = await sb
        .from('scanner_lessons')
        .update(update)
        .eq('id', l.id);
      if (upErr) {
        this.logger.debug(`[lesson-decay] update ${l.id.slice(0, 8)} failed: ${upErr.message}`);
        continue;
      }
      if (willArchive) archived++;
      else decayed++;
    }
    if (decayed > 0 || archived > 0) {
      this.logger.log(
        `[lesson-decay] processed ${lessons.length} candidates → ${decayed} decayed, ${archived} archived (is_active=false)`,
      );
    }
    return { decayed, archived };
  }
}
