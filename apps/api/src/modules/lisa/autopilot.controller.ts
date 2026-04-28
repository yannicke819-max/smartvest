import { Controller, Get, Headers, NotFoundException, Query } from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { SupabaseService } from '../supabase/supabase.service';
import { ApiCostTrackerService } from './services/api-cost-tracker.service';

/**
 * P8-BR — Endpoint observable de l'état autopilot (budget + pause).
 *
 *   GET /autopilot/cost-status?portfolioId=...
 *     → { daily_used_usd, daily_budget_usd, pct, paused_reason, next_reset_utc }
 *
 * Permet à l'UI d'afficher un mini-widget badge "Budget API: $X / $Y" et
 * la raison de pause éventuelle. Source de vérité :
 *   - daily_used_usd : ApiCostTrackerService.getTodayTotalUsd()
 *   - daily_budget_usd / paused_reason : lisa_session_configs (par portfolio)
 *   - next_reset_utc : prochain minuit UTC (rollover du compteur journalier)
 */
@Controller('autopilot')
export class AutopilotController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly apiCostTracker: ApiCostTrackerService,
  ) {}

  @Get('cost-status')
  async getCostStatus(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId: string,
  ) {
    extractUserId(headers);
    if (!portfolioId) {
      throw new NotFoundException('portfolioId query param required');
    }

    const { data: cfg } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('daily_cost_budget_usd, autopilot_paused_reason, autopilot_enabled, kill_switch_active')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (!cfg) {
      throw new NotFoundException('Session config introuvable pour ce portfolio');
    }

    const dailyUsedUsd = await this.apiCostTracker.getTodayTotalUsd();
    const dailyBudgetUsd = cfg.daily_cost_budget_usd != null
      ? Number(cfg.daily_cost_budget_usd)
      : null;
    const pct = dailyBudgetUsd && dailyBudgetUsd > 0
      ? dailyUsedUsd / dailyBudgetUsd
      : null;

    const nextResetUtc = nextMidnightUtc();

    return {
      daily_used_usd: dailyUsedUsd,
      daily_budget_usd: dailyBudgetUsd,
      pct,
      paused_reason: cfg.autopilot_paused_reason ?? null,
      autopilot_enabled: cfg.autopilot_enabled === true,
      kill_switch_active: cfg.kill_switch_active === true,
      next_reset_utc: nextResetUtc.toISOString(),
    };
  }
}

function nextMidnightUtc(): Date {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return next;
}
