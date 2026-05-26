/**
 * GET /admin/trader-agent/status — observability LiveTraderAgentService.
 *
 * Retourne :
 *   - état (open positions, capital available, daily PnL, kill switch)
 *   - 10 dernières décisions Gemini Pro (action, symbole, confidence, thesis, applied?)
 *   - 20 lessons actives en memory (post-mortem)
 *
 * Auth : header x-admin-token aligné sur AdminEodhdStatus.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveTraderAgentService } from '../lisa/services/live-trader-agent.service';

@Controller('admin/trader-agent')
export class AdminTraderAgentController {
  private readonly logger = new Logger(AdminTraderAgentController.name);

  constructor(
    private readonly agent: LiveTraderAgentService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.agent.getLatestStatus();
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
