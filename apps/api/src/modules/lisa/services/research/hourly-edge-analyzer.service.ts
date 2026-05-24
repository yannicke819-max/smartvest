/**
 * Hourly Edge Analyzer Service — cron weekly Sunday 03:00 UTC.
 *
 * Recalcule les heures perdantes par asset_class sur rolling 30 jours,
 * compare avec la blacklist actuellement configurée, et écrit ses
 * suggestions dans lisa_decision_log kind='hour_blacklist_suggestion'.
 *
 * V1 SHADOW : suggestions only, jamais d'auto-apply. Le user lit le log
 * puis décide de set/unset les env Fly manuellement.
 *
 * Gating : HOURLY_EDGE_ANALYZER_ENABLED (default false). Sans flag, no-op.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import {
  computeBucketStats,
  generateSuggestions,
  parseCurrentBlacklist,
  type ClosedTrade,
  type AnalyzerSuggestion,
} from './hourly-edge-analyzer.helper';

@Injectable()
export class HourlyEdgeAnalyzerService {
  private readonly logger = new Logger(HourlyEdgeAnalyzerService.name);
  private readonly enabled: boolean;
  private readonly lookbackDays: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('HOURLY_EDGE_ANALYZER_ENABLED') ?? 'false').toLowerCase() === 'true';
    const lookbackRaw = this.config.get<string>('HOURLY_EDGE_ANALYZER_LOOKBACK_DAYS');
    const n = lookbackRaw != null ? Number.parseInt(lookbackRaw, 10) : NaN;
    this.lookbackDays = Number.isFinite(n) && n >= 7 && n <= 180 ? n : 30;
    if (this.enabled) {
      this.logger.log(
        `[hourly-edge-analyzer] ENABLED — cron Sunday 03:00 UTC, lookback ${this.lookbackDays}d`,
      );
    }
  }

  /** Cron weekly Sunday 03:00 UTC — après market close US (Vendredi 21:00 UTC) + weekend de calme. */
  @Cron('0 3 * * 0', { timeZone: 'UTC' })
  async cronWeeklyAnalysis(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const result = await this.runAnalysis();
      if (result) {
        await this.persistSuggestion(result);
        this.logger.log(`[hourly-edge-analyzer] ${result.summary}`);
      }
    } catch (e) {
      this.logger.warn(`[hourly-edge-analyzer] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** Exécution manuelle (à appeler depuis admin endpoint si besoin). */
  async runAnalysis(): Promise<AnalyzerSuggestion | null> {
    const cutoff = new Date(Date.now() - this.lookbackDays * 86_400_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('asset_class, entry_timestamp, realized_pnl_usd, realized_pnl_pct, status')
      .neq('status', 'open')
      .gte('exit_timestamp', cutoff)
      .not('asset_class', 'is', null)
      .not('realized_pnl_pct', 'is', null)
      .limit(5000);
    if (error || !data) {
      this.logger.warn(`[hourly-edge-analyzer] DB fetch failed: ${error?.message ?? 'no data'}`);
      return null;
    }

    const trades: ClosedTrade[] = (data as Array<{
      asset_class: string;
      entry_timestamp: string;
      realized_pnl_usd: number | null;
      realized_pnl_pct: number | null;
      status: string;
    }>)
      .filter((r) => r.realized_pnl_usd != null && r.realized_pnl_pct != null)
      .map((r) => ({
        asset_class: r.asset_class,
        entry_hour_utc: Number.parseInt(r.entry_timestamp.slice(11, 13), 10),
        realized_pnl_usd: r.realized_pnl_usd as number,
        realized_pnl_pct: r.realized_pnl_pct as number,
        status: r.status,
      }))
      .filter((t) => Number.isFinite(t.entry_hour_utc) && t.entry_hour_utc >= 0 && t.entry_hour_utc <= 23);

    this.logger.log(`[hourly-edge-analyzer] analysis : n=${trades.length} closed trades on ${this.lookbackDays}d window`);

    const stats = computeBucketStats(trades);
    const currentBlacklist = parseCurrentBlacklist({
      GAINERS_HOUR_BLACKLIST_ASIA_UTC: this.config.get<string>('GAINERS_HOUR_BLACKLIST_ASIA_UTC'),
      GAINERS_HOUR_BLACKLIST_US_UTC: this.config.get<string>('GAINERS_HOUR_BLACKLIST_US_UTC'),
      GAINERS_HOUR_BLACKLIST_EU_UTC: this.config.get<string>('GAINERS_HOUR_BLACKLIST_EU_UTC'),
      GAINERS_HOUR_BLACKLIST_CRYPTO_UTC: this.config.get<string>('GAINERS_HOUR_BLACKLIST_CRYPTO_UTC'),
    });

    return generateSuggestions(stats, currentBlacklist);
  }

  private async persistSuggestion(result: AnalyzerSuggestion): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      const addStr = result.add.length > 0
        ? `ADD: ${result.add.map((s) => `${s.asset_class}@H${s.hour_utc}`).join(', ')}`
        : 'ADD: none';
      const remStr = result.remove.length > 0
        ? `REMOVE: ${result.remove.map((s) => `${s.asset_class}@H${s.hour_utc}`).join(', ')}`
        : 'REMOVE: none';
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          portfolio_id: null,
          kind: 'hour_blacklist_suggestion',
          triggered_by: 'autopilot_cron',
          summary: `[HOUR_ANALYZER] ${result.summary}`,
          rationale: `${addStr} | ${remStr}`,
          payload: {
            lookback_days: this.lookbackDays,
            add: result.add,
            remove: result.remove,
            bucket_stats_summary: result.bucket_stats.length,
            mode: 'shadow_v1',
          },
        });
    } catch (e) {
      this.logger.warn(`[hourly-edge-analyzer] persist failed: ${String(e).slice(0, 200)}`);
    }
  }
}
