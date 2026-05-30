/**
 * Endpoints admin pour MainScannerPostMortemService.
 *
 * GET  /admin/scanner-postmortem/status         — lessons actives + flag enabled
 * POST /admin/scanner-postmortem/run            — déclenche un post-mortem ad-hoc (utile pour tester sans attendre 02:30 UTC)
 *   body: { windowHours?: number, default 24 }
 *
 * Auth : header x-admin-token aligné sur AdminTraderAgentController.
 */

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MainScannerPostMortemService } from '../lisa/services/main-scanner-postmortem.service';

@Controller('admin/scanner-postmortem')
export class AdminScannerPostMortemController {
  private readonly logger = new Logger(AdminScannerPostMortemController.name);

  constructor(
    private readonly postMortem: MainScannerPostMortemService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.postMortem.getStatus();
  }

  @Post('run')
  async run(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Body() body: { windowHours?: number } | undefined,
  ) {
    this.assertAdmin(providedToken);
    const windowHours = body?.windowHours && body.windowHours > 0 ? Math.min(168, body.windowHours) : 24;
    this.logger.log(`[admin/scanner-postmortem] manual run, window=${windowHours}h`);
    return this.postMortem.runPostMortem(windowHours);
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
