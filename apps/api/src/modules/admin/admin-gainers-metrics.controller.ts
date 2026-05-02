/**
 * GET /admin/gainers/v1-metrics — Step 10 dashboard observability (ADR-005).
 *
 * Source de données :
 *   - gainers_persistence_log    (snapshots historiques scanner)
 *   - gainers_positions          (positions ouvertes/fermées BLOC 4)
 *   - gainers_position_events    (transitions state machine + slippage)
 *   - gainers_volume_baselines   (couverture ETL)
 *
 * Endpoint admin, auth via x-admin-token.
 *
 * Réponse :
 * {
 *   asOf: ISO,
 *   timeBuckets: { last_24h: {...}, last_7d: {...}, last_30d: {...} },
 *   rejectBreakdown: [{reason, count, pct}],
 *   topRejects: [{symbol, reason, count}],
 *   compositeScoreHistogram: [{bucket, count}],
 *   signalCadence: [{date, accept, reject}],
 *   recentCandidates: [{ts, symbol, score, decision, trigger, rejectReason}],
 *   shadowMetrics: {total_signals, accept_rate, win_rate, profit_factor, sharpe, max_dd},
 *   etlHealth: {baselineCount, baselineFreshness, snapshotCount}
 * }
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

export interface BucketMetrics {
  totalScanned: number;
  accepted: number;
  rejected: number;
  acceptRatePct: number;
}

export interface RejectBreakdownEntry {
  reason: string;
  count: number;
  pct: number;
}

export interface SignalCadenceEntry {
  date: string;
  accept: number;
  reject: number;
}

export interface RecentCandidateEntry {
  ts: string;
  symbol: string;
  market: string;
  score: number | null;
  decision: 'ACCEPT' | 'REJECT';
  trigger: string | null;
  rejectReason: string | null;
}

export interface MetricsResponse {
  asOf: string;
  timeBuckets: {
    last_24h: BucketMetrics;
    last_7d: BucketMetrics;
    last_30d: BucketMetrics;
  };
  rejectBreakdown: RejectBreakdownEntry[];
  topRejects: Array<{ symbol: string; reason: string; count: number }>;
  compositeScoreHistogram: Array<{ bucket: string; count: number }>;
  signalCadence: SignalCadenceEntry[];
  recentCandidates: RecentCandidateEntry[];
  positionsHealth: {
    open: number;
    closedTpFull: number;
    closedSl: number;
    closedTrailing20Hit: number;
    closedTrailing50Hit: number;
    closedStructureBreak: number;
    avgRealizedPnlPct: number | null;
    avgSlippagePct: number | null;
    anomalousFillCount: number;
  };
  etlHealth: {
    baselineCount: number;
    baselineFreshnessHours: number | null;
    legacySnapshotCount: number;
  };
}

@Controller('admin/gainers/v1-metrics')
export class AdminGainersMetricsController {
  private readonly logger = new Logger(AdminGainersMetricsController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getMetrics(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('window_days') windowDaysStr?: string,
  ): Promise<MetricsResponse> {
    this.assertAdmin(providedToken);
    const windowDays = Math.min(Math.max(Number(windowDaysStr ?? 30) || 30, 1), 90);

    const now = new Date();
    const cutoffs = {
      h24: new Date(now.getTime() - 24 * 3600_000).toISOString(),
      d7: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString(),
      d30: new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString(),
    };

    const [buckets, rejectBreakdown, topRejects, scoreHist, cadence, recent, positions, etl] =
      await Promise.all([
        this.fetchTimeBuckets(cutoffs),
        this.fetchRejectBreakdown(cutoffs.d30),
        this.fetchTopRejects(cutoffs.d30),
        this.fetchScoreHistogram(cutoffs.d30),
        this.fetchSignalCadence(cutoffs.d30, windowDays),
        this.fetchRecentCandidates(),
        this.fetchPositionsHealth(cutoffs.d30),
        this.fetchEtlHealth(),
      ]);

    return {
      asOf: now.toISOString(),
      timeBuckets: buckets,
      rejectBreakdown,
      topRejects,
      compositeScoreHistogram: scoreHist,
      signalCadence: cadence,
      recentCandidates: recent,
      positionsHealth: positions,
      etlHealth: etl,
    };
  }

  private async fetchTimeBuckets(
    cutoffs: { h24: string; d7: string; d30: string },
  ): Promise<MetricsResponse['timeBuckets']> {
    const [h24, d7, d30] = await Promise.all([
      this.bucketFor(cutoffs.h24),
      this.bucketFor(cutoffs.d7),
      this.bucketFor(cutoffs.d30),
    ]);
    return { last_24h: h24, last_7d: d7, last_30d: d30 };
  }

  private async bucketFor(since: string): Promise<BucketMetrics> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('decision', { count: 'exact' })
      .gte('captured_at', since);
    if (error || !data) {
      return { totalScanned: 0, accepted: 0, rejected: 0, acceptRatePct: 0 };
    }
    const accepted = data.filter((r: any) => r.decision === 'opened' || r.decision === 'passed').length;
    const total = data.length;
    const rejected = total - accepted;
    return {
      totalScanned: total,
      accepted,
      rejected,
      acceptRatePct: total > 0 ? Math.round((accepted * 1000) / total) / 10 : 0,
    };
  }

  private async fetchRejectBreakdown(since: string): Promise<RejectBreakdownEntry[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('decision, filter_reason')
      .gte('captured_at', since)
      .neq('decision', 'opened');
    if (error || !data) return [];

    const counts = new Map<string, number>();
    for (const row of data) {
      const reason = (row as any).filter_reason ?? 'unknown';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const total = data.length;
    return Array.from(counts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        pct: total > 0 ? Math.round((count * 1000) / total) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private async fetchTopRejects(
    since: string,
  ): Promise<Array<{ symbol: string; reason: string; count: number }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('symbol, filter_reason')
      .gte('captured_at', since)
      .neq('decision', 'opened')
      .limit(2000);
    if (error || !data) return [];

    const map = new Map<string, number>();
    for (const r of data) {
      const k = `${(r as any).symbol}::${(r as any).filter_reason ?? 'unknown'}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([key, count]) => {
        const [symbol, reason] = key.split('::');
        return { symbol, reason, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private async fetchScoreHistogram(
    since: string,
  ): Promise<Array<{ bucket: string; count: number }>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('persistence_score')
      .gte('captured_at', since)
      .not('persistence_score', 'is', null)
      .limit(5000);
    if (error || !data) return [];

    const buckets = ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'];
    const counts = new Array(5).fill(0) as number[];
    for (const r of data) {
      const score = Number((r as any).persistence_score);
      if (Number.isNaN(score)) continue;
      const idx = Math.min(Math.floor(score * 5), 4);
      counts[idx]++;
    }
    return buckets.map((bucket, i) => ({ bucket, count: counts[i] }));
  }

  private async fetchSignalCadence(
    since: string,
    windowDays: number,
  ): Promise<SignalCadenceEntry[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('captured_at, decision')
      .gte('captured_at', since)
      .order('captured_at', { ascending: true });
    if (error || !data) return [];

    const buckets = new Map<string, { accept: number; reject: number }>();
    for (const r of data) {
      const date = ((r as any).captured_at as string).slice(0, 10);
      const entry = buckets.get(date) ?? { accept: 0, reject: 0 };
      const decision = (r as any).decision;
      if (decision === 'opened' || decision === 'passed') entry.accept++;
      else entry.reject++;
      buckets.set(date, entry);
    }
    return Array.from(buckets.entries())
      .map(([date, e]) => ({ date, accept: e.accept, reject: e.reject }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-windowDays);
  }

  private async fetchRecentCandidates(): Promise<RecentCandidateEntry[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('top_gainers_log')
      .select('captured_at, symbol, market, persistence_score, decision, trigger_kind, filter_reason')
      .order('captured_at', { ascending: false })
      .limit(50);
    if (error || !data) return [];
    return data.map((r: any) => ({
      ts: r.captured_at,
      symbol: r.symbol,
      market: r.market,
      score: r.persistence_score !== null ? Number(r.persistence_score) : null,
      decision: r.decision === 'opened' || r.decision === 'passed' ? 'ACCEPT' : 'REJECT',
      trigger: r.trigger_kind ?? null,
      rejectReason: r.filter_reason ?? null,
    }));
  }

  private async fetchPositionsHealth(since: string): Promise<MetricsResponse['positionsHealth']> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .select('state, exit_reason, realized_pnl_pct')
      .gte('entry_at', since);
    if (error || !data) {
      return {
        open: 0, closedTpFull: 0, closedSl: 0,
        closedTrailing20Hit: 0, closedTrailing50Hit: 0, closedStructureBreak: 0,
        avgRealizedPnlPct: null, avgSlippagePct: null, anomalousFillCount: 0,
      };
    }

    const exitCounts = { TP_FULL: 0, SL: 0, TRAILING_20_HIT: 0, TRAILING_50_HIT: 0, STRUCTURE_BREAK: 0 };
    const pnls: number[] = [];
    let openCount = 0;
    for (const r of data) {
      const row = r as any;
      if (row.state !== 'CLOSED') openCount++;
      else {
        const er = row.exit_reason as keyof typeof exitCounts | null;
        if (er && er in exitCounts) exitCounts[er]++;
        if (row.realized_pnl_pct !== null) pnls.push(Number(row.realized_pnl_pct));
      }
    }

    // Slippage stats from events
    const { data: events } = await this.supabase
      .getClient()
      .from('gainers_position_events')
      .select('payload')
      .gte('created_at', since)
      .in('event_kind', ['TP_FULL', 'SL', 'TRAILING_20_HIT', 'TRAILING_50_HIT']);

    const slippages: number[] = [];
    let anomalousFillCount = 0;
    for (const ev of events ?? []) {
      const payload = ((ev as any).payload as Record<string, unknown>) ?? {};
      const slip = payload.slippage_pct as number | null | undefined;
      if (typeof slip === 'number') slippages.push(slip);
      if (payload.anomalous_fill === true) anomalousFillCount++;
    }

    const avg = (arr: number[]) =>
      arr.length === 0 ? null : Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100000) / 100000;

    return {
      open: openCount,
      closedTpFull: exitCounts.TP_FULL,
      closedSl: exitCounts.SL,
      closedTrailing20Hit: exitCounts.TRAILING_20_HIT,
      closedTrailing50Hit: exitCounts.TRAILING_50_HIT,
      closedStructureBreak: exitCounts.STRUCTURE_BREAK,
      avgRealizedPnlPct: avg(pnls),
      avgSlippagePct: avg(slippages),
      anomalousFillCount,
    };
  }

  private async fetchEtlHealth(): Promise<MetricsResponse['etlHealth']> {
    const [{ count: baselineCount }, { count: snapshotCount }, { data: latestBaseline }] =
      await Promise.all([
        this.supabase.getClient().from('gainers_volume_baselines').select('*', { count: 'exact', head: true }),
        this.supabase.getClient().from('gainers_legacy_snapshot').select('*', { count: 'exact', head: true }),
        this.supabase
          .getClient()
          .from('gainers_volume_baselines')
          .select('updated_at')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const freshness = latestBaseline?.updated_at
      ? (Date.now() - new Date(latestBaseline.updated_at as string).getTime()) / 3_600_000
      : null;

    return {
      baselineCount: baselineCount ?? 0,
      baselineFreshnessHours: freshness !== null ? Math.round(freshness * 10) / 10 : null,
      legacySnapshotCount: snapshotCount ?? 0,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
