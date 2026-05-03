/**
 * /admin/gainers/rejected-insights — PR6.8 RCFT endpoints.
 *
 * GET /admin/gainers/rejected-insights
 *   ?env=shadow|canary|prod  (default 'shadow')
 *   ?since_days=14            (1..90, default 14)
 *   ?min_samples=20           (1..1000, default 20 — anti FP-rate sur 3 datapoints)
 *
 * Returns FP-rate breakdown par reject_reason + ACCEPT failure-rate symétrique.
 * Cloisonnement env_tag obligatoire (anti mélange shadow/canary/prod).
 *
 * Auth via x-admin-token.
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
import { RejectedInsightsService } from '../gainers-scanner/automations/rejected-insights.service';

@Controller('admin/gainers/rejected-insights')
export class AdminRejectedInsightsController {
  constructor(
    private readonly service: RejectedInsightsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(
    @Headers('x-admin-token') token: string | undefined,
    @Query('env') envParam?: string,
    @Query('since_days') sinceDaysStr?: string,
    @Query('min_samples') minSamplesStr?: string,
  ) {
    this.assertAdmin(token);

    const env = envParam?.toLowerCase();
    if (env && !['shadow', 'canary', 'prod'].includes(env)) {
      throw new HttpException(
        { message: `invalid env (must be shadow|canary|prod), got: ${envParam}`, code: 'BAD_INPUT' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const q: Parameters<RejectedInsightsService['getFalsePositiveRate']>[0] = {};
    if (env) q.envTag = env as 'shadow' | 'canary' | 'prod';
    if (sinceDaysStr) q.sinceDays = Number(sinceDaysStr) || 14;
    if (minSamplesStr) q.minSamples = Number(minSamplesStr) || 20;

    return this.service.getFalsePositiveRate(q);
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
