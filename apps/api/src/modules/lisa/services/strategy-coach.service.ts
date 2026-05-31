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
- portfolio_age_days (âge du portfolio) + lookback_days_used (fenêtre stats réelle, clampée)
- current_capital, initial_capital
- targets effectifs (jour/mois/année)
- stats_lookback (trades, win-rate, sum_pnl sur lookback_days_used)
- stats_short (trades, sum_pnl sur fenêtre courte clampée à l'âge)
- top 10 lessons citées récemment (avec applied / applied_as_open / applied_as_hold_skip_exit)
  → IMPORTANT : citations + lesson_intent='hold|skip|exit' = lesson APPLIQUÉE correctement
  → Ne JAMAIS interpréter "applied < citations" comme "lesson cassée" si lesson_intent ≠ 'open'
- active_entry_discipline_lessons : lessons conf ≥ 0.85 protégeant l'entry discipline
  → Tout param qui assouplit cette discipline (seuil de confiance baissé, threshold baissé,
    persistence baissée, max_change_pct relevé) est REFUSÉ par le post-filter coté serveur.
    Ne propose pas ces changements quand la liste n'est pas vide.
- autopilot_enabled : si TRUE, ne propose JAMAIS de lesson ACTIVATE_TRADING_BOT ni
  de param trading_bot_enabled: false→true (le bot tourne déjà — proposition no-op refusée
  par le post-filter).
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
- Si stats_lookback.trades < 30, verdict = "NEEDS_CHANGES" + rationale explicite mentionnant
  le sample-size insuffisant ET le portfolio_age_days (si < 30, c'est NORMAL — le bot n'a pas
  encore eu le temps d'accumuler. Ne propose AUCUN param change dans ce cas, seulement des
  lessons descriptives ou "no-op" verdict + attendre.)
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
  autopilot_enabled: boolean;
  lisa_target_daily_usd: number;
  lisa_target_daily_pct: number;
  lisa_target_monthly_usd: number;
  lisa_target_monthly_pct: number;
  lisa_target_annual_usd: number;
  lisa_target_annual_pct: number;
}

// Issue #502 — garde-fou âge minimum. Portfolio jeune = stats 30j inutilisables,
// le LLM coach conclut à tort "bot cassé / objectifs irréalistes". Skip propre.
const MIN_PORTFOLIO_AGE_DAYS_FOR_COACH = 7;

// Issue #502 — post-filter contradictions. Params qui assouplissent l'entry
// discipline. Si un param est ici ET qu'au moins une lesson active
// `entry_discipline` conf ≥ 0.85 existe → drop le param change avec audit.
export const ENTRY_LOOSENING_PARAMS: Record<string, 'decrease' | 'increase'> = {
  min_confidence_to_trade: 'decrease',
  entry_threshold_factor: 'decrease',
  gainers_min_persistence_score: 'decrease',
  gainers_min_path_efficiency: 'decrease',
  max_change_pct: 'increase',
  max_change_pct_long: 'increase',
  gainers_max_change_pct_long: 'increase',
};

/**
 * Issue #502 — drop des propositions auto-contradictoires avant persistance.
 * Pure function exportée pour les tests unitaires.
 *
 * Cas 1 : lesson "ACTIVATE_TRADING_BOT" / param `trading_bot_enabled: false→true`
 *         alors qu'autopilot est déjà actif → drop.
 * Cas 2 : param qui assouplit l'entry discipline (ENTRY_LOOSENING_PARAMS) alors
 *         qu'au moins une lesson active `entry_discipline` conf ≥ 0.85 existe
 *         → drop. La lesson haute confiance "gagne" sur la suggestion coach.
 */
export function applyCoachConflictPostFilter(args: {
  lessons: unknown[];
  params: unknown[];
  autopilotEnabled: boolean;
  hasHighConfEntryLessons: boolean;
}): { lessons: unknown[]; params: unknown[]; dropped: Array<{ type: 'lesson' | 'param'; name: string; reason: string }> } {
  const dropped: Array<{ type: 'lesson' | 'param'; name: string; reason: string }> = [];

  const filteredLessons = args.lessons.filter((l) => {
    const lesson = l as { lesson_kind?: string; lesson_text?: string };
    const kind = String(lesson.lesson_kind ?? '').toUpperCase();
    const text = String(lesson.lesson_text ?? '').toLowerCase();
    if (args.autopilotEnabled && (kind.includes('ACTIVATE_TRADING') || /activer.*bot|activate.*trading.*bot/.test(text))) {
      dropped.push({ type: 'lesson', name: kind || 'unknown', reason: 'autopilot_already_enabled' });
      return false;
    }
    return true;
  });

  const filteredParams = args.params.filter((p) => {
    const param = p as { param?: string; current?: unknown; proposed?: unknown };
    const name = String(param.param ?? '').toLowerCase();

    // Cas 1 : trading_bot_enabled false→true alors qu'autopilot déjà actif
    if (args.autopilotEnabled && name === 'trading_bot_enabled' && param.proposed === true) {
      dropped.push({ type: 'param', name, reason: 'autopilot_already_enabled' });
      return false;
    }

    // Cas 2 : assouplissement entry discipline avec lesson conf ≥ 0.85 active
    const looseningDir = ENTRY_LOOSENING_PARAMS[name];
    if (looseningDir && args.hasHighConfEntryLessons) {
      const current = Number(param.current);
      const proposed = Number(param.proposed);
      if (Number.isFinite(current) && Number.isFinite(proposed)) {
        const isLoosening = (looseningDir === 'decrease' && proposed < current)
          || (looseningDir === 'increase' && proposed > current);
        if (isLoosening) {
          dropped.push({ type: 'param', name, reason: 'conflicts_with_high_conf_entry_discipline_lesson' });
          return false;
        }
      }
    }

    return true;
  });

  return { lessons: filteredLessons, params: filteredParams, dropped };
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
      .select('portfolio_id, user_id, lisa_initial_capital_usd, lisa_compound_pnl_enabled, kill_switch_active, autopilot_enabled, lisa_target_daily_usd, lisa_target_daily_pct, lisa_target_monthly_usd, lisa_target_monthly_pct, lisa_target_annual_usd, lisa_target_annual_pct')
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

    // Issue #502 — garde-fou âge portfolio. Sur un portfolio recréé il y a quelques
    // heures, les stats 7j/30j sont du bruit (0 trade) et le LLM coach conclut
    // à tort à un bot cassé. Skip propre avec audit.
    const portfolioAgeDays = await this.getPortfolioAgeDays(cfg.portfolio_id);
    if (portfolioAgeDays !== null && portfolioAgeDays < MIN_PORTFOLIO_AGE_DAYS_FOR_COACH) {
      await client.from('lisa_decision_log').insert({
        portfolio_id: cfg.portfolio_id,
        kind: 'coach_proposal_skipped_portfolio_too_young',
        payload: {
          portfolio_age_days: portfolioAgeDays,
          min_required_days: MIN_PORTFOLIO_AGE_DAYS_FOR_COACH,
        },
      });
      this.logger.debug(`[strategy-coach] portfolio=${cfg.portfolio_id.slice(0, 8)} skip — age=${portfolioAgeDays.toFixed(1)}d < ${MIN_PORTFOLIO_AGE_DAYS_FOR_COACH}d`);
      return null;
    }

    const ctx = await this.buildContext(cfg, portfolioAgeDays);

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

    // Issue #502 — post-filter contradictions auto-évidentes avant persistance.
    const rawLessons = Array.isArray(parsed.proposed_lessons) ? parsed.proposed_lessons : [];
    const rawParams = Array.isArray(parsed.proposed_parameter_changes) ? parsed.proposed_parameter_changes : [];
    const activeEntryLessons = Array.isArray(ctx.active_entry_discipline_lessons) ? ctx.active_entry_discipline_lessons : [];
    const { lessons, params, dropped } = this.applyConflictPostFilter({
      lessons: rawLessons,
      params: rawParams,
      autopilotEnabled: cfg.autopilot_enabled,
      hasHighConfEntryLessons: activeEntryLessons.length > 0,
    });
    if (dropped.length > 0) {
      await client.from('lisa_decision_log').insert({
        portfolio_id: cfg.portfolio_id,
        kind: 'coach_proposal_post_filter_dropped',
        payload: { dropped },
      });
      this.logger.log(`[strategy-coach] portfolio=${cfg.portfolio_id.slice(0, 8)} post-filter dropped ${dropped.length} (${dropped.map((d) => d.reason).join(',')})`);
    }

    // Anti-redondance hash (basique, premier verdict + count lessons + first lesson_kind)
    const firstLessonKind = (lessons[0] as { lesson_kind?: string } | undefined)?.lesson_kind ?? '';
    const firstParamName = (params[0] as { param?: string } | undefined)?.param ?? '';
    const patternHash = `${parsed.feasibility_verdict}:${lessons.length}:${firstLessonKind}:${params.length}:${firstParamName}`;

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

  private async buildContext(cfg: PortfolioConfig, portfolioAgeDays: number | null): Promise<Record<string, unknown>> {
    const client = this.supabase.getClient();
    const nowMs = Date.now();

    // Issue #502 — fenêtre dynamique : sur un portfolio de 9 jours, regarder 30j
    // c'est inclure 21 jours d'inexistence. On clamp à l'âge réel.
    const ageClamp = portfolioAgeDays !== null ? Math.max(1, Math.floor(portfolioAgeDays)) : 30;
    const lookbackDays = Math.min(30, ageClamp);
    const shortLookbackDays = Math.min(7, ageClamp);
    const lookbackIso = new Date(nowMs - lookbackDays * 86400_000).toISOString();
    const shortLookbackIso = new Date(nowMs - shortLookbackDays * 86400_000).toISOString();

    const [allClosed, recentDecisions, citations, highConfEntryLessons] = await Promise.all([
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
        .select('marker_text, outcome_pnl_usd, outcome_win, action_applied, lesson_intent')
        .eq('portfolio_id', cfg.portfolio_id)
        .gte('cited_at', lookbackIso)
        .limit(2000),
      // Issue #502 — chargé pour post-filter contradictions (cf. applyConflictPostFilter)
      client
        .from('scanner_lessons')
        .select('id, lesson_kind, lesson_text, confidence')
        .eq('is_active', true)
        .eq('lesson_kind', 'entry_discipline')
        .gte('confidence', 0.85),
    ]);

    const closed = (allClosed.data ?? []) as Array<{ realized_pnl_usd?: unknown; exit_timestamp?: string; symbol?: string; exit_reason?: string }>;
    const cumulative = closed.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const currentCapital = cfg.lisa_compound_pnl_enabled ? cfg.lisa_initial_capital_usd + cumulative : cfg.lisa_initial_capital_usd;
    const drawdownFromInitialPct = cfg.lisa_initial_capital_usd > 0
      ? ((currentCapital - cfg.lisa_initial_capital_usd) / cfg.lisa_initial_capital_usd) * 100
      : 0;

    const closedLookback = closed.filter((c) => String(c.exit_timestamp ?? '') >= lookbackIso);
    const closedShort = closed.filter((c) => String(c.exit_timestamp ?? '') >= shortLookbackIso);
    const statsLookback = {
      lookback_days: lookbackDays,
      trades: closedLookback.length,
      sum_pnl: closedLookback.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0),
      wins: closedLookback.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length,
      losses: closedLookback.filter((c) => Number(c.realized_pnl_usd ?? 0) < 0).length,
    };
    const statsShort = {
      lookback_days: shortLookbackDays,
      trades: closedShort.length,
      sum_pnl: closedShort.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0),
    };

    // Top 10 lessons par citations + impact.
    // Issue #502 — la notion de "applied" couvre désormais aussi les lessons
    // d'intent hold/skip/exit : une citation hold-citée puis hold-décidé EST une
    // application correcte de la lesson, pas un échec.
    const lessonAgg = new Map<string, { marker: string; citations: number; sum_pnl: number; wins: number; losses: number; applied: number; applied_as_open: number; applied_as_hold_skip_exit: number }>();
    for (const c of (citations.data ?? []) as Array<{ marker_text?: string; outcome_pnl_usd?: unknown; outcome_win?: boolean | null; action_applied?: boolean; lesson_intent?: string | null }>) {
      const key = String(c.marker_text ?? '?');
      let b = lessonAgg.get(key);
      if (!b) { b = { marker: key, citations: 0, sum_pnl: 0, wins: 0, losses: 0, applied: 0, applied_as_open: 0, applied_as_hold_skip_exit: 0 }; lessonAgg.set(key, b); }
      b.citations += 1;
      b.sum_pnl += Number(c.outcome_pnl_usd ?? 0);
      if (c.outcome_win === true) b.wins += 1;
      if (c.outcome_win === false) b.losses += 1;
      const intent = c.lesson_intent ?? null;
      if (intent === 'open' && c.action_applied) {
        b.applied_as_open += 1;
        b.applied += 1;
      } else if (intent === 'hold' || intent === 'skip' || intent === 'exit') {
        b.applied_as_hold_skip_exit += 1;
        b.applied += 1;
      } else if (c.action_applied) {
        // Backfill / intent null / 'other' : retombe sur l'ancien compteur
        b.applied += 1;
      }
    }
    const topLessons = [...lessonAgg.values()].sort((a, b) => b.citations - a.citations).slice(0, 10);

    // Cibles effectives Mode C
    const effDaily = Math.max(cfg.lisa_target_daily_usd, (cfg.lisa_target_daily_pct / 100) * currentCapital);
    const effMonthly = Math.max(cfg.lisa_target_monthly_usd, (cfg.lisa_target_monthly_pct / 100) * currentCapital);
    const effAnnual = Math.max(cfg.lisa_target_annual_usd, (cfg.lisa_target_annual_pct / 100) * currentCapital);

    return {
      generated_at: new Date().toISOString(),
      portfolio_age_days: portfolioAgeDays,
      lookback_days_used: lookbackDays,
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
      stats_short: statsShort,
      stats_lookback: statsLookback,
      top_lessons: topLessons,
      recent_decisions: (recentDecisions.data ?? []).slice(0, 10),
      recent_closes: closed.slice(-10),
      kill_switch_active: cfg.kill_switch_active,
      autopilot_enabled: cfg.autopilot_enabled,
      // Issue #502 — exposé au LLM pour qu'il ne propose pas de baisser une
      // garde qui a son origine dans une lesson conf ≥ 0.85 (KTOS-like).
      active_entry_discipline_lessons: ((highConfEntryLessons.data ?? []) as Array<{ id: string; lesson_kind: string; lesson_text: string; confidence: number }>).map((l) => ({
        id: l.id,
        kind: l.lesson_kind,
        confidence: l.confidence,
        excerpt: l.lesson_text.slice(0, 200),
      })),
    };
  }

  /**
   * Issue #502 — âge du portfolio en jours (fraction acceptée).
   * Retourne null si portfolio introuvable (échec silencieux → comportement
   * pré-fix = pas de skip).
   */
  private async getPortfolioAgeDays(portfolioId: string): Promise<number | null> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('portfolios')
      .select('created_at')
      .eq('id', portfolioId)
      .maybeSingle();
    if (error || !data) return null;
    const createdAt = new Date((data as { created_at: string }).created_at).getTime();
    if (!Number.isFinite(createdAt)) return null;
    return (Date.now() - createdAt) / 86400_000;
  }

  private async shouldEscalateToPro(_cfg: PortfolioConfig, _ctx: Record<string, unknown>): Promise<boolean> {
    // 31/05/2026 cost-cut : escalation Pro désactivée par défaut.
    // Réactivable via env STRATEGY_COACH_PRO_ESCALATION_ENABLED=true.
    //
    // Raison : observations 30/05 — les propositions Pro du coach étaient toutes à
    // rejeter (faux positifs « bot inactif → relâcher discipline »). Le gain de
    // qualité Pro ne justifiait pas le coût Pro (~8× Flash Lite).
    //
    // Logique précédente conservée pour réactivation :
    //   - drawdown < -20% → Pro
    //   - 1 cycle sur 6 (deep-dive 6h) → Pro
    //   - dernière proposition UNREALISTIC → Pro
    const proEnabled = (this.config.get<string>('STRATEGY_COACH_PRO_ESCALATION_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (!proEnabled) return false;
    const capital = _ctx.capital as { drawdown_from_initial_pct?: number };
    if ((capital?.drawdown_from_initial_pct ?? 0) < -20) return true;
    if (this.cycleCounter % 6 === 0) return true;
    const { data: last } = await this.supabase.getClient()
      .from('coach_proposals')
      .select('feasibility_verdict')
      .eq('portfolio_id', _cfg.portfolio_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((last as { feasibility_verdict?: string } | null)?.feasibility_verdict === 'UNREALISTIC') return true;
    return false;
  }

  private applyConflictPostFilter(args: {
    lessons: unknown[];
    params: unknown[];
    autopilotEnabled: boolean;
    hasHighConfEntryLessons: boolean;
  }): { lessons: unknown[]; params: unknown[]; dropped: Array<{ type: 'lesson' | 'param'; name: string; reason: string }> } {
    return applyCoachConflictPostFilter(args);
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
