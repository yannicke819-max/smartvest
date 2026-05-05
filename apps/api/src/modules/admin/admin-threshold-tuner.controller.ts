/**
 * /admin/gainers/auto-tuner — PR #5 AutoTuner Phase C endpoints.
 *
 * GET  /admin/gainers/auto-tuner/history?portfolioId=X&limit=50
 *   → liste des ajustements appliqués (audit append-only)
 * POST /admin/gainers/auto-tuner/rollback
 *   body { portfolioId, thresholdName, reason? }
 *   → rollback manuel à la valeur old_value du dernier ajustement
 * POST /admin/gainers/auto-tuner/run-now
 *   → déclenche manuellement le cycle (debug / fast iteration)
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
import { SupabaseService } from '../supabase/supabase.service';
import { ThresholdAutoTunerService } from '../gainers-scanner/automations/threshold-auto-tuner.service';

@Controller('admin/gainers/auto-tuner')
export class AdminThresholdTunerController {
  constructor(
    private readonly tuner: ThresholdAutoTunerService,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get('history')
  async history(
    @Headers('x-admin-token') token: string | undefined,
    @Query('portfolioId') portfolioId?: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertAdmin(token);
    const limit = Math.min(Math.max(Number(limitStr) || 50, 1), 500);
    let query = this.supabase
      .getClient()
      .from('gainers_threshold_history')
      .select('*')
      .order('applied_at', { ascending: false })
      .limit(limit);
    if (portfolioId) query = query.eq('portfolio_id', portfolioId);
    const { data, error } = await query;
    if (error) {
      throw new HttpException(
        { message: error.message, code: 'DB_ERROR' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { rows: data ?? [], kill_switch_active: this.tuner.isKillSwitchActive() };
  }

  @Post('rollback')
  async rollback(
    @Headers('x-admin-token') token: string | undefined,
    @Body() body: { portfolioId?: string; thresholdName?: string; reason?: string },
  ) {
    this.assertAdmin(token);
    const { portfolioId, thresholdName, reason } = body;
    if (!portfolioId || !thresholdName) {
      throw new HttpException(
        { message: 'portfolioId + thresholdName required', code: 'BAD_INPUT' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Trouve le dernier ajustement appliqué (qui a déjà appliqué = env != shadow)
    const { data: rows, error } = await this.supabase
      .getClient()
      .from('gainers_threshold_history')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('threshold_name', thresholdName)
      .neq('applied_to_env', 'shadow')
      .order('applied_at', { ascending: false })
      .limit(1);
    if (error || !rows || rows.length === 0) {
      throw new HttpException(
        { message: 'No applied adjustment found to rollback', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    const last = rows[0];
    const restoredValue = Number(last.old_value);

    // Update config + write rollback history row
    const { error: updErr } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update({ [thresholdName]: restoredValue })
      .eq('portfolio_id', portfolioId);
    if (updErr) {
      throw new HttpException(
        { message: updErr.message, code: 'DB_ERROR' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    await this.supabase.getClient().from('gainers_threshold_history').insert({
      portfolio_id: portfolioId,
      threshold_name: thresholdName,
      old_value: String(last.new_value),
      new_value: String(restoredValue),
      reason: 'rollback',
      sample_size: 0,
      applied_to_env: String(last.applied_to_env),
      auto_or_manual: 'manual',
    });

    return {
      restored_value: restoredValue,
      from_value: Number(last.new_value),
      original_reason: reason ?? null,
      original_history_id: String(last.id),
    };
  }

  @Post('run-now')
  async runNow(@Headers('x-admin-token') token: string | undefined) {
    this.assertAdmin(token);
    if (this.tuner.isKillSwitchActive()) {
      return { triggered: false, reason: 'kill_switch_active' };
    }
    // Best-effort : on déclenche le cycle async sans attendre (cron fait ainsi).
    void this.tuner.runAutoTuneCycle();
    return { triggered: true };
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
