/**
 * Phase B — ProbabilityRefitCronService.
 *
 * Cron weekly Sunday 02:00 UTC qui re-fit le modèle P9 logistic regression
 * (P(win) sur features persistence) depuis paper_trades fermés.
 *
 * Documente CLAUDE.md §P9 :
 *   "Out of scope ce PR (deferred follow-up): Cron Sunday 02:00 UTC (à wirer
 *    dans LisaAutopilotService ou nouveau service ProbabilityRefitCron)"
 *
 * Cette PR (Phase B) wire ce cron + auto-log un `ml_refit` insight avec
 * metrics (AUC, accuracy, sample size, accepté/rejeté) pour traçabilité
 * complète des évolutions du modèle.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PersistenceProbabilityService } from '../../lisa/services/persistence-probability.service';
import { GainersInsightsService } from '../insights/gainers-insights.service';

@Injectable()
export class ProbabilityRefitCronService {
  private readonly logger = new Logger(ProbabilityRefitCronService.name);

  constructor(
    private readonly probability: PersistenceProbabilityService,
    private readonly insights: GainersInsightsService,
  ) {}

  /** Cron Sunday 02:00 UTC strict (PR6.8.1 timezone explicite). */
  @Cron('0 2 * * 0', { timeZone: 'UTC' })
  async runWeeklyRefit(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[ml-refit] cron failed: ${String(e).slice(0, 200)}`);
      // Auto-log error insight
      await this.insights.logInsight({
        type: 'ml_refit',
        source: 'auto_ml_refit',
        severity: 'medium',
        summary: `Weekly P9 refit cron failed: ${String(e).slice(0, 200)}`,
        payload: { error: String(e).slice(0, 500), timestamp: new Date().toISOString() },
      });
    }
  }

  private async runInner(): Promise<void> {
    this.logger.log('[ml-refit] starting weekly P9 logistic regression refit');
    const result = await this.probability.trainAndPersist({ lookbackDays: 30 });

    // Log insight quel que soit le résultat (accepted/rejected/insufficient)
    const accepted = (result as { accepted?: boolean }).accepted ?? false;
    const auc = (result as { aucRoc?: number }).aucRoc ?? null;
    const accuracy = (result as { accuracy?: number }).accuracy ?? null;
    const sampleSize = (result as { sampleSize?: number }).sampleSize ?? 0;
    const version = (result as { modelVersion?: string }).modelVersion ?? null;
    const reason = (result as { reason?: string }).reason ?? null;

    const severity = accepted
      ? 'info'
      : sampleSize < 30 ? 'low' : 'medium';

    await this.insights.logInsight({
      type: 'ml_refit',
      source: 'auto_ml_refit',
      severity,
      summary: accepted
        ? `P9 refit accepté — version ${version} (AUC ${auc?.toFixed(3) ?? 'n/a'}, accuracy ${accuracy?.toFixed(3) ?? 'n/a'}, n=${sampleSize})`
        : `P9 refit rejeté — ${reason ?? 'unknown'} (sample n=${sampleSize}, AUC ${auc?.toFixed(3) ?? 'n/a'})`,
      payload: {
        accepted,
        model_version: version,
        auc_roc: auc,
        accuracy,
        sample_size: sampleSize,
        reason,
        lookback_days: 30,
        cron_at: new Date().toISOString(),
      },
    });

    this.logger.log(
      `[ml-refit] ${accepted ? 'accepted' : 'rejected'} — ` +
      `version=${version ?? 'n/a'} auc=${auc?.toFixed(3) ?? 'n/a'} n=${sampleSize}`,
    );
  }
}
