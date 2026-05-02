/**
 * /admin/gainers/v1-metrics/extended — Issue #195 extended observability.
 *
 * Trois endpoints :
 *   - GET  /signals          : per-signal détail avec slippage actual vs expected,
 *                              TP/SL/trailing progression, exit reason, MFE
 *   - GET  /sessions         : daily aggregation (1 session = 1 jour UTC) avec
 *                              accept/reject/PnL/avg slippage/anomalous_fill count
 *   - GET  /sessions.csv     : export CSV du même contenu
 *
 * Auth admin via x-admin-token. Prereq pour le shadow run dashboard live.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';

export interface SignalDetail {
  positionId: string;
  symbol: string;
  exchange: string;
  assetClass: 'equity' | 'crypto';
  triggerKind: 'PULLBACK_HL_FIBO' | 'VWAP_RECLAIM';
  entryPrice: number;
  entryAt: string;
  pathEff: number;
  tpPrice: number;
  slPrice: number;
  state: 'OPEN' | 'TRAILING_20' | 'TRAILING_50' | 'CLOSED';
  mfePrice: number;
  mfePct: number;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: string | null;
  realizedPnlPct: number | null;
  // Extended (events)
  slippagePct: number | null;
  anomalousFill: boolean;
  trailing20TriggeredAt: string | null;
  trailing50TriggeredAt: string | null;
  durationSec: number | null;
}

export interface SessionAggregate {
  date: string; // YYYY-MM-DD UTC
  totalSignals: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgRealizedPnlPct: number | null;
  avgSlippagePct: number | null;
  anomalousFillCount: number;
  triggerBreakdown: Record<string, number>;
}

@Controller('admin/gainers/v1-metrics')
export class AdminGainersExtendedController {
  private readonly logger = new Logger(AdminGainersExtendedController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get('signals')
  async getSignals(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('limit') limitStr?: string,
    @Query('since_days') sinceDaysStr?: string,
  ): Promise<{ signals: SignalDetail[] }> {
    this.assertAdmin(providedToken);
    const limit = Math.min(Math.max(Number(limitStr ?? 100) || 100, 1), 500);
    const sinceDays = Math.min(Math.max(Number(sinceDaysStr ?? 30) || 30, 1), 90);
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();

    const signals = await this.fetchSignals(since, limit);
    return { signals };
  }

  @Get('sessions')
  async getSessions(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('since_days') sinceDaysStr?: string,
  ): Promise<{ sessions: SessionAggregate[] }> {
    this.assertAdmin(providedToken);
    const sinceDays = Math.min(Math.max(Number(sinceDaysStr ?? 30) || 30, 1), 90);
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();
    const sessions = await this.aggregateSessions(since);
    return { sessions };
  }

  @Get('sessions.csv')
  async getSessionsCsv(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('since_days') sinceDaysStr: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.assertAdmin(providedToken);
    const sinceDays = Math.min(Math.max(Number(sinceDaysStr ?? 30) || 30, 1), 90);
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();
    const sessions = await this.aggregateSessions(since);

    const header = [
      'date', 'totalSignals', 'closedCount', 'winCount', 'lossCount',
      'winRate', 'avgRealizedPnlPct', 'avgSlippagePct', 'anomalousFillCount',
      'pullback_hl_fibo', 'vwap_reclaim',
    ].join(',');
    const lines = sessions.map((s) =>
      [
        s.date, s.totalSignals, s.closedCount, s.winCount, s.lossCount,
        s.winRate.toFixed(4), s.avgRealizedPnlPct?.toFixed(5) ?? '',
        s.avgSlippagePct?.toFixed(5) ?? '', s.anomalousFillCount,
        s.triggerBreakdown.PULLBACK_HL_FIBO ?? 0,
        s.triggerBreakdown.VWAP_RECLAIM ?? 0,
      ].join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gainers-sessions-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send([header, ...lines].join('\n') + '\n');
  }

  private async fetchSignals(since: string, limit: number): Promise<SignalDetail[]> {
    const { data: positions, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .select('*')
      .gte('entry_at', since)
      .order('entry_at', { ascending: false })
      .limit(limit);
    if (error || !positions) return [];

    // Fetch related events for slippage + trailing trigger timing
    const positionIds = positions.map((p: any) => p.id);
    const { data: events } = positionIds.length > 0
      ? await this.supabase
          .getClient()
          .from('gainers_position_events')
          .select('position_id, event_kind, created_at, payload')
          .in('position_id', positionIds)
      : { data: [] };

    const eventsByPosition = new Map<string, any[]>();
    for (const e of events ?? []) {
      const pid = (e as any).position_id;
      if (!eventsByPosition.has(pid)) eventsByPosition.set(pid, []);
      eventsByPosition.get(pid)!.push(e);
    }

    return positions.map((p: any): SignalDetail => {
      const evs = eventsByPosition.get(p.id) ?? [];
      const exitEvent = evs.find((e) =>
        ['TP_FULL', 'SL', 'TRAILING_20_HIT', 'TRAILING_50_HIT', 'STRUCTURE_BREAK'].includes(e.event_kind),
      );
      const t20Event = evs.find((e) => e.event_kind === 'TRAILING_20_TRIGGERED');
      const t50Event = evs.find((e) => e.event_kind === 'TRAILING_50_TRIGGERED');
      const exitPayload = (exitEvent?.payload ?? {}) as Record<string, unknown>;

      const entryAtMs = new Date(p.entry_at as string).getTime();
      const exitAtMs = p.exit_at ? new Date(p.exit_at as string).getTime() : null;
      const durationSec = exitAtMs !== null ? Math.round((exitAtMs - entryAtMs) / 1000) : null;

      return {
        positionId: p.id,
        symbol: p.symbol,
        exchange: p.exchange,
        assetClass: p.asset_class,
        triggerKind: p.trigger_kind,
        entryPrice: Number(p.entry_price),
        entryAt: p.entry_at,
        pathEff: Number(p.entry_path_eff),
        tpPrice: Number(p.tp_price),
        slPrice: Number(p.sl_price),
        state: p.state,
        mfePrice: Number(p.mfe_price),
        mfePct: Number(p.mfe_pct),
        exitPrice: p.exit_price !== null ? Number(p.exit_price) : null,
        exitAt: p.exit_at,
        exitReason: p.exit_reason,
        realizedPnlPct: p.realized_pnl_pct !== null ? Number(p.realized_pnl_pct) : null,
        slippagePct: typeof exitPayload.slippage_pct === 'number' ? exitPayload.slippage_pct : null,
        anomalousFill: exitPayload.anomalous_fill === true,
        trailing20TriggeredAt: t20Event?.created_at ?? null,
        trailing50TriggeredAt: t50Event?.created_at ?? null,
        durationSec,
      };
    });
  }

  private async aggregateSessions(since: string): Promise<SessionAggregate[]> {
    const { data: positions, error } = await this.supabase
      .getClient()
      .from('gainers_positions')
      .select('id, entry_at, trigger_kind, state, realized_pnl_pct, exit_at')
      .gte('entry_at', since);
    if (error || !positions) return [];

    // Slippage + anomalous from events
    const ids = positions.map((p: any) => p.id);
    const { data: events } = ids.length > 0
      ? await this.supabase
          .getClient()
          .from('gainers_position_events')
          .select('position_id, payload')
          .in('position_id', ids)
          .in('event_kind', ['TP_FULL', 'SL', 'TRAILING_20_HIT', 'TRAILING_50_HIT', 'STRUCTURE_BREAK'])
      : { data: [] };

    const slipByPosition = new Map<string, { slip: number | null; anom: boolean }>();
    for (const e of events ?? []) {
      const payload = ((e as any).payload as Record<string, unknown>) ?? {};
      const slip = typeof payload.slippage_pct === 'number' ? payload.slippage_pct : null;
      const anom = payload.anomalous_fill === true;
      slipByPosition.set((e as any).position_id, { slip, anom });
    }

    const buckets = new Map<string, {
      totalSignals: number;
      closedCount: number;
      pnls: number[];
      slippages: number[];
      anomalous: number;
      wins: number;
      losses: number;
      triggers: Record<string, number>;
    }>();

    for (const p of positions) {
      const row = p as any;
      const date = (row.entry_at as string).slice(0, 10);
      const b = buckets.get(date) ?? {
        totalSignals: 0, closedCount: 0, pnls: [], slippages: [],
        anomalous: 0, wins: 0, losses: 0, triggers: {},
      };
      b.totalSignals++;
      b.triggers[row.trigger_kind] = (b.triggers[row.trigger_kind] ?? 0) + 1;
      if (row.state === 'CLOSED') {
        b.closedCount++;
        if (row.realized_pnl_pct !== null) {
          const pnl = Number(row.realized_pnl_pct);
          b.pnls.push(pnl);
          if (pnl > 0) b.wins++;
          else if (pnl < 0) b.losses++;
        }
        const slip = slipByPosition.get(row.id);
        if (slip) {
          if (slip.slip !== null) b.slippages.push(slip.slip);
          if (slip.anom) b.anomalous++;
        }
      }
      buckets.set(date, b);
    }

    const avg = (arr: number[]): number | null =>
      arr.length === 0 ? null : arr.reduce((s, n) => s + n, 0) / arr.length;

    return Array.from(buckets.entries())
      .map(([date, b]): SessionAggregate => {
        const closedWithPnl = b.wins + b.losses;
        return {
          date,
          totalSignals: b.totalSignals,
          closedCount: b.closedCount,
          winCount: b.wins,
          lossCount: b.losses,
          winRate: closedWithPnl > 0 ? b.wins / closedWithPnl : 0,
          avgRealizedPnlPct: avg(b.pnls),
          avgSlippagePct: avg(b.slippages),
          anomalousFillCount: b.anomalous,
          triggerBreakdown: b.triggers,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
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
