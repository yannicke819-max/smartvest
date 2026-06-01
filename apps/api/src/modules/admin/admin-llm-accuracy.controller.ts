/**
 * Endpoint admin pour mesurer "qui a raison ?" sur les shadows LLM.
 *
 * Phase 1 : risk_monitor (PR #535). Compare le verdict_score de chaque LLM
 * (Pro / Flash / Mistral Medium / Large) à l'outcome réel de la position
 * (PnL %). Le LLM avec le Brier score le plus bas = le plus précis.
 *
 * Endpoint :
 *   GET /admin/llm-accuracy?call_site=risk_monitor&days=14
 *
 * Auth : header x-admin-token.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmAccuracyService } from '../lisa/services/llm-accuracy.service';

@Controller('admin')
export class AdminLlmAccuracyController {
  private readonly logger = new Logger(AdminLlmAccuracyController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly accuracy: LlmAccuracyService,
  ) {}

  @Get('llm-accuracy')
  async getAccuracy(
    @Headers('x-admin-token') token: string | undefined,
    @Query('call_site') callSite?: string,
    @Query('days') daysRaw?: string,
  ): Promise<unknown> {
    const adminToken = this.config.get<string>('ADMIN_TOKEN');
    if (adminToken && token !== adminToken) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const site = callSite ?? 'risk_monitor';
    const days = Math.max(1, Math.min(90, parseInt(daysRaw ?? '14', 10) || 14));

    try {
      const result = await this.accuracy.computeAccuracy(site, days);
      return result;
    } catch (e) {
      this.logger.error(`[llm-accuracy] compute failed: ${String(e).slice(0, 200)}`);
      throw new HttpException(`Compute failed: ${String(e).slice(0, 200)}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * PR #536 — Endpoint TRADER : ranking 4 providers sur gemini_ab_decisions.
   * Compute agreement avec Pro applied + win rate sur trades fermés.
   *
   * GET /admin/llm-trader-accuracy?days=14
   */
  @Get('llm-trader-accuracy')
  async getTraderAccuracy(
    @Headers('x-admin-token') token: string | undefined,
    @Query('days') daysRaw?: string,
  ): Promise<unknown> {
    const adminToken = this.config.get<string>('ADMIN_TOKEN');
    if (adminToken && token !== adminToken) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const days = Math.max(1, Math.min(90, parseInt(daysRaw ?? '14', 10) || 14));
    try {
      return await this.accuracy.computeTraderAccuracy(days);
    } catch (e) {
      this.logger.error(`[llm-trader-accuracy] compute failed: ${String(e).slice(0, 200)}`);
      throw new HttpException(`Compute failed: ${String(e).slice(0, 200)}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
