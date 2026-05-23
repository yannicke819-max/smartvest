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

import { Controller, Headers, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { EodhdEconomicEventsService } from '../lisa/services/eodhd-economic-events.service';
import { SymbolAtrCacheService } from '../lisa/services/symbol-atr-cache.service';

@Controller('admin/event-engine')
export class AdminEventEngineForceController {
  private readonly logger = new Logger(AdminEventEngineForceController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly economicEvents: EodhdEconomicEventsService,
    private readonly atrCache: SymbolAtrCacheService,
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
