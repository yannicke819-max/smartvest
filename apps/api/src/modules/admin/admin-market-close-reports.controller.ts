/**
 * GET /admin/market-close-reports/latest — dernier rapport (session ou daily)
 * GET /admin/market-close-reports?date=YYYY-MM-DD — tous les rapports d'un jour
 * POST /admin/market-close-reports/trigger?session=asia_close|eu_close|us_close|daily_wrap
 *      — manuel trigger (test sans attendre cron)
 *
 * Auth : x-admin-token.
 */

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Logger, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketCloseReportService } from '../lisa/services/market-close-report.service';

type SessionKind = 'asia_close' | 'eu_close' | 'us_close' | 'daily_wrap';

@Controller('admin/market-close-reports')
export class AdminMarketCloseReportsController {
  private readonly logger = new Logger(AdminMarketCloseReportsController.name);

  constructor(
    private readonly reports: MarketCloseReportService,
    private readonly config: ConfigService,
  ) {}

  @Get('latest')
  async getLatest(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.reports.getLatest();
  }

  @Get()
  async getByDate(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('date') date?: string,
  ) {
    this.assertAdmin(providedToken);
    const target = date ?? new Date().toISOString().slice(0, 10);
    return { date: target, reports: await this.reports.getByDate(target) };
  }

  @Post('trigger')
  async trigger(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('session') session?: string,
  ) {
    this.assertAdmin(providedToken);
    const valid: SessionKind[] = ['asia_close', 'eu_close', 'us_close', 'daily_wrap'];
    if (!session || !valid.includes(session as SessionKind)) {
      throw new HttpException(
        { message: `Missing or invalid session — must be one of ${valid.join('|')}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.reports.runManualTrigger(session as SessionKind);
    return { triggered: session, status: 'completed' };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled', code: 'ADMIN_DISABLED' },
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
