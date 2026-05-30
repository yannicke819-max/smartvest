// LISA refonte C.1 — StrategyCoachService.
//
// Cron hourly :
//   - Pour chaque portfolio avec lisa_strategy_coach_enabled=true ET
//     lisa_initial_capital_usd > 0
//   - Build contexte (capital, targets, stats 30j, top lessons citées,
//     dernières décisions, dernières closes)
//   - Appel Gemini Flash Lite (call()) par défaut
//   - Escalation Gemini Pro (callWithPro()) si :
//       - drawdown depuis initial < -20%
//       - dernière proposition verdict = UNREALISTIC
//       - tous les 6 cycles horaires (deep-dive quotidien)
//   - Parse JSON → INSERT coach_proposals status='pending'
//   - Notify user via PushNotifications + log decision_log
//
// UI review (accept/reject) = C.2 (séparé).

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { PushNotificationsService } from './push-notifications.service';

const SYSTEM_PROMPT = `Tu es Strategy Coach de LISA, un trader algo autonome basé sur Gemini Pro.

Ton rôle : analyser la performance récente de TRADER, comparer aux cibles de l'utilisateur, et proposer des règles (lessons) ou changements de paramètres pour améliorer l'atteinte des cibles SANS compromettre les garde-fous.

Tu reçois en input un JSON contenant :
- current_capital, initial_capital
- targets effectifs (jour/mois/année)
- stats 30j (trades, win-rate, sum_pnl)
- top 10 lessons citées récemment (avec leur impact)
- dernières décisions LLM (action_kind, applied, thesis_excerpt)
- dernières closes (symbol, pnl, exit_reason)

Ta sortie doit être un JSON strict :
{
  "feasibility_verdict": "REACHABLE" | "NEEDS_CHANGES" | "UNREALISTIC",
  "feasibility_probability_pct": <0..100>,
  "feasibility_rationale": "<2-3 phrases>",
  "proposed_lessons": [
    {
      "lesson_kind": "<UPPER_SNAKE_CASE>",
      "lesson_text": "Quand <CONDITION>, alors <ACTION>",
      "confidence": <0..1>,
      "scope": "trader_agent_only" | "all_scanner",
      "expected_impact_usd": <number>,
      "rationale": "<1-2 phrases>"
    }
  ],
  "proposed_parameter_changes": [
    {
      "param": "<nom_param>",
      "current": <valeur>,
      "proposed": <valeur>,
      "rationale": "<1-2 phrases>",
      "expected_impact": "<+ X% trades, - Y$ risk, etc.>"
    }
  ],
  "risk_warnings": ["<warning 1>", "<warning 2>"]
}

Règles :
- Maximum 3 lessons par proposition (qualité > quantité)
- Maximum 2 parameter changes par proposition
- Si stats sample_size < 30 trades, verdict = "NEEDS_CHANGES" car insuffisant pour conclure
- Si drawdown depuis initial < -25%, verdict = "UNREALISTIC" + warning explicite
- Cite des markers existants dans risk_warnings si tu vois leur impact négatif
- Ne propose JAMAIS de désarmer un kill-switch ni de bypass safety
- Réponds UNIQUEMENT le JSON, pas de markdown ni explication hors JSON`;

interface PortfolioConfig {
  portfolio_id: string;
  user_id: string;
  lisa_initial_capital_usd: number;
  lisa_compound_pnl_enabled: boolean;
  kill_switch_active: boolean;
  lisa_target_daily_usd: number;
  lisa_target_daily_pct: number;
  lisa_target_monthly_usd: number;
  lisa_target_monthly_pct: number;
  lisa_target_annual_usd: number;
  lisa_target_annual_pct: number;
}

@Injectable()
export class StrategyCoachService {
  private readonly logger = new Logger(StrategyCoachService.name);
  private enabled = false;
  private cycleCounter = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() private readonly pushNotifs?: PushNotificationsService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('STRATEGY_COACH_ENABLED') ?? 'true').toLowerCase() === 'true';
    if (!this.enabled) {
      this.logger.log('[strategy-coach] disabled via STRATEGY_COACH_ENABLED=false');
      return;
    }
    try {
      // Minute 17 (offset éviter collision cron 00, 15, 30, 45)
      const job = new CronJob('17 * * * *', () => {
        this.runCoach().catch((e) =>
          this.logger.error(`[strategy-coach] cron failed: ${String(e).slice(0, 200)}`),
        );
      });
      this.schedulerRegistry.addCronJob('strategy-coach-hourly', job);
      job.start();
      this.logger.log('[strategy-coach] ENABLED — cron hourly @ minute 17');
    } catch (e) {
      this.logger.error(`[strategy-coach] cron register failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Exécutable manuellement (admin endpoint) ou via cron.
   */
  async runCoach(): Promise<{ processed: number; proposalsCreated: number; errors: number }> {
    if (!this.supabase.isReady() || !this.llmRouter.isEnabled()) {
      this.logger.warn('[strategy-coach] supabase or llm router not ready, skip');
      return { processed: 0, proposalsCreated: 0, errors: 0 };
    }
    this.cycleCounter++;

    const client = this.supabase.getClient();
    const { data: configs, error } = await client
      .from('lisa_session_configs')
      .select('portfolio_id, user_id, lisa_initial_capital_usd, lisa_compound_pnl_enabled, kill_switch_active, lisa_target_daily_usd, lisa_target_daily_pct, lisa_target_monthly_usd, lisa_target_monthly_pct, lisa_target_annual_usd, lisa_target_annual_pct')
      .eq('lisa_strategy_coach_enabled', true)
      .gt('lisa_initial_capital_usd', 0);
    if (error) {
      this.logger.error(`[strategy-coach] config fetch err: ${error.message}`);
      return { processed: 0, proposalsCreated: 0, errors: 1 };
    }

    let processed = 0;
    let proposalsCreated = 0;
    let errors = 0;
    for (const cfg of (configs ?? []) as unknown as PortfolioConfig[]) {
      processed++;
      try {
        const proposalId = await this.runForPortfolio(cfg);
        if (proposalId) proposalsCreated++;
      } catch (e) {
        this.logger.warn(`[strategy-coach] portfolio=${cfg.portfolio_id.slice(0, 8)} err: ${String(e).slice(0, 200)}`);
        errors++;
      }
    }
    this.logger.log(`[strategy-coach] done processed=${processed} created=${proposalsCreated} errors=${errors}`);
    return { processed, proposalsCreated, errors };
  }

  private async runForPortfolio(cfg: PortfolioConfig): Promise<string | null> {
    const client = this.supabase.getClient();
    const ctx = await this.buildContext(cfg);

    // Décision Flash vs Pro
    const usePro = await this.shouldEscalateToPro(cfg, ctx);
    const llmModel = usePro ? 'gemini-pro' : 'gemini-flash';

    const userPrompt = JSON.stringify(ctx, null, 2);
    const llmCallParams = {
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 2048,
      temperature: 0.4,
    };

    const start = Date.now();
    const res = usePro
      ? await this.llmRouter.callWithPro(llmCallParams)
      : await this.llmRouter.call(llmCallParams);
    const latencyMs = Date.now() - start;

    const parsed = this.parseJsonStrict(res.content);
    if (!parsed) {
      this.logger.warn(`[strategy-coach] portfolio=${cfg.portfolio_id.slice(0, 8)} unparseable JSON`);
      return null;
    }

    // Anti-redondance hash (basique, premier verdict + count lessons + first lesson_kind)
    const lessons = Array.isArray(parsed.proposed_lessons) ? parsed.proposed_lessons : [];
    const params = Array.isArray(parsed.proposed_parameter_changes) ? parsed.proposed_parameter_changes : [];
    const patternHash = `${parsed.feasibility_verdict}:${lessons.length}:${lessons[0]?.lesson_kind ?? ''}:${params.length}:${params[0]?.param ?? ''}`;

    // Skip si déjà proposé dans les 6 dernières heures avec même hash
    const sixHoursAgoIso = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: recentSame } = await client
      .from('coach_proposals')
      .select('id')
      .eq('portfolio_id', cfg.portfolio_id)
      .eq('pattern_hash', patternHash)
      .gte('created_at', sixHoursAgoIso)
      .limit(1);
    if (recentSame && recentSame.length > 0) {
      this.logger.debug(`[strategy-coach] portfolio=${cfg.portfolio_id.slice(0, 8)} skip duplicate pattern ${patternHash}`);
      return null;
    }

    // INSERT proposition
    const { data: inserted, error: insErr } = await client
      .from('coach_proposals')
      .insert({
        portfolio_id: cfg.portfolio_id,
        source: 'cron_hourly',
        llm_model: llmModel,
        llm_cost_usd: res.costUsd,
        llm_latency_ms: latencyMs,
        input_context: ctx,
        feasibility_verdict: String(parsed.feasibility_verdict ?? 'UNKNOWN'),
        feasibility_probability_pct: typeof parsed.feasibility_probability_pct === 'number' ? parsed.feasibility_probability_pct : null,
        feasibility_rationale: String(parsed.feasibility_rationale ?? ''),
        proposed_lessons: lessons,
        proposed_parameter_changes: params,
        risk_warnings: Array.isArray(parsed.risk_warnings) ? parsed.risk_warnings : [],
        status: 'pending',
        pattern_hash: patternHash,
      })
      .select('id')
      .maybeSingle();
    if (insErr) {
      this.logger.warn(`[strategy-coach] insert err: ${insErr.message}`);
      return null;
    }
    const proposalId = (inserted as { id?: string } | null)?.id ?? null;

    // Audit + notify user
    await client.from('lisa_decision_log').insert({
      portfolio_id: cfg.portfolio_id,
      kind: 'strategy_coach_proposal',
      payload: {
        proposal_id: proposalId,
        llm_model: llmModel,
        verdict: parsed.feasibility_verdict,
        lessons_count: lessons.length,
        params_count: params.length,
        cost_usd: res.costUsd,
      },
    });
    if (this.pushNotifs) {
      this.pushNotifs.notifyUser(cfg.user_id, 'coach_proposal_pending').catch(() => null);
    }
    if (proposalId) {
      await client
        .from('coach_proposals')
        .update({ notified_at: new Date().toISOString() })
        .eq('id', proposalId);
    }
    return proposalId;
  }

  private async buildContext(cfg: PortfolioConfig): Promise<Record<string, unknown>> {
    const client = this.supabase.getClient();
    const nowMs = Date.now();
    const thirtyDaysAgoIso = new Date(nowMs - 30 * 86400_000).toISOString();
    const sevenDaysAgoIso = new Date(nowMs - 7 * 86400_000).toISOString();

    const [allClosed, recentDecisions, citations] = await Promise.all([
      client
        .from('lisa_positions')
        .select('realized_pnl_usd, exit_timestamp, symbol, exit_reason')
        .eq('portfolio_id', cfg.portfolio_id)
        .neq('status', 'open'),
      client
        .from('trader_agent_decisions')
        .select('decided_at, action_kind, target_symbol, confidence, action_applied, apply_error')
        .eq('portfolio_id', cfg.portfolio_id)
        .order('decided_at', { ascending: false })
        .limit(20),
      client
        .from('scanner_lesson_citations')
        .select('marker_text, outcome_pnl_usd, outcome_win, action_applied')
        .eq('portfolio_id', cfg.portfolio_id)
        .gte('cited_at', thirtyDaysAgoIso)
        .limit(2000),
    ]);

    const closed = (allClosed.data ?? []) as Array<{ realized_pnl_usd?: unknown; exit_timestamp?: string; symbol?: string; exit_reason?: string }>;
    const cumulative = closed.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const currentCapital = cfg.lisa_compound_pnl_enabled ? cfg.lisa_initial_capital_usd + cumulative : cfg.lisa_initial_capital_usd;
    const drawdownFromInitialPct = cfg.lisa_initial_capital_usd > 0
      ? ((currentCapital - cfg.lisa_initial_capital_usd) / cfg.lisa_initial_capital_usd) * 100
      : 0;

    const closed30d = closed.filter((c) => String(c.exit_timestamp ?? '') >= thirtyDaysAgoIso);
    const closed7d = closed.filter((c) => String(c.exit_timestamp ?? '') >= sevenDaysAgoIso);
    const stats30d = {
      trades: closed30d.length,
      sum_pnl: closed30d.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0),
      wins: closed30d.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length,
      losses: closed30d.filter((c) => Number(c.realized_pnl_usd ?? 0) < 0).length,
    };
    const stats7d = {
      trades: closed7d.length,
      sum_pnl: closed7d.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0),
    };

    // Top 10 lessons par citations + impact
    const lessonAgg = new Map<string, { marker: string; citations: number; sum_pnl: number; wins: number; losses: number; applied: number }>();
    for (const c of (citations.data ?? []) as Array<{ marker_text?: string; outcome_pnl_usd?: unknown; outcome_win?: boolean | null; action_applied?: boolean }>) {
      const key = String(c.marker_text ?? '?');
      let b = lessonAgg.get(key);
      if (!b) { b = { marker: key, citations: 0, sum_pnl: 0, wins: 0, losses: 0, applied: 0 }; lessonAgg.set(key, b); }
      b.citations += 1;
      b.sum_pnl += Number(c.outcome_pnl_usd ?? 0);
      if (c.outcome_win === true) b.wins += 1;
      if (c.outcome_win === false) b.losses += 1;
      if (c.action_applied) b.applied += 1;
    }
    const topLessons = [...lessonAgg.values()].sort((a, b) => b.citations - a.citations).slice(0, 10);

    // Cibles effectives Mode C
    const effDaily = Math.max(cfg.lisa_target_daily_usd, (cfg.lisa_target_daily_pct / 100) * currentCapital);
    const effMonthly = Math.max(cfg.lisa_target_monthly_usd, (cfg.lisa_target_monthly_pct / 100) * currentCapital);
    const effAnnual = Math.max(cfg.lisa_target_annual_usd, (cfg.lisa_target_annual_pct / 100) * currentCapital);

    return {
      generated_at: new Date().toISOString(),
      capital: {
        initial_usd: cfg.lisa_initial_capital_usd,
        current_usd: currentCapital,
        cumulative_pnl_usd: cumulative,
        drawdown_from_initial_pct: drawdownFromInitialPct,
        compound_enabled: cfg.lisa_compound_pnl_enabled,
      },
      targets_effective_usd: {
        daily: effDaily,
        monthly: effMonthly,
        annual: effAnnual,
      },
      stats_7d: stats7d,
      stats_30d: stats30d,
      top_lessons: topLessons,
      recent_decisions: (recentDecisions.data ?? []).slice(0, 10),
      recent_closes: closed.slice(-10),
      kill_switch_active: cfg.kill_switch_active,
    };
  }

  private async shouldEscalateToPro(cfg: PortfolioConfig, ctx: Record<string, unknown>): Promise<boolean> {
    const capital = ctx.capital as { drawdown_from_initial_pct?: number };
    if ((capital?.drawdown_from_initial_pct ?? 0) < -20) return true;
    // Deep-dive : 1 sur 6 cycles horaires (≈ 1 par 6h)
    if (this.cycleCounter % 6 === 0) return true;
    // Dernière proposition UNREALISTIC → escalade
    const { data: last } = await this.supabase.getClient()
      .from('coach_proposals')
      .select('feasibility_verdict')
      .eq('portfolio_id', cfg.portfolio_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((last as { feasibility_verdict?: string } | null)?.feasibility_verdict === 'UNREALISTIC') return true;
    return false;
  }

  private parseJsonStrict(raw: string): Record<string, unknown> | null {
    // Tente d'extraire un bloc ```json ... ``` ou parse direct
    let text = raw.trim();
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) text = codeBlock[1].trim();
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
}
