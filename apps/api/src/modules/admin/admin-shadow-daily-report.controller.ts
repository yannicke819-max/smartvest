/**
 * /admin/gainers/shadow-daily-report — Phase 3.2 PR6.2.
 *
 * GET /admin/gainers/shadow-daily-report
 *   ?days=30  → derniers N jours (max 90, default 30)
 *
 * POST /admin/gainers/shadow-daily-report/recompute
 *   body { date?: 'YYYY-MM-DD' }  → backfill ou recompute manuel d'une date
 *
 * Auth via x-admin-token.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShadowDailyReportService } from '../gainers-scanner/shadow/shadow-daily-report.service';

@Controller('admin/gainers/shadow-daily-report')
export class AdminShadowDailyReportController {
  constructor(
    private readonly service: ShadowDailyReportService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(
    @Headers('x-admin-token') token: string | undefined,
    @Query('days') daysStr?: string,
  ) {
    this.assertAdmin(token);
    const days = Math.min(Math.max(Number(daysStr ?? 30) || 30, 1), 90);
    const reports = await this.service.getRecentReports(days);

    // Aggregate sur la fenêtre pour quick view
    const totalAccept = reports.reduce((s, r) => s + r.acceptCount, 0);
    const totalClosed = reports.reduce((s, r) => s + r.closedCount, 0);
    const totalWins = reports.reduce((s, r) => s + r.winCount, 0);
    const anomaliesCount = reports.filter(
      (r) => r.zeroSignalsFlag || r.highSlippageFlag || r.lowCadenceFlag,
    ).length;

    return {
      windowDays: days,
      reportCount: reports.length,
      summary: {
        totalAccept,
        totalClosed,
        winRate: totalClosed > 0 ? totalWins / totalClosed : null,
        avgCadenceAcceptPerDay: reports.length > 0 ? totalAccept / reports.length : 0,
        anomaliesCount,
      },
      reports,
    };
  }

  @Post('recompute')
  async recompute(
    @Headers('x-admin-token') token: string | undefined,
    @Body() body?: { date?: string },
  ) {
    this.assertAdmin(token);
    const date = body?.date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpException(
        { message: 'invalid date format, expected YYYY-MM-DD', code: 'BAD_DATE' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.service.computeAndUpsert(date);
    return { recomputed: date, result };
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
