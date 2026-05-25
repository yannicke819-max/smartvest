/**
 * Admin endpoint pour observer les évaluations du Debate Gate.
 *
 * Permet d'agréger les évaluations sur une fenêtre temporelle (default 24h)
 * et de visualiser les ratios block/allow, top verdicts, top symboles bloqués,
 * pour calibrer les seuils du gate avant ou pendant son activation.
 *
 * Source de données : ring buffer in-memory (DebateGateMetricsStore). Restart
 * de l'app -> buffer vide. Acceptable pour calibration courte (24-48h).
 *
 * Auth : x-admin-token (cf. ADMIN_TOKEN env). 403 sinon.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebateGateMetricsStore } from '../lisa/services/debate-gate-metrics.store';

@Controller('admin/debate-gate')
export class AdminDebateGateMetricsController {
  private readonly logger = new Logger(AdminDebateGateMetricsController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly store: DebateGateMetricsStore,
  ) {}

  @Get('metrics')
  metrics(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('hours') hoursQ?: string,
  ): unknown {
    this.assertAdmin(providedToken);
    const hours = Math.max(1, Math.min(168, Number(hoursQ ?? 24)));
    const aggregated = this.store.aggregate(hours);
    const isActive = this.config.get<string>('DEBATE_GATE_ENABLED') !== 'false';
    return {
      gate_status: isActive ? 'ACTIVE (blocking)' : 'SHADOW (log only)',
      gate_enabled_env: this.config.get<string>('DEBATE_GATE_ENABLED') ?? '(unset, default ACTIVE)',
      buffer_size: this.store.size(),
      buffer_max: 5000,
      ...aggregated,
    };
  }

  @Get('recent')
  recent(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('limit') limitQ?: string,
    @Query('only_blocked') onlyBlocked?: string,
  ): unknown {
    this.assertAdmin(providedToken);
    const limit = Math.max(1, Math.min(500, Number(limitQ ?? 50)));
    const blockedOnly = onlyBlocked === 'true';
    // Pull last N from buffer via aggregate hack — for simplicity expose via aggregate window 168h
    // and filter in JS. Acceptable since buffer max 5000.
    const all = this.store.aggregate(168);
    return {
      total_in_buffer: this.store.size(),
      filter_blocked_only: blockedOnly,
      window_summary: all,
      note: 'Pour le détail row-par-row, voir les logs Fly avec pattern "[debate-gate]"',
      hint_limit: limit,
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
      throw new HttpException({ message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' }, HttpStatus.FORBIDDEN);
    }
  }
}
