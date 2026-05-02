/**
 * ADR-005 Phase 3.2 PR6.2 — Shadow daily report service.
 *
 * Cron 23:30 UTC chaque jour :
 *   - aggregate gainers_v1_shadow_signals du jour calendaire UTC
 *   - INSERT/UPSERT 1 row dans gainers_shadow_daily_report
 *   - calcul anomaly flags (zero_signals_48h, high_slippage_2x, low_cadence_7d)
 *
 * Idempotent : ON CONFLICT (report_date) DO UPDATE — safe à rerun manuel.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';

export interface DailyReportRow {
  reportDate: string;
  totalSignals: number;
  acceptCount: number;
  rejectCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgRealizedPnlPct: number | null;
  cumulativePnlPct: number | null;
  avgSlippagePct: number | null;
  anomalousFillCount: number;
  divergenceCount: number;
  divergencePct: number | null;
  triggerBreakdown: Record<string, number>;
  zeroSignalsFlag: boolean;
  highSlippageFlag: boolean;
  lowCadenceFlag: boolean;
}

const HIGH_SLIPPAGE_THRESHOLD = 0.006; // 2× ADR §11.3 cap 0.30%
const LOW_CADENCE_THRESHOLD = 0.5; // < 0.5 accept/jour sur 7j → risque ETA

@Injectable()
export class ShadowDailyReportService {
  private readonly logger = new Logger(ShadowDailyReportService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Cron quotidien 23:30 UTC — aggregate du jour courant. */
  @Cron('30 23 * * *')
  async runDailyReport(): Promise<void> {
    const today = this.todayUtcDateStr();
    try {
      await this.computeAndUpsert(today);
      this.logger.log(`[shadow-daily-report] computed ${today}`);
    } catch (e) {
      this.logger.error(`[shadow-daily-report] ${today} failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Calcule + UPSERT le report d'une date donnée. Public pour permettre
   * recompute manuel (admin endpoint follow-up) ou backfill.
   */
  async computeAndUpsert(reportDate: string): Promise<DailyReportRow | null> {
    const dayStart = `${reportDate}T00:00:00Z`;
    const dayEnd = `${reportDate}T23:59:59.999Z`;

    const { data: signals, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('decision, simulated_pnl_pct, simulated_slippage_pct, diverges_from_legacy, setup_type')
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd);

    if (error) {
      this.logger.warn(`fetch signals ${reportDate} failed: ${error.message}`);
      return null;
    }

    const rows = signals ?? [];
    let acceptCount = 0;
    let rejectCount = 0;
    let closedCount = 0;
    let winCount = 0;
    let lossCount = 0;
    let divergenceCount = 0;
    const pnls: number[] = [];
    const slippages: number[] = [];
    let anomalousFillCount = 0;
    const triggerBreakdown: Record<string, number> = {};

    for (const row of rows) {
      const r = row as any;
      if (r.decision === 'ACCEPT') {
        acceptCount++;
        if (r.setup_type) {
          triggerBreakdown[r.setup_type] = (triggerBreakdown[r.setup_type] ?? 0) + 1;
        }
      } else {
        rejectCount++;
      }
      if (r.simulated_pnl_pct !== null && r.simulated_pnl_pct !== undefined) {
        const pnl = Number(r.simulated_pnl_pct);
        closedCount++;
        pnls.push(pnl);
        if (pnl > 0) winCount++;
        else if (pnl < 0) lossCount++;
      }
      if (r.simulated_slippage_pct !== null && r.simulated_slippage_pct !== undefined) {
        const slip = Number(r.simulated_slippage_pct);
        slippages.push(slip);
        if (Math.abs(slip) > 0.01) anomalousFillCount++;
      }
      if (r.diverges_from_legacy === true) divergenceCount++;
    }

    const totalSignals = rows.length;
    const winRate = closedCount > 0 ? winCount / closedCount : null;
    const avgPnl = pnls.length > 0 ? pnls.reduce((s, n) => s + n, 0) / pnls.length : null;
    const cumPnl = pnls.length > 0 ? pnls.reduce((s, n) => s + n, 0) : null;
    const avgSlip = slippages.length > 0 ? slippages.reduce((s, n) => s + n, 0) / slippages.length : null;
    const divergencePct = totalSignals > 0 ? divergenceCount / totalSignals : null;

    // Anomaly flags
    const zeroSignalsFlag = await this.checkZeroSignals48h(reportDate, acceptCount);
    const highSlippageFlag = avgSlip !== null && Math.abs(avgSlip) > HIGH_SLIPPAGE_THRESHOLD;
    const lowCadenceFlag = await this.checkLowCadence7d(reportDate);

    const payload = {
      report_date: reportDate,
      total_signals: totalSignals,
      accept_count: acceptCount,
      reject_count: rejectCount,
      closed_count: closedCount,
      win_count: winCount,
      loss_count: lossCount,
      win_rate: winRate,
      avg_realized_pnl_pct: avgPnl,
      cumulative_pnl_pct: cumPnl,
      avg_slippage_pct: avgSlip,
      anomalous_fill_count: anomalousFillCount,
      divergence_count: divergenceCount,
      divergence_pct: divergencePct,
      trigger_breakdown: triggerBreakdown,
      zero_signals_flag: zeroSignalsFlag,
      high_slippage_flag: highSlippageFlag,
      low_cadence_flag: lowCadenceFlag,
      computed_at: new Date().toISOString(),
    };

    const { error: upErr } = await this.supabase
      .getClient()
      .from('gainers_shadow_daily_report')
      .upsert(payload, { onConflict: 'report_date' });

    if (upErr) {
      this.logger.error(`upsert ${reportDate} failed: ${upErr.message}`);
      return null;
    }

    if (zeroSignalsFlag || highSlippageFlag || lowCadenceFlag) {
      this.logger.warn(`[shadow-daily-report] ${reportDate} ANOMALY zero=${zeroSignalsFlag} highSlip=${highSlippageFlag} lowCadence=${lowCadenceFlag}`);
    }

    return this.mapRowToDto(payload);
  }

  async getRecentReports(days: number = 30): Promise<DailyReportRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_shadow_daily_report')
      .select('*')
      .order('report_date', { ascending: false })
      .limit(days);
    if (error || !data) return [];
    return data.map((r) => this.mapRowToDto(r));
  }

  /** Anomaly check 1 : zero_signals_48h. */
  private async checkZeroSignals48h(reportDate: string, todayAccept: number): Promise<boolean> {
    if (todayAccept > 0) return false;
    const yesterday = this.dateOffset(reportDate, -1);
    const { data } = await this.supabase
      .getClient()
      .from('gainers_shadow_daily_report')
      .select('accept_count')
      .eq('report_date', yesterday)
      .maybeSingle();
    if (!data) return false; // pas de baseline hier → ne pas flag
    return Number((data as any).accept_count) === 0;
  }

  /** Anomaly check 2 : low_cadence_7d. */
  private async checkLowCadence7d(reportDate: string): Promise<boolean> {
    const sevenDaysAgo = this.dateOffset(reportDate, -7);
    const { data } = await this.supabase
      .getClient()
      .from('gainers_shadow_daily_report')
      .select('accept_count')
      .gte('report_date', sevenDaysAgo)
      .lt('report_date', reportDate);
    if (!data || data.length < 7) return false; // baseline insuffisante
    const total = data.reduce((s, r) => s + Number((r as any).accept_count), 0);
    return total / 7 < LOW_CADENCE_THRESHOLD;
  }

  private todayUtcDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private dateOffset(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private mapRowToDto(r: any): DailyReportRow {
    return {
      reportDate: r.report_date,
      totalSignals: Number(r.total_signals ?? 0),
      acceptCount: Number(r.accept_count ?? 0),
      rejectCount: Number(r.reject_count ?? 0),
      closedCount: Number(r.closed_count ?? 0),
      winCount: Number(r.win_count ?? 0),
      lossCount: Number(r.loss_count ?? 0),
      winRate: r.win_rate !== null ? Number(r.win_rate) : null,
      avgRealizedPnlPct: r.avg_realized_pnl_pct !== null ? Number(r.avg_realized_pnl_pct) : null,
      cumulativePnlPct: r.cumulative_pnl_pct !== null ? Number(r.cumulative_pnl_pct) : null,
      avgSlippagePct: r.avg_slippage_pct !== null ? Number(r.avg_slippage_pct) : null,
      anomalousFillCount: Number(r.anomalous_fill_count ?? 0),
      divergenceCount: Number(r.divergence_count ?? 0),
      divergencePct: r.divergence_pct !== null ? Number(r.divergence_pct) : null,
      triggerBreakdown: r.trigger_breakdown ?? {},
      zeroSignalsFlag: !!r.zero_signals_flag,
      highSlippageFlag: !!r.high_slippage_flag,
      lowCadenceFlag: !!r.low_cadence_flag,
    };
  }
}
