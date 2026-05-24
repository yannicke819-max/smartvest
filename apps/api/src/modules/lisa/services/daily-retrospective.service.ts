/**
 * DailyRetrospectiveService — Feature #3.
 *
 * Cron 22:00 UTC : aggrège la journée par portfolio actif, demande à Gemini Pro
 * une rétrospective narrative française (~150 mots) + suggestions, persiste
 * en DB et trace.
 *
 * Gating ENV (default OFF) :
 *   DAILY_RETROSPECTIVE_ENABLED=true
 *   DAILY_RETROSPECTIVE_MODEL=gemini-pro (default, alt: 'gemini-flash')
 *
 * Best-effort : tout échec (LLM down, parse fail) → log warn, pas de crash.
 * Une seule rétro par portfolio/jour (UNIQUE constraint en DB).
 *
 * Coût récurrent estimé Gemini Pro : ~$0.001/portfolio/jour. Marginal.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import {
  buildDailyRetrospectiveUserPrompt,
  parseDailyRetrospective,
  DAILY_RETROSPECTIVE_SYSTEM_PROMPT,
  type DailyStatsInput,
} from './daily-retrospective.helper';

@Injectable()
export class DailyRetrospectiveService {
  private readonly logger = new Logger(DailyRetrospectiveService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('DAILY_RETROSPECTIVE_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log(`[daily-retro] ENABLED — cron 22:00 UTC, model=${this.config.get<string>('DAILY_RETROSPECTIVE_MODEL') ?? 'gemini-pro'}`);
    }
  }

  /**
   * Cron daily 22:00 UTC — génère la rétrospective pour chaque portfolio actif.
   */
  @Cron('0 22 * * *', { name: 'daily-retrospective', timeZone: 'UTC' })
  async runDailyCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) {
      this.logger.warn('[daily-retro] LLM router disabled, skip');
      return;
    }
    try {
      const portfolios = await this.fetchActivePortfolios();
      this.logger.log(`[daily-retro] generating for ${portfolios.length} portfolio(s)`);
      for (const p of portfolios) {
        await this.generateForPortfolio(p.id, p.capital_usd ?? 10000).catch((e) =>
          this.logger.warn(`[daily-retro] portfolio ${p.id.slice(0, 8)} failed: ${String(e).slice(0, 200)}`),
        );
      }
    } catch (e) {
      this.logger.error(`[daily-retro] cycle exception: ${String(e).slice(0, 300)}`);
    }
  }

  /**
   * Exposé pour usage manuel (endpoint admin futur, tests E2E).
   */
  async generateForPortfolio(portfolioId: string, capitalUsd: number): Promise<{ success: boolean; reason?: string }> {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const dateStr = todayUtc.toISOString().slice(0, 10);

    // Skip si déjà existante pour aujourd'hui
    const { data: existing } = await this.supabase.getClient()
      .from('lisa_daily_retrospective')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('retrospective_date', dateStr)
      .limit(1);
    if (existing && existing.length > 0) {
      return { success: false, reason: 'already_exists' };
    }

    const stats = await this.aggregateStats(portfolioId, capitalUsd, todayUtc);
    if (stats.n_opens === 0 && stats.n_closes === 0) {
      // Journée vide, pas la peine de générer
      return { success: false, reason: 'no_activity' };
    }

    const userPrompt = buildDailyRetrospectiveUserPrompt(stats);
    const t0 = Date.now();
    let llmResp;
    try {
      llmResp = await this.llmRouter.call({
        system: DAILY_RETROSPECTIVE_SYSTEM_PROMPT,
        user: userPrompt,
        temperature: 0.4,
        maxTokens: 600,
        timeoutMs: 15000,
      });
    } catch (e) {
      this.logger.warn(`[daily-retro] LLM call failed for ${portfolioId.slice(0, 8)}: ${String(e).slice(0, 150)}`);
      return { success: false, reason: 'llm_call_failed' };
    }
    const latency = Date.now() - t0;

    const parsed = parseDailyRetrospective(llmResp.content);
    if (!parsed) {
      this.logger.warn(`[daily-retro] parse failed for ${portfolioId.slice(0, 8)}: ${llmResp.content.slice(0, 150)}`);
      return { success: false, reason: 'parse_failed' };
    }

    const { error } = await this.supabase.getClient()
      .from('lisa_daily_retrospective')
      .insert({
        retrospective_date: dateStr,
        portfolio_id: portfolioId,
        stats_json: stats,
        narrative: parsed.narrative,
        suggestions: parsed.suggestions,
        sentiment: parsed.sentiment,
        llm_provider: llmResp.providerId,
        llm_cost_usd: llmResp.costUsd,
        llm_latency_ms: latency,
      });
    if (error) {
      this.logger.warn(`[daily-retro] insert failed for ${portfolioId.slice(0, 8)}: ${error.message}`);
      return { success: false, reason: `insert_failed: ${error.message}` };
    }
    this.logger.log(
      `[daily-retro] ${portfolioId.slice(0, 8)} ${dateStr} ${parsed.sentiment} — ${parsed.suggestions.length} suggestions, cost=$${llmResp.costUsd.toFixed(5)}, ${latency}ms`,
    );
    return { success: true };
  }

  /**
   * Récupère les portfolios actifs (autopilot_enabled=true).
   * Skip les portfolios sans capital ou avec kill switch.
   */
  private async fetchActivePortfolios(): Promise<Array<{ id: string; capital_usd: number | null }>> {
    const { data, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('portfolio_id, capital_usd, autopilot_enabled, kill_switch_active')
      .eq('autopilot_enabled', true)
      .neq('kill_switch_active', true);
    if (error) {
      this.logger.warn(`[daily-retro] fetch portfolios: ${error.message}`);
      return [];
    }
    return ((data ?? []) as Array<{ portfolio_id: string; capital_usd: number | null }>)
      .map((r) => ({ id: r.portfolio_id, capital_usd: r.capital_usd }));
  }

  /**
   * Aggrège toutes les stats du jour pour un portfolio.
   */
  private async aggregateStats(portfolioId: string, capitalUsd: number, todayUtc: Date): Promise<DailyStatsInput> {
    const dayStart = todayUtc.toISOString();
    const dayEnd = new Date(todayUtc.getTime() + 86400_000).toISOString();
    const dateStr = todayUtc.toISOString().slice(0, 10);

    // 1. Opens + closes du jour
    const [{ data: opensData }, { data: closesData }] = await Promise.all([
      this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, entry_timestamp')
        .eq('portfolio_id', portfolioId)
        .gte('entry_timestamp', dayStart)
        .lt('entry_timestamp', dayEnd),
      this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, realized_pnl_usd, realized_pnl_pct, exit_timestamp, status')
        .eq('portfolio_id', portfolioId)
        .gte('exit_timestamp', dayStart)
        .lt('exit_timestamp', dayEnd)
        .neq('status', 'open'),
    ]);
    const opens = (opensData ?? []) as Array<{ symbol: string }>;
    const closes = ((closesData ?? []) as Array<{ symbol: string; realized_pnl_usd: number | null; realized_pnl_pct: number | null }>)
      .filter((r) => r.realized_pnl_usd != null);

    const winners = closes.filter((c) => (c.realized_pnl_usd ?? 0) > 0);
    const losers = closes.filter((c) => (c.realized_pnl_usd ?? 0) < 0);
    const sumPnl = closes.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);

    let topWinner: DailyStatsInput['top_winner'];
    if (winners.length > 0) {
      const w = winners.reduce((m, c) => Number(c.realized_pnl_usd) > Number(m.realized_pnl_usd) ? c : m, winners[0]);
      topWinner = { symbol: w.symbol, pnl_usd: Number(w.realized_pnl_usd), pnl_pct: Number(w.realized_pnl_pct ?? 0) };
    }
    let topLoser: DailyStatsInput['top_loser'];
    if (losers.length > 0) {
      const l = losers.reduce((m, c) => Number(c.realized_pnl_usd) < Number(m.realized_pnl_usd) ? c : m, losers[0]);
      topLoser = { symbol: l.symbol, pnl_usd: Number(l.realized_pnl_usd), pnl_pct: Number(l.realized_pnl_pct ?? 0) };
    }

    // 2. Risk-monitor actions (decision_log kind='risk_monitor_action')
    const { data: rmLogs } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('payload, created_at')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'risk_monitor_action')
      .gte('created_at', dayStart)
      .lt('created_at', dayEnd);
    const rmActions = { rm_close_now: 0, rm_tighten_sl: 0, rm_raise_tp: 0, rm_momentum_ride: 0 };
    for (const log of (rmLogs ?? []) as Array<{ payload: { verdict?: string } }>) {
      const v = log.payload?.verdict;
      if (v === 'CLOSE_NOW') rmActions.rm_close_now++;
      else if (v === 'TIGHTEN_SL') rmActions.rm_tighten_sl++;
      else if (v === 'RAISE_TP') rmActions.rm_raise_tp++;
      else if (v === 'MOMENTUM_RIDE') rmActions.rm_momentum_ride++;
    }

    // 3. Détection cascades : ≥2 closes (status closed_stop) dans la même tranche minute
    const cascadeBuckets = new Map<string, number>();
    for (const c of closes) {
      const status = (c as Record<string, unknown>)['status'] as string | undefined;
      if (status === 'closed_stop' || status === 'closed_invalidated') {
        const t = (c as Record<string, unknown>)['exit_timestamp'] as string;
        if (t) {
          const bucket = t.slice(0, 16); // YYYY-MM-DDTHH:MM
          cascadeBuckets.set(bucket, (cascadeBuckets.get(bucket) ?? 0) + 1);
        }
      }
    }
    const cascadesAvoided = Array.from(cascadeBuckets.values()).filter((n) => n >= 2).length;

    return {
      date: dateStr,
      portfolioId,
      capitalUsd,
      n_opens: opens.length,
      n_closes: closes.length,
      n_winners: winners.length,
      n_losers: losers.length,
      sum_pnl_usd: Math.round(sumPnl * 100) / 100,
      pnl_pct_of_capital: capitalUsd > 0 ? sumPnl / capitalUsd : 0,
      top_winner: topWinner,
      top_loser: topLoser,
      rm_close_now: rmActions.rm_close_now,
      rm_tighten_sl: rmActions.rm_tighten_sl,
      rm_raise_tp: rmActions.rm_raise_tp,
      rm_momentum_ride: rmActions.rm_momentum_ride,
      cg_rejections: 0, // pas encore tracé en DB séparément, future enrichment
      cs_skipped: 0,    // idem
      cs_low_mult: 0,
      cs_std: 0,
      cs_high_mult: 0,
      cascades_avoided: cascadesAvoided,
    };
  }
}
