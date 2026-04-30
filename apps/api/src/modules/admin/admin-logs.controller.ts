/**
 * P19x.6 (29/04/2026) — Admin endpoint pour grep logs en mémoire.
 *
 * Use case : user veut filtrer les logs Fly récents (e.g. `[provider-router]
 * eodhd 1m OK`, `[MÉCANIQUE] Skip closed_target`) sans flyctl auth local.
 *
 * Auth : header `x-admin-token` matchant ADMIN_TOKEN (constant-time compare).
 *
 * Usage :
 *   curl -H "x-admin-token: $TOKEN" \
 *     "https://smartvest.fly.dev/admin/logs/recent?pattern=provider-router&limit=100"
 *   curl -H "x-admin-token: $TOKEN" \
 *     "https://smartvest.fly.dev/admin/logs/recent?level=warn&pattern=closed_target"
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { logBuffer, type LogEntry } from './log-buffer.service';

@Controller('admin/logs')
export class AdminLogsController {
  constructor(private readonly config: ConfigService) {}

  @Get('recent')
  recent(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('limit') limitRaw?: string,
    @Query('pattern') pattern?: string,
    @Query('level') level?: string,
  ): { entries: LogEntry[]; buffer_size: number; filtered_count: number; pattern?: string; level?: string } {
    this.assertAdmin(providedToken);

    const limit = this.clampInt(limitRaw, 1, 5000, 200);
    const validLevels = new Set(['log', 'warn', 'error', 'debug', 'verbose']);
    const levelOpt = level && validLevels.has(level) ? (level as 'log' | 'warn' | 'error' | 'debug' | 'verbose') : undefined;

    const opts: { limit: number; pattern?: string; level?: 'log' | 'warn' | 'error' | 'debug' | 'verbose' } = { limit };
    if (pattern) opts.pattern = pattern;
    if (levelOpt) opts.level = levelOpt;

    const entries = logBuffer.recent(opts);

    const result: { entries: LogEntry[]; buffer_size: number; filtered_count: number; pattern?: string; level?: string } = {
      entries,
      buffer_size: logBuffer.size(),
      filtered_count: entries.length,
    };
    if (pattern) result.pattern = pattern;
    if (levelOpt) result.level = levelOpt;
    return result;
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
