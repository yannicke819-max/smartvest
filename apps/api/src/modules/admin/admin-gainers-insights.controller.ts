/**
 * /admin/gainers/insights — Phase A insights log endpoints.
 *
 * GET /admin/gainers/insights
 *   ?type=...&status=...&severity=...&source=...&since_days=30&limit=50
 *
 * GET /admin/gainers/insights/stats
 *   Aggregates par type/status/severity sur les 30 derniers jours.
 *
 * POST /admin/gainers/insights
 *   body { type, source, summary, payload, severity?, context? }
 *
 * PATCH /admin/gainers/insights/:id
 *   body { status, resolution?, resolution_pr?, resolved_by? }
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
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GainersInsightsService,
  type InsightSeverity,
  type InsightSource,
  type InsightStatus,
  type InsightType,
} from '../gainers-scanner/insights/gainers-insights.service';

@Controller('admin/gainers/insights')
export class AdminGainersInsightsController {
  constructor(
    private readonly service: GainersInsightsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(
    @Headers('x-admin-token') token: string | undefined,
    @Query('type') type?: InsightType,
    @Query('status') status?: InsightStatus,
    @Query('severity') severity?: InsightSeverity,
    @Query('source') source?: InsightSource,
    @Query('since_days') sinceDaysStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertAdmin(token);
    const sinceDays = Math.min(Math.max(Number(sinceDaysStr ?? 30) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(limitStr ?? 50) || 50, 1), 500);
    const q: Parameters<GainersInsightsService['queryInsights']>[0] = { sinceDays, limit };
    if (type) q.type = type;
    if (status) q.status = status;
    if (severity) q.severity = severity;
    if (source) q.source = source;
    const insights = await this.service.queryInsights(q);
    return { count: insights.length, insights };
  }

  @Get('stats')
  async stats(
    @Headers('x-admin-token') token: string | undefined,
    @Query('since_days') sinceDaysStr?: string,
  ) {
    this.assertAdmin(token);
    const sinceDays = Math.min(Math.max(Number(sinceDaysStr ?? 30) || 30, 1), 365);
    return this.service.getStats(sinceDays);
  }

  @Post()
  async create(
    @Headers('x-admin-token') token: string | undefined,
    @Body() body: {
      type: InsightType;
      source: InsightSource;
      summary: string;
      payload: Record<string, unknown>;
      severity?: InsightSeverity;
      context?: Record<string, unknown>;
    },
  ) {
    this.assertAdmin(token);
    if (!body || !body.type || !body.source || !body.summary || !body.payload) {
      throw new HttpException(
        { message: 'missing required fields: type, source, summary, payload', code: 'BAD_INPUT' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const logInput: Parameters<GainersInsightsService['logInsight']>[0] = {
      type: body.type,
      source: body.source,
      summary: body.summary,
      payload: body.payload,
    };
    if (body.severity) logInput.severity = body.severity;
    if (body.context) logInput.context = body.context;
    const id = await this.service.logInsight(logInput);
    if (!id) {
      throw new HttpException(
        { message: 'log failed (db error)', code: 'DB_ERROR' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { id };
  }

  @Patch(':id')
  async resolve(
    @Headers('x-admin-token') token: string | undefined,
    @Param('id') id: string,
    @Body() body: {
      status: 'investigating' | 'actioned' | 'dismissed';
      resolution?: string;
      resolution_pr?: string;
      resolved_by?: string;
    },
  ) {
    this.assertAdmin(token);
    if (!body || !body.status) {
      throw new HttpException(
        { message: 'missing field: status', code: 'BAD_INPUT' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const resolveInput: Parameters<GainersInsightsService['resolveInsight']>[1] = {
      status: body.status,
    };
    if (body.resolution) resolveInput.resolution = body.resolution;
    if (body.resolution_pr) resolveInput.resolutionPr = body.resolution_pr;
    if (body.resolved_by) resolveInput.resolvedBy = body.resolved_by;
    const ok = await this.service.resolveInsight(id, resolveInput);
    if (!ok) {
      throw new HttpException(
        { message: 'resolve failed', code: 'DB_ERROR' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { id, status: body.status };
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
