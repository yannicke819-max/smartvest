/**
 * GET /admin/shadow-sizing/status — observability shadow sizing portfolios.
 *
 * Retourne pour chaque profile (high/middle/small) :
 *   - dernier snapshot (PnL réalisé + unrealized + fees + drawdown)
 *   - 5 dernières décisions auto-tuner (kill-switch, sizing suggestions, fees alerts)
 *
 * Auth : header `x-admin-token` aligné sur pattern AdminEodhdStatus.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShadowSizingOrchestratorService } from '../lisa/services/shadow-sizing-orchestrator.service';

@Controller('admin/shadow-sizing')
export class AdminShadowSizingController {
  private readonly logger = new Logger(AdminShadowSizingController.name);

  constructor(
    private readonly orchestrator: ShadowSizingOrchestratorService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.orchestrator.getLatestStatus();
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
