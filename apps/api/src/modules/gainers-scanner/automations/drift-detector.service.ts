/**
 * Phase B — DriftDetectorService.
 *
 * Cron daily 23:50 UTC qui scanne le shadow pour détecter automatiquement :
 *   1. Cadence drift  : ACCEPT/24h chute vs W-1 → log cadence_drift insight
 *   2. Divergence drift : V1 vs legacy disagreement % en hausse → log
 *   3. Reject concentration : > 60% des rejects sur même reason → log reject_pattern
 *   4. Zero ACCEPT 7d : aucun ACCEPT 7 jours consécutifs → log severity=high
 *
 * Tous les insights logués via GainersInsightsService (Phase A) avec
 * source='auto_drift_detector'. Pas de flip auto sur les seuils — propose
 * uniquement à l'opérateur via insights pour validation humaine.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { GainersInsightsService } from '../insights/gainers-insights.service';

const CADENCE_DROP_THRESHOLD_PCT = 0.30; // 30% drop W-1 vs W-2
const DIVERGENCE_RISE_THRESHOLD_PCT = 0.10; // +10pp rise W-1 vs W-2
const REJECT_CONCENTRATION_THRESHOLD = 0.60; // > 60% same reject_reason
const ZERO_ACCEPT_DAYS_THRESHOLD = 7;

interface ShadowSignalRow {
  decision: string;
  reject_reason: string | null;
  diverges_from_legacy: boolean | null;
  created_at: string;
}

@Injectable()
export class DriftDetectorService {
  private readonly logger = new Logger(DriftDetectorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly insights: GainersInsightsService,
  ) {}

  /** Cron daily 23:50 UTC. */
  @Cron('50 23 * * *')
  async runDriftDetection(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[drift] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runInner(): Promise<void> {
    const now = Date.now();
    const w1Start = new Date(now - 7 * 24 * 3600_000).toISOString();
    const w2Start = new Date(now - 14 * 24 * 3600_000).toISOString();
    const nowIso = new Date(now).toISOString();

    const w1 = await this.fetchSignals(w1Start, nowIso);
    const w2 = await this.fetchSignals(w2Start, w1Start);

    const w1Stats = this.computeStats(w1);
    const w2Stats = this.computeStats(w2);

    let insightsLogged = 0;

    // 1. Cadence drift
    if (w2Stats.acceptCount > 0) {
      const cadenceRatio = w1Stats.acceptCount / w2Stats.acceptCount;
      if (cadenceRatio < 1 - CADENCE_DROP_THRESHOLD_PCT) {
        await this.insights.logInsight({
          type: 'cadence_drift',
          source: 'auto_drift_detector',
          severity: cadenceRatio < 0.5 ? 'high' : 'medium',
          summary: `Cadence ACCEPT chute de ${((1 - cadenceRatio) * 100).toFixed(0)}% W-1 vs W-2 (${w1Stats.acceptCount} vs ${w2Stats.acceptCount})`,
          payload: {
            window_w1: { start: w1Start, end: nowIso, accept: w1Stats.acceptCount, total: w1Stats.total },
            window_w2: { start: w2Start, end: w1Start, accept: w2Stats.acceptCount, total: w2Stats.total },
            cadence_ratio: cadenceRatio,
            threshold_pct: CADENCE_DROP_THRESHOLD_PCT,
          },
        });
        insightsLogged++;
      }
    }

    // 2. Divergence rise
    if (w1Stats.total > 0 && w2Stats.total > 0) {
      const divW1 = w1Stats.divergenceCount / w1Stats.total;
      const divW2 = w2Stats.divergenceCount / w2Stats.total;
      const divRise = divW1 - divW2;
      if (divRise > DIVERGENCE_RISE_THRESHOLD_PCT) {
        await this.insights.logInsight({
          type: 'cadence_drift',
          source: 'auto_drift_detector',
          severity: divRise > 0.20 ? 'high' : 'medium',
          summary: `Divergence legacy vs V1 monte de +${(divRise * 100).toFixed(1)}pp (W-1=${(divW1 * 100).toFixed(1)}% vs W-2=${(divW2 * 100).toFixed(1)}%)`,
          payload: {
            divergence_w1_pct: divW1,
            divergence_w2_pct: divW2,
            rise_pp: divRise,
            threshold_pp: DIVERGENCE_RISE_THRESHOLD_PCT,
          },
        });
        insightsLogged++;
      }
    }

    // 3. Reject concentration anormale
    if (w1Stats.total > 30) {
      const topReject = Object.entries(w1Stats.rejectReasons)
        .sort((a, b) => b[1] - a[1])[0];
      if (topReject) {
        const concentration = topReject[1] / w1Stats.total;
        if (concentration > REJECT_CONCENTRATION_THRESHOLD) {
          await this.insights.logInsight({
            type: 'reject_pattern',
            source: 'auto_drift_detector',
            severity: concentration > 0.80 ? 'medium' : 'low',
            summary: `${topReject[0]} concentre ${(concentration * 100).toFixed(0)}% des rejects W-1 (${topReject[1]}/${w1Stats.total})`,
            payload: {
              reject_reason: topReject[0],
              count: topReject[1],
              total: w1Stats.total,
              concentration_pct: concentration,
              threshold_pct: REJECT_CONCENTRATION_THRESHOLD,
              all_reasons: w1Stats.rejectReasons,
            },
          });
          insightsLogged++;
        }
      }
    }

    // 4. Zero ACCEPT 7 jours
    if (w1Stats.acceptCount === 0 && w1Stats.total > 100) {
      await this.insights.logInsight({
        type: 'cadence_drift',
        source: 'auto_drift_detector',
        severity: 'high',
        summary: `Aucun ACCEPT V1 sur ${ZERO_ACCEPT_DAYS_THRESHOLD} jours (${w1Stats.total} signals évalués)`,
        payload: {
          window_days: ZERO_ACCEPT_DAYS_THRESHOLD,
          total_signals: w1Stats.total,
          reject_breakdown: w1Stats.rejectReasons,
        },
      });
      insightsLogged++;
    }

    if (insightsLogged > 0) {
      this.logger.log(`[drift] detected ${insightsLogged} new insight(s) — written to gainers_insights_log`);
    }
  }

  private async fetchSignals(start: string, end: string): Promise<ShadowSignalRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('decision, reject_reason, diverges_from_legacy, created_at')
      .gte('created_at', start)
      .lt('created_at', end)
      .limit(50_000);

    if (error || !data) {
      this.logger.warn(`[drift] fetch failed: ${error?.message ?? 'no data'}`);
      return [];
    }
    return data as ShadowSignalRow[];
  }

  private computeStats(rows: ShadowSignalRow[]): {
    total: number;
    acceptCount: number;
    rejectCount: number;
    divergenceCount: number;
    rejectReasons: Record<string, number>;
  } {
    const stats = {
      total: rows.length,
      acceptCount: 0,
      rejectCount: 0,
      divergenceCount: 0,
      rejectReasons: {} as Record<string, number>,
    };
    for (const r of rows) {
      if (r.decision === 'ACCEPT') stats.acceptCount++;
      else stats.rejectCount++;
      if (r.diverges_from_legacy === true) stats.divergenceCount++;
      if (r.reject_reason) {
        stats.rejectReasons[r.reject_reason] = (stats.rejectReasons[r.reject_reason] ?? 0) + 1;
      }
    }
    return stats;
  }
}
