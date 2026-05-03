/**
 * Phase A — Insights log service.
 *
 * CRUD service pour gainers_insights_log (migration 0110). Sert de mémoire
 * persistante pour toute observation/divergence/drift collectée par :
 *   - opérateur humain (manual / session_chat)
 *   - cron drift detector (Phase B)
 *   - threshold auto-tuner (Phase C)
 *   - ML refit weekly (P9)
 *
 * Append-only : pas de DELETE exposé. Status évolue via UPDATE seulement.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export type InsightType =
  | 'divergence_analysis'
  | 'cadence_drift'
  | 'reject_pattern'
  | 'champion_observed'
  | 'threshold_proposal'
  | 'pipeline_bug'
  | 'data_quality'
  | 'ml_refit'
  | 'manual_observation';

export type InsightSource =
  | 'manual'
  | 'session_chat'
  | 'auto_drift_detector'
  | 'auto_threshold_tuner'
  | 'auto_ml_refit'
  | 'auto_anomaly_detector';

export type InsightStatus = 'open' | 'investigating' | 'actioned' | 'dismissed';
export type InsightSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface InsightRow {
  id: string;
  created_at: string;
  insight_type: InsightType;
  source: InsightSource;
  status: InsightStatus;
  severity: InsightSeverity;
  summary: string;
  payload: Record<string, unknown>;
  context?: Record<string, unknown> | null;
  resolution?: string | null;
  resolution_pr?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

export interface LogInsightInput {
  type: InsightType;
  source: InsightSource;
  summary: string;
  payload: Record<string, unknown>;
  severity?: InsightSeverity;
  context?: Record<string, unknown>;
}

export interface QueryInsightsInput {
  type?: InsightType;
  status?: InsightStatus;
  severity?: InsightSeverity;
  source?: InsightSource;
  sinceDays?: number;
  limit?: number;
}

@Injectable()
export class GainersInsightsService {
  private readonly logger = new Logger(GainersInsightsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Log un insight (append-only). Retourne l'id créé. */
  async logInsight(input: LogInsightInput): Promise<string | null> {
    const { type, source, summary, payload, severity = 'info', context } = input;
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_insights_log')
      .insert({
        insight_type: type,
        source,
        status: 'open',
        severity,
        summary: summary.slice(0, 500),
        payload,
        context: context ?? null,
      })
      .select('id')
      .single();

    if (error || !data) {
      this.logger.warn(`[insights] log failed: ${error?.message ?? 'no data'}`);
      return null;
    }
    return (data as { id: string }).id;
  }

  /** Query insights avec filtres optionnels. Default: 50 derniers, tous types. */
  async queryInsights(input: QueryInsightsInput = {}): Promise<InsightRow[]> {
    const { type, status, severity, source, sinceDays = 30, limit = 50 } = input;
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();

    let q = this.supabase
      .getClient()
      .from('gainers_insights_log')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 500));

    if (type) q = q.eq('insight_type', type);
    if (status) q = q.eq('status', status);
    if (severity) q = q.eq('severity', severity);
    if (source) q = q.eq('source', source);

    const { data, error } = await q;
    if (error || !data) {
      this.logger.warn(`[insights] query failed: ${error?.message ?? 'no data'}`);
      return [];
    }
    return data as InsightRow[];
  }

  /**
   * Update status + resolution metadata. Idempotent — si déjà actioned, no-op.
   */
  async resolveInsight(
    id: string,
    input: {
      status: 'investigating' | 'actioned' | 'dismissed';
      resolution?: string;
      resolutionPr?: string;
      resolvedBy?: string;
    },
  ): Promise<boolean> {
    const { status, resolution, resolutionPr, resolvedBy } = input;
    const patch: Record<string, unknown> = { status };
    if (status === 'actioned' || status === 'dismissed') {
      patch.resolved_at = new Date().toISOString();
      if (resolution) patch.resolution = resolution;
      if (resolutionPr) patch.resolution_pr = resolutionPr;
      if (resolvedBy) patch.resolved_by = resolvedBy;
    }
    const { error } = await this.supabase
      .getClient()
      .from('gainers_insights_log')
      .update(patch)
      .eq('id', id);

    if (error) {
      this.logger.warn(`[insights] resolve ${id} failed: ${error.message}`);
      return false;
    }
    return true;
  }

  /** Aggregate counts par type/status pour dashboard. */
  async getStats(sinceDays = 30): Promise<{
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
  }> {
    const rows = await this.queryInsights({ sinceDays, limit: 500 });
    const stats = {
      total: rows.length,
      byType: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
    };
    for (const r of rows) {
      stats.byType[r.insight_type] = (stats.byType[r.insight_type] ?? 0) + 1;
      stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
      stats.bySeverity[r.severity] = (stats.bySeverity[r.severity] ?? 0) + 1;
    }
    return stats;
  }
}
