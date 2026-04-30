/**
 * P19x.5 (29/04/2026) — Admin endpoint pour query Supabase ad-hoc (read-only).
 *
 * Use case primaire : audit 1m coverage table pour vérifier que les fetchs
 * EODHD intraday 1m post-P19r/P19v marchent réellement sur les tickers
 * asia/NSE/AU. User ne peut pas query Supabase depuis dev env (pas de
 * service_role key) — cet endpoint expose un set de queries pré-définies
 * avec auth admin.
 *
 * Pourquoi pré-défini (pas freeform SQL) :
 *   - Sécurité : freeform SQL via endpoint = SQL injection risk même avec
 *     auth, et expose l'entièreté de la DB
 *   - Limite la surface d'attaque à des queries bornées + auditables
 *   - User peut demander d'ajouter d'autres queries en patch
 *
 * Auth : header `x-admin-token` matchant ADMIN_TOKEN env var (constant-time
 * compare). Sinon 401/403.
 *
 * Usage :
 *   curl -H "x-admin-token: $ADMIN_TOKEN" \
 *     "https://smartvest.fly.dev/admin/supabase-query/intraday-coverage-1m"
 *
 *   curl -H "x-admin-token: $ADMIN_TOKEN" \
 *     "https://smartvest.fly.dev/admin/supabase-query/intraday-coverage-1m?since_minutes=120"
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Whitelist de queries accessibles via cet endpoint. Chaque query est :
 *  - read-only (SELECT uniquement, pas d'INSERT/UPDATE/DELETE)
 *  - bornée par paramètres typés (pas de string interpolation user-supplied)
 *  - documentée par sa raison d'existence
 */
type QueryName =
  | 'intraday-coverage-1m'
  | 'intraday-coverage-by-source'
  | 'recent-positions-pnl'
  | 'recent-decisions';

@Controller('admin/supabase-query')
export class AdminSupabaseQueryController {
  private readonly logger = new Logger(AdminSupabaseQueryController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get(':queryName')
  async runQuery(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Param('queryName') queryName: string,
    @Query('since_minutes') sinceMinutesRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<{ query: QueryName; rows: unknown[]; count: number; params: Record<string, unknown> }> {
    this.assertAdmin(providedToken);

    const sinceMinutes = this.clampInt(sinceMinutesRaw, 1, 10080, 120); // default 2h, max 7d
    const limit = this.clampInt(limitRaw, 1, 1000, 100);
    const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

    const client = this.supabase.getClient();
    let rows: unknown[] = [];

    switch (queryName) {
      case 'intraday-coverage-1m': {
        // P19r/P19v audit : compte tickers asia/NSE/AU avec data 1m fetched
        // dans les 2h. Confirme que le widening 48h capture les last sessions.
        const { data, error } = await client
          .from('lisa_intraday_cache')
          .select('symbol, source, fetched_at')
          .or('symbol.like.%.KO,symbol.like.%.KQ,symbol.like.%.AU,symbol.like.%.NSE,symbol.like.%.BSE,symbol.like.%.T,symbol.like.%.HK,symbol.like.%.KS,symbol.like.%.AX,symbol.like.%.NS,symbol.like.%.BO')
          .gte('fetched_at', since)
          .order('fetched_at', { ascending: false })
          .limit(limit);
        if (error) throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
        rows = data ?? [];
        break;
      }
      case 'intraday-coverage-by-source': {
        // Stats agrégées par source : count des tickers en cache par source,
        // dans la fenêtre.
        const { data, error } = await client
          .from('lisa_intraday_cache')
          .select('source')
          .gte('fetched_at', since);
        if (error) throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
        const bySource = new Map<string, number>();
        for (const row of data ?? []) {
          const src = String((row as { source?: string }).source ?? 'unknown');
          bySource.set(src, (bySource.get(src) ?? 0) + 1);
        }
        rows = Array.from(bySource.entries()).map(([source, count]) => ({ source, count }));
        break;
      }
      case 'recent-positions-pnl': {
        // PnL des positions fermées récemment, tri desc exit_timestamp.
        // Permet validation P19u/P19x/P19x.1 fees + MIN_NET_PROFIT guard.
        const { data, error } = await client
          .from('lisa_positions')
          .select('symbol, status, entry_price, exit_price, quantity, entry_notional_usd, realized_pnl_usd, realized_pnl_pct, estimated_entry_cost_usd, exit_timestamp')
          .neq('status', 'open')
          .gte('exit_timestamp', since)
          .order('exit_timestamp', { ascending: false })
          .limit(limit);
        if (error) throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
        rows = data ?? [];
        break;
      }
      case 'recent-decisions': {
        // Derniers decision_log entries (mécanique, autopilot, watchdog).
        // Permet d'observer les guards P19x.1, P19x.4 watchdog, etc.
        const { data, error } = await client
          .from('lisa_decision_log')
          .select('kind, summary, created_at, portfolio_id, payload')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error) throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
        rows = data ?? [];
        break;
      }
      default:
        throw new HttpException(
          {
            message: `Unknown query name`,
            available: ['intraday-coverage-1m', 'intraday-coverage-by-source', 'recent-positions-pnl', 'recent-decisions'],
          },
          HttpStatus.BAD_REQUEST,
        );
    }

    this.logger.log(
      `[admin/supabase-query] query=${queryName} since_minutes=${sinceMinutes} limit=${limit} rows=${rows.length}`,
    );
    return {
      query: queryName as QueryName,
      rows,
      count: rows.length,
      params: { since_minutes: sinceMinutes, limit, since },
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

  private clampInt(raw: string | undefined, min: number, max: number, def: number): number {
    if (!raw) return def;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }
}
