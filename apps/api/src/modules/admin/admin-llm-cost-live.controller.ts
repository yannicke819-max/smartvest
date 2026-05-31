/**
 * Endpoint admin pour compteur de coût LLM TEMPS RÉEL.
 *
 * Pourquoi : `api_costs_daily` est aggregé en fin de journée UTC (updated_at
 * observé 06:02 UTC du lendemain) → impossible de suivre la conso en cours
 * de journée. Le compteur Gemini de l'UI lit cette table donc apparait
 * "figé" même quand Pro/Flash/Mistral tournent à plein régime.
 *
 * Cette PR ajoute un endpoint qui aggrège DIRECTEMENT depuis `gemini_ab_decisions`
 * (où chaque cycle TRADER persiste pro_cost_usd + flash_cost_usd + mistral_cost_usd
 * + mistral_large_cost_usd) en temps réel.
 *
 * Endpoints :
 *   GET /admin/llm-cost-live          → today (depuis 00:00 UTC) live
 *   GET /admin/llm-cost-live?days=7   → past 7 days breakdown
 *
 * Auth : header x-admin-token aligné sur AdminLessonAutoApplyController.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

interface ProviderStats {
  calls: number;
  cost_usd: number;
  avg_latency_ms: number | null;
  parse_failures: number;
}

interface LiveCostResponse {
  since: string;
  until: string;
  total_cost_usd: number;
  total_cycles: number;
  providers: Record<string, ProviderStats>;
  by_hour: Array<{ hour: string; cost_usd: number; cycles: number }>;
  cap_daily_usd: number | null;
  cap_pct_used: number | null;
}

@Controller('admin/llm-cost-live')
export class AdminLlmCostLiveController {
  private readonly logger = new Logger(AdminLlmCostLiveController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get()
  async getLive(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('hours') hours?: string,
  ): Promise<LiveCostResponse> {
    this.assertAdmin(providedToken);

    // Default: today since 00:00 UTC. Override via ?hours=N for last N hours.
    const now = new Date();
    let since: Date;
    if (hours) {
      const h = Math.min(168, Math.max(1, Number(hours)));
      since = new Date(now.getTime() - h * 3600_000);
    } else {
      since = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('gemini_ab_decisions')
      .select(
        'decided_at,pro_cost_usd,flash_cost_usd,mistral_cost_usd,mistral_large_cost_usd,' +
          'pro_latency_ms,flash_latency_ms,mistral_latency_ms,mistral_large_latency_ms,' +
          'flash_call_error,mistral_call_error,mistral_large_call_error',
      )
      .gte('decided_at', since.toISOString())
      .order('decided_at', { ascending: true })
      .limit(50_000);

    if (error) {
      this.logger.error(`[llm-cost-live] query failed: ${error.message}`);
      throw new HttpException({ message: error.message }, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const rows = data ?? [];

    // Per-provider aggregation
    const stats: Record<string, { sum_cost: number; sum_latency: number; n_latency: number; n_calls: number; parse_fail: number }> = {
      'gemini-pro': { sum_cost: 0, sum_latency: 0, n_latency: 0, n_calls: 0, parse_fail: 0 },
      'gemini-flash': { sum_cost: 0, sum_latency: 0, n_latency: 0, n_calls: 0, parse_fail: 0 },
      'mistral-medium': { sum_cost: 0, sum_latency: 0, n_latency: 0, n_calls: 0, parse_fail: 0 },
      'mistral-large': { sum_cost: 0, sum_latency: 0, n_latency: 0, n_calls: 0, parse_fail: 0 },
    };

    const byHour = new Map<string, { cost: number; cycles: number }>();

    for (const r of rows as unknown as Array<Record<string, unknown>>) {
      const decidedAt = String(r.decided_at);
      const hour = decidedAt.slice(0, 13) + ':00';
      const hourBucket = byHour.get(hour) ?? { cost: 0, cycles: 0 };
      hourBucket.cycles += 1;

      // Pro always called (decideur)
      const proCost = Number(r.pro_cost_usd ?? 0);
      stats['gemini-pro'].sum_cost += proCost;
      stats['gemini-pro'].n_calls += 1;
      hourBucket.cost += proCost;
      const proLat = r.pro_latency_ms != null ? Number(r.pro_latency_ms) : null;
      if (proLat !== null) { stats['gemini-pro'].sum_latency += proLat; stats['gemini-pro'].n_latency += 1; }

      // Flash (shadow PR #508)
      const flashCost = Number(r.flash_cost_usd ?? 0);
      if (flashCost > 0 || r.flash_call_error) {
        stats['gemini-flash'].n_calls += 1;
        stats['gemini-flash'].sum_cost += flashCost;
        hourBucket.cost += flashCost;
        if (r.flash_call_error) stats['gemini-flash'].parse_fail += 1;
        const flashLat = r.flash_latency_ms != null ? Number(r.flash_latency_ms) : null;
        if (flashLat !== null) { stats['gemini-flash'].sum_latency += flashLat; stats['gemini-flash'].n_latency += 1; }
      }

      // Mistral Medium (shadow PR #519/520)
      const mediumCost = Number(r.mistral_cost_usd ?? 0);
      if (mediumCost > 0 || r.mistral_call_error) {
        stats['mistral-medium'].n_calls += 1;
        stats['mistral-medium'].sum_cost += mediumCost;
        hourBucket.cost += mediumCost;
        if (r.mistral_call_error) stats['mistral-medium'].parse_fail += 1;
        const medLat = r.mistral_latency_ms != null ? Number(r.mistral_latency_ms) : null;
        if (medLat !== null) { stats['mistral-medium'].sum_latency += medLat; stats['mistral-medium'].n_latency += 1; }
      }

      // Mistral Large (shadow PR #521)
      const largeCost = Number(r.mistral_large_cost_usd ?? 0);
      if (largeCost > 0 || r.mistral_large_call_error) {
        stats['mistral-large'].n_calls += 1;
        stats['mistral-large'].sum_cost += largeCost;
        hourBucket.cost += largeCost;
        if (r.mistral_large_call_error) stats['mistral-large'].parse_fail += 1;
        const lLat = r.mistral_large_latency_ms != null ? Number(r.mistral_large_latency_ms) : null;
        if (lLat !== null) { stats['mistral-large'].sum_latency += lLat; stats['mistral-large'].n_latency += 1; }
      }

      byHour.set(hour, hourBucket);
    }

    const providers: Record<string, ProviderStats> = {};
    let totalCost = 0;
    for (const [name, s] of Object.entries(stats)) {
      if (s.n_calls === 0) continue;  // skip silencieux les providers non actifs
      providers[name] = {
        calls: s.n_calls,
        cost_usd: Math.round(s.sum_cost * 10000) / 10000,
        avg_latency_ms: s.n_latency > 0 ? Math.round(s.sum_latency / s.n_latency) : null,
        parse_failures: s.parse_fail,
      };
      totalCost += s.sum_cost;
    }

    const capDailyRaw = this.config.get<string>('GEMINI_DAILY_HARD_CAP_USD');
    const capDaily = capDailyRaw ? Number(capDailyRaw) : 30;
    const capPctUsed = capDaily > 0 ? Math.round((totalCost / capDaily) * 1000) / 10 : null;

    return {
      since: since.toISOString(),
      until: now.toISOString(),
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      total_cycles: rows.length,
      providers,
      by_hour: Array.from(byHour.entries())
        .map(([hour, v]) => ({ hour, cost_usd: Math.round(v.cost * 10000) / 10000, cycles: v.cycles }))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
      cap_daily_usd: capDaily,
      cap_pct_used: capPctUsed,
    };
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
      throw new HttpException({ message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' }, HttpStatus.FORBIDDEN);
    }
  }
}
