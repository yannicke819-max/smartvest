/**
 * Admin force-pull pour les caches qui dépendent de crons quotidiens.
 *
 * Contexte : les crons `eodhd-economic-events` (03:30 UTC) et
 * `symbol-atr-cache` (21:30 UTC lun-ven) ne fire qu'une fois par jour.
 * Quand on active les env vars en milieu de journée, on doit attendre le
 * prochain fire. Ces endpoints permettent de forcer la pull à la demande.
 *
 * Auth : header `x-admin-token` (constant-time compare, même pattern que
 * AdminSupabaseQueryController).
 *
 * Usage :
 *   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
 *     https://smartvest.fly.dev/admin/event-engine/pull-economic-events
 *   curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
 *     https://smartvest.fly.dev/admin/event-engine/refresh-atr
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { EodhdEconomicEventsService } from '../lisa/services/eodhd-economic-events.service';
import { SymbolAtrCacheService } from '../lisa/services/symbol-atr-cache.service';
import { SupabaseService } from '../supabase/supabase.service';
import { categorizeEvent } from '../lisa/services/event-engine.config';

@Controller('admin/event-engine')
export class AdminEventEngineForceController {
  private readonly logger = new Logger(AdminEventEngineForceController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly economicEvents: EodhdEconomicEventsService,
    private readonly atrCache: SymbolAtrCacheService,
    private readonly supabase: SupabaseService,
  ) {}

  @Post('pull-economic-events')
  async pullEconomicEvents(
    @Headers('x-admin-token') providedToken: string | undefined,
  ): Promise<{ ok: boolean; fetched: number; persisted: number }> {
    this.assertAdmin(providedToken);
    const result = await this.economicEvents.pullAndPersist();
    this.logger.log(`[admin/event-engine] force pull economic-events: ${JSON.stringify(result)}`);
    return { ok: true, ...result };
  }

  @Post('refresh-atr')
  async refreshAtr(
    @Headers('x-admin-token') providedToken: string | undefined,
  ): Promise<{ ok: boolean; processed: number; persisted: number; failed: number }> {
    this.assertAdmin(providedToken);
    const result = await this.atrCache.refreshUniverse();
    this.logger.log(`[admin/event-engine] force refresh atr-cache: ${JSON.stringify(result)}`);
    return { ok: true, ...result };
  }

  /**
   * P3 — Mesure shadow D-4 : agrégat win-rate / mean PnL / Sharpe par event
   * type × trigger direction. Le SQL de référence est dans
   * docs/design/phase-d-4-d-5-measurement.md ; ici on l'expose via API pour
   * mesure ad-hoc sans accès psql direct.
   *
   * Query string :
   *   - days : fenêtre de lookback (default 30, max 180)
   */
  @Get('shadow-summary')
  async shadowSummary(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('days') daysRaw?: string,
  ): Promise<{
    days: number;
    total_force_closed: number;
    by_event_type_direction: Array<{
      event_type: string;
      direction: string;
      n: number;
      mean_pnl_pct: number;
      std_pnl_pct: number;
      win_rate_pct: number;
      sum_pnl_pct: number;
      worst_pnl_pct: number;
      best_pnl_pct: number;
    }>;
    go_no_go_assessment: {
      decision: 'GO' | 'NO_GO' | 'INTERMEDIATE';
      reason: string;
    };
  }> {
    this.assertAdmin(providedToken);
    const days = Math.max(1, Math.min(180, parseInt(daysRaw ?? '30', 10) || 30));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    if (!this.supabase.isReady()) {
      throw new HttpException({ message: 'Supabase not ready' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('event_engine_trades')
      .select('event_name, trigger_direction, realized_pnl_pct, exit_taken_at')
      .eq('status', 'force_closed')
      .gte('exit_taken_at', cutoff)
      .limit(5000);
    if (error) {
      throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const rows = (data ?? []) as Array<{
      event_name: string;
      trigger_direction: string | null;
      realized_pnl_pct: number | null;
    }>;
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const cat = categorizeEvent(r.event_name);
      const eventType = cat?.type ?? 'uncategorized';
      const dir = r.trigger_direction ?? 'none';
      const key = `${eventType}|${dir}`;
      const arr = groups.get(key) ?? [];
      if (typeof r.realized_pnl_pct === 'number') arr.push(r.realized_pnl_pct);
      groups.set(key, arr);
    }

    const byGroup = Array.from(groups.entries()).map(([key, pnls]) => {
      const [event_type, direction] = key.split('|');
      const n = pnls.length;
      const sum = pnls.reduce((s, x) => s + x, 0);
      const mean = n > 0 ? sum / n : 0;
      const variance = n > 1 ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
      const std = Math.sqrt(variance);
      const wins = pnls.filter((p) => p > 0).length;
      return {
        event_type,
        direction,
        n,
        mean_pnl_pct: Math.round(mean * 1000) / 1000,
        std_pnl_pct: Math.round(std * 1000) / 1000,
        win_rate_pct: n > 0 ? Math.round((wins / n) * 1000) / 10 : 0,
        sum_pnl_pct: Math.round(sum * 100) / 100,
        worst_pnl_pct: n > 0 ? Math.min(...pnls) : 0,
        best_pnl_pct: n > 0 ? Math.max(...pnls) : 0,
      };
    }).sort((a, b) => b.n - a.n);

    // GO/NO-GO seuils (cf. docs/design/phase-d-4-d-5-measurement.md)
    const total = rows.filter((r) => typeof r.realized_pnl_pct === 'number').length;
    const allPnls = rows.map((r) => r.realized_pnl_pct).filter((p): p is number => typeof p === 'number');
    const totalMean = allPnls.length > 0 ? allPnls.reduce((s, x) => s + x, 0) / allPnls.length : 0;
    const totalStd = allPnls.length > 1
      ? Math.sqrt(allPnls.reduce((s, x) => s + (x - totalMean) ** 2, 0) / (allPnls.length - 1))
      : 0;
    const totalWinRate = allPnls.length > 0
      ? (allPnls.filter((p) => p > 0).length / allPnls.length) * 100
      : 0;
    const sharpe = totalStd > 0 ? totalMean / totalStd : 0;
    const worst = allPnls.length > 0 ? Math.min(...allPnls) : 0;

    let decision: 'GO' | 'NO_GO' | 'INTERMEDIATE';
    let reason: string;
    if (total < 30) {
      decision = 'INTERMEDIATE';
      reason = `n=${total} < 30 — sample trop petit, prolonger observation`;
    } else if (totalMean <= -0.05 || sharpe <= 0 || totalWinRate < 45 || worst <= -3.0) {
      decision = 'NO_GO';
      reason = `mean=${totalMean.toFixed(3)}% sharpe=${sharpe.toFixed(2)} winRate=${totalWinRate.toFixed(1)}% worst=${worst.toFixed(2)}%`;
    } else if (total >= 50 && totalMean >= 0.10 && sharpe >= 0.3 && totalWinRate >= 50 && worst > -2.0) {
      decision = 'GO';
      reason = `n=${total} mean=${totalMean.toFixed(3)}% sharpe=${sharpe.toFixed(2)} winRate=${totalWinRate.toFixed(1)}%`;
    } else {
      decision = 'INTERMEDIATE';
      reason = `n=${total} mean=${totalMean.toFixed(3)}% sharpe=${sharpe.toFixed(2)} — entre GO et NO-GO, prolonger`;
    }

    return {
      days,
      total_force_closed: total,
      by_event_type_direction: byGroup,
      go_no_go_assessment: { decision, reason },
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
    if (!providedToken) {
      throw new HttpException(
        { message: 'x-admin-token header required', code: 'NO_TOKEN' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(providedToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'BAD_TOKEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
