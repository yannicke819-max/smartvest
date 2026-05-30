// LISA refonte C.4 — TraderRetrospectiveService.
//
// Cron daily 02:00 UTC : analyse les trades TRADER (b0000001-...) clos
// la veille (UTC). Si trades_count >= 5, appelle Gemini Pro pour dériver
// des lessons scope='trader_agent_only' qui seront réinjectées dans le
// system prompt du trader-agent au cycle suivant via
// ScannerLessonsContextService.
//
// Différent de MainScannerPostMortemService (cron 02:30 UTC, scope MAIN/
// HIGH/MIDDLE/SMALL gainers) : ici on couvre l'angle mort TRADER qui
// avait été identifié dans la conversation initiale ("rien n'auto-enrichit
// les lessons trader_agent_only").
//
// Différent de StrategyCoachService (cron horaire forward-looking,
// propose lessons à valider par user) : ici c'est backward-looking,
// dérive des observations factuelles des trades passés, persiste
// directement avec is_active=true (user peut désactiver via Lessons mgmt
// B.3 si besoin).

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';

const TRADER_AGENT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';

const SYSTEM_PROMPT = `Tu es Trader Retrospective Analyst.

Ton rôle : analyser les trades de la veille du portfolio TRADER (agent autonome Gemini Pro) et dériver des règles actionnables ("lessons") pour améliorer les décisions futures.

Tu reçois en input un JSON contenant :
- yesterday_date
- trades[] : array de trades avec symbol, asset_class, entry/exit, pnl_usd, pnl_pct, hold_minutes, exit_reason, asset_class, hour_utc, entry_thesis_excerpt
- stats : total, wins, losses, win_rate, sum_pnl, avg_pnl, biggest_win, biggest_loss
- by_exit_reason : distribution count + pnl par exit_reason
- by_hour : distribution count + pnl par heure UTC
- top_lessons_cited_yesterday : markers cités hier + leur outcome (win-rate, sum_pnl)

Ta sortie doit être un JSON strict :
{
  "summary": "<2-3 phrases — quoi marche / quoi marche pas hier>",
  "lessons": [
    {
      "lesson_kind": "<UPPER_SNAKE_CASE>",
      "lesson_text": "Quand <CONDITION OBSERVABLE>, alors <ACTION CONCRÈTE>",
      "confidence": <0..1>,
      "macro_condition": "<ex: VIX>22 / ASIA_SESSION / FRIDAY_LAST_HOUR>" | null,
      "sample_size": <int — combien de trades supportent cette lesson>,
      "win_rate_observed": <0..100 — sur ces N trades>,
      "avg_pnl_usd": <number>,
      "rationale": "<1-2 phrases>"
    }
  ],
  "lessons_to_invalidate": [
    {
      "lesson_kind_pattern": "<UPPER_SNAKE_CASE ou pattern ILIKE>",
      "reason": "<2-3 phrases — pourquoi cette lesson a fait perdre>"
    }
  ]
}

Règles :
- sample_size minimum 3 pour qu'une lesson soit retenue (sinon DROP)
- confidence ≤ 0.7 par défaut (lesson dérivée d'un seul jour reste tentative)
- macro_condition obligatoire si la lesson dépend d'un contexte (sinon null)
- lesson_text actionnable et observable au moment de la décision (pas "éviter symboles qui vont perdre")
- Maximum 3 lessons + 2 invalidations par run
- Si trades_count < 5, retourne lessons=[] (insuffisant statistiquement)
- Réponds UNIQUEMENT le JSON, pas de markdown ni explication hors JSON`;

@Injectable()
export class TraderRetrospectiveService {
  private readonly logger = new Logger(TraderRetrospectiveService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('TRADER_RETROSPECTIVE_ENABLED') ?? 'true').toLowerCase() === 'true';
    if (!this.enabled) {
      this.logger.log('[trader-retrospective] disabled via TRADER_RETROSPECTIVE_ENABLED=false');
      return;
    }
    try {
      // 02:00 UTC : avant MainScannerPostMortem (02:30) pour répartir le coût Gemini Pro
      const job = new CronJob('0 2 * * *', () => {
        this.runRetrospective().catch((e) =>
          this.logger.error(`[trader-retrospective] cron failed: ${String(e).slice(0, 200)}`),
        );
      });
      this.schedulerRegistry.addCronJob('trader-retrospective-daily', job);
      job.start();
      this.logger.log('[trader-retrospective] ENABLED — cron 02:00 UTC daily');
    } catch (e) {
      this.logger.error(`[trader-retrospective] cron register failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Exécutable manuellement (admin endpoint si wiré) ou via cron.
   * Retourne stats { tradesAnalyzed, lessonsPersisted, invalidations, costUsd, error? }.
   */
  async runRetrospective(): Promise<{
    tradesAnalyzed: number;
    lessonsPersisted: number;
    invalidations: number;
    costUsd: number;
    error?: string;
  }> {
    if (!this.supabase.isReady() || !this.llmRouter.isEnabled()) {
      return { tradesAnalyzed: 0, lessonsPersisted: 0, invalidations: 0, costUsd: 0, error: 'supabase or llm router not ready' };
    }

    const client = this.supabase.getClient();
    const now = new Date();
    const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const yesterdayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // 1. Trades clos hier
    const { data: closed } = await client
      .from('lisa_positions')
      .select('symbol, asset_class, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, entry_timestamp, exit_timestamp')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .neq('status', 'open')
      .gte('exit_timestamp', yesterdayStart.toISOString())
      .lt('exit_timestamp', yesterdayEnd.toISOString())
      .order('exit_timestamp', { ascending: true });
    const trades = closed ?? [];

    if (trades.length < 5) {
      this.logger.log(`[trader-retrospective] only ${trades.length} trades yesterday, skip (need >= 5)`);
      return { tradesAnalyzed: trades.length, lessonsPersisted: 0, invalidations: 0, costUsd: 0 };
    }

    // 2. Stats + distributions
    const stats = this.computeStats(trades as Array<Record<string, unknown>>);
    const byExitReason = this.distByExitReason(trades as Array<Record<string, unknown>>);
    const byHour = this.distByHour(trades as Array<Record<string, unknown>>);

    // 3. Top lessons cited hier + leur outcome
    const { data: citations } = await client
      .from('scanner_lesson_citations')
      .select('marker_text, action_applied, outcome_pnl_usd, outcome_win')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('cited_at', yesterdayStart.toISOString())
      .lt('cited_at', yesterdayEnd.toISOString())
      .limit(2000);
    const topLessonsCited = this.aggregateCitations((citations ?? []) as Array<Record<string, unknown>>);

    // 4. Thesis excerpts (50 derniers décisions hier)
    const { data: theses } = await client
      .from('trader_agent_decisions')
      .select('decided_at, action_kind, target_symbol, thesis')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('decided_at', yesterdayStart.toISOString())
      .lt('decided_at', yesterdayEnd.toISOString())
      .order('decided_at', { ascending: false })
      .limit(50);

    // 5. Build context + call Gemini Pro
    const context = {
      yesterday_date: yesterdayStart.toISOString().slice(0, 10),
      trades: (trades as Array<Record<string, unknown>>).map((t) => this.formatTrade(t, theses ?? [])),
      stats,
      by_exit_reason: byExitReason,
      by_hour: byHour,
      top_lessons_cited_yesterday: topLessonsCited,
    };

    const start = Date.now();
    let res: { content: string; providerId: string; costUsd: number; latencyMs: number };
    try {
      res = await this.llmRouter.callWithPro({
        system: SYSTEM_PROMPT,
        user: JSON.stringify(context, null, 2),
        maxTokens: 2048,
        temperature: 0.3,
      });
    } catch (e) {
      const msg = String(e).slice(0, 200);
      this.logger.error(`[trader-retrospective] LLM err: ${msg}`);
      return { tradesAnalyzed: trades.length, lessonsPersisted: 0, invalidations: 0, costUsd: 0, error: msg };
    }
    const latencyMs = Date.now() - start;

    const parsed = this.parseJsonStrict(res.content);
    if (!parsed) {
      this.logger.warn('[trader-retrospective] unparseable JSON');
      return { tradesAnalyzed: trades.length, lessonsPersisted: 0, invalidations: 0, costUsd: res.costUsd, error: 'unparseable' };
    }

    // 6. INSERT lessons
    const lessonsToInsert = Array.isArray(parsed.lessons) ? parsed.lessons : [];
    const validLessons = lessonsToInsert.filter((l: Record<string, unknown>) => {
      const sample = Number(l.sample_size ?? 0);
      return sample >= 3 && typeof l.lesson_kind === 'string' && typeof l.lesson_text === 'string';
    });
    let lessonsPersisted = 0;
    if (validLessons.length > 0) {
      const rows = validLessons.slice(0, 3).map((l: Record<string, unknown>) => ({
        derived_from_date: context.yesterday_date,
        lesson_kind: String(l.lesson_kind),
        lesson_text: String(l.lesson_text),
        macro_condition: l.macro_condition ? String(l.macro_condition) : null,
        scope: 'trader_agent_only',
        confidence: Math.min(Math.max(Number(l.confidence ?? 0.5), 0), 1),
        sample_size: Number(l.sample_size ?? 0),
        win_rate_observed: l.win_rate_observed !== undefined ? Number(l.win_rate_observed) : null,
        avg_pnl_usd: l.avg_pnl_usd !== undefined ? Number(l.avg_pnl_usd) : null,
        is_active: true,
        applied: false,
        payload: {
          source: 'trader_retrospective',
          rationale: l.rationale ?? null,
          provider: res.providerId,
        },
      }));
      const { error: insErr } = await client.from('scanner_lessons').insert(rows);
      if (insErr) {
        this.logger.warn(`[trader-retrospective] insert err: ${insErr.message}`);
      } else {
        lessonsPersisted = rows.length;
      }
    }

    // 7. Invalidations (UPDATE is_active=false WHERE lesson_kind ILIKE pattern AND scope='trader_agent_only')
    const invals = Array.isArray(parsed.lessons_to_invalidate) ? parsed.lessons_to_invalidate : [];
    let invalidations = 0;
    for (const inv of invals.slice(0, 2) as Array<Record<string, unknown>>) {
      const pattern = String(inv.lesson_kind_pattern ?? '').trim();
      if (!pattern) continue;
      const { error: updErr, count } = await client
        .from('scanner_lessons')
        .update({ is_active: false }, { count: 'exact' })
        .eq('scope', 'trader_agent_only')
        .eq('is_active', true)
        .ilike('lesson_kind', `%${pattern}%`);
      if (updErr) {
        this.logger.warn(`[trader-retrospective] invalidate err: ${updErr.message}`);
      } else if (count) {
        invalidations += count;
      }
    }

    // 8. Audit
    await client.from('lisa_decision_log').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      kind: 'trader_retrospective_complete',
      payload: {
        yesterday_date: context.yesterday_date,
        trades_analyzed: trades.length,
        lessons_persisted: lessonsPersisted,
        invalidations,
        cost_usd: res.costUsd,
        latency_ms: latencyMs,
        provider: res.providerId,
        summary: parsed.summary ?? null,
      },
    });

    this.logger.log(
      `[trader-retrospective] done trades=${trades.length} lessons=${lessonsPersisted} invalidations=${invalidations} cost=$${res.costUsd.toFixed(4)}`,
    );
    return {
      tradesAnalyzed: trades.length,
      lessonsPersisted,
      invalidations,
      costUsd: res.costUsd,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private computeStats(trades: Array<Record<string, unknown>>) {
    const pnls = trades.map((t) => Number(t.realized_pnl_usd ?? 0));
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    const sum = pnls.reduce((s, p) => s + p, 0);
    return {
      total: trades.length,
      wins,
      losses,
      win_rate_pct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      sum_pnl_usd: sum,
      avg_pnl_usd: trades.length > 0 ? sum / trades.length : 0,
      biggest_win_usd: pnls.length ? Math.max(...pnls) : 0,
      biggest_loss_usd: pnls.length ? Math.min(...pnls) : 0,
    };
  }

  private distByExitReason(trades: Array<Record<string, unknown>>) {
    const map: Record<string, { count: number; sum_pnl: number }> = {};
    for (const t of trades) {
      const r = String(t.exit_reason ?? 'unknown');
      if (!map[r]) map[r] = { count: 0, sum_pnl: 0 };
      map[r].count += 1;
      map[r].sum_pnl += Number(t.realized_pnl_usd ?? 0);
    }
    return map;
  }

  private distByHour(trades: Array<Record<string, unknown>>) {
    const map: Record<number, { count: number; sum_pnl: number }> = {};
    for (const t of trades) {
      const exitTs = String(t.exit_timestamp ?? '');
      if (!exitTs) continue;
      const hr = new Date(exitTs).getUTCHours();
      if (!map[hr]) map[hr] = { count: 0, sum_pnl: 0 };
      map[hr].count += 1;
      map[hr].sum_pnl += Number(t.realized_pnl_usd ?? 0);
    }
    return map;
  }

  private aggregateCitations(citations: Array<Record<string, unknown>>) {
    const map = new Map<string, { marker: string; citations: number; applied: number; wins: number; losses: number; sum_pnl: number }>();
    for (const c of citations) {
      const key = String(c.marker_text ?? '?');
      let b = map.get(key);
      if (!b) { b = { marker: key, citations: 0, applied: 0, wins: 0, losses: 0, sum_pnl: 0 }; map.set(key, b); }
      b.citations += 1;
      if (c.action_applied) b.applied += 1;
      if (c.outcome_win === true) b.wins += 1;
      if (c.outcome_win === false) b.losses += 1;
      b.sum_pnl += Number(c.outcome_pnl_usd ?? 0);
    }
    return [...map.values()].sort((a, b) => b.citations - a.citations).slice(0, 10);
  }

  private formatTrade(t: Record<string, unknown>, theses: Array<Record<string, unknown>>) {
    const entryTs = String(t.entry_timestamp ?? '');
    const exitTs = String(t.exit_timestamp ?? '');
    const holdMin = entryTs && exitTs
      ? Math.round((new Date(exitTs).getTime() - new Date(entryTs).getTime()) / 60000)
      : null;
    const sym = String(t.symbol ?? '');
    // Trouve la thesis la plus proche de entry_timestamp pour ce symbol (dans 10min)
    const entryMs = new Date(entryTs).getTime();
    const matchedThesis = theses.find((th) => {
      if (String(th.target_symbol ?? '') !== sym) return false;
      const decMs = new Date(String(th.decided_at ?? '')).getTime();
      return Math.abs(decMs - entryMs) < 10 * 60_000;
    });
    return {
      symbol: sym,
      asset_class: t.asset_class ?? null,
      pnl_usd: Number(t.realized_pnl_usd ?? 0),
      pnl_pct: Number(t.realized_pnl_pct ?? 0),
      hold_minutes: holdMin,
      exit_reason: String(t.exit_reason ?? '').slice(0, 100),
      hour_utc: exitTs ? new Date(exitTs).getUTCHours() : null,
      entry_thesis_excerpt: matchedThesis ? String(matchedThesis.thesis ?? '').slice(0, 200) : null,
    };
  }

  private parseJsonStrict(raw: string): Record<string, unknown> | null {
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
