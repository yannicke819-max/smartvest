/**
 * LiveTraderAgentService — Trader autonome piloté par Gemini Pro.
 *
 * Portfolio dédié : "Trader Agent" (b0000001-...) — capital $10k.
 * Cron 5 min : Gemini Pro reçoit l'état complet (positions, market state,
 * candidats scanner, macro, news fraîches, mémoire des lessons) et retourne
 * une décision JSON structurée (open / close / scale_in / trail / hold).
 *
 * Cron 02:00 UTC : NightlyPostMortem — Gemini Pro analyse les 24h passées,
 * génère 5 nouvelles lessons → injectées dans la system prompt du lendemain.
 * Apprentissage continu.
 *
 * Gating ENV :
 *   - LIVE_TRADER_AGENT_ENABLED=true (default OFF — safe MVP)
 *   - SCANNER_LLM_ROUTER_ENABLED=true (chain Gemini)
 *   - GEMINI_API_KEY défini
 *
 * Safety bounds :
 *   - Max daily loss $500 → kill 24h (auto-restart minuit UTC)
 *   - Max concentration 30% capital sur 1 symbole
 *   - Correlation cap : refuse 4ème position si 3 corrélées > 0.7
 *   - Confidence min 0.65 (sinon skip + log)
 *   - Sanity check prix : si Gemini propose entry > 2% du live → refuse
 *   - Notional clamp $50 ≤ N ≤ $3000 (max 30% du capital $10k)
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LisaService } from './lisa.service';

const TRADER_AGENT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';
const TRADER_AGENT_USER_ID = '5f164201-9736-4867-8756-a1653d65fd1c';
const TRADER_AGENT_CAPITAL_USD = 10000;
const MAX_DAILY_LOSS_USD = 500;
const MAX_CONCENTRATION_USD = 3000;  // 30% capital
const MIN_NOTIONAL_USD = 50;
const MIN_CONFIDENCE = 0.65;
const PRICE_SANITY_MAX_DIVERGENCE_PCT = 2.0;

type TraderAction =
  | 'open_directional'
  | 'open_pairs'
  | 'close'
  | 'scale_in'
  | 'trail_stop'
  | 'hold';

interface TraderDecision {
  action_kind: TraderAction;
  symbol?: string;
  symbol_short?: string;  // pour open_pairs
  direction?: 'long' | 'short';
  notional_usd?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  horizon_minutes?: number;
  thesis: string;
  confidence: number;
  expected_pnl_usd?: number;
  max_loss_usd?: number;
}

const SYSTEM_PROMPT_BASE = `Tu es un trader intraday professionnel autonome qui pilote un portfolio paper-trading de $10000 sur SmartVest. Ton mandat : générer $200/jour de PnL net (après fees Binance/broker ~0.20% round-trip). Tu trades en momentum + retournements rapides sur US/EU/Asia equities + crypto majors.

ACTIONS DISPONIBLES (action_kind) :
- "open_directional" : ouvrir une position simple (long ou short) sur 1 ticker
- "open_pairs" : pair trade long A + short B (market neutral, capter alpha sans beta)
- "close" : fermer une position ouverte par symbole
- "scale_in" : augmenter taille d'une position existante (max +50% sizing)
- "trail_stop" : ajuster le SL d'une position ouverte (vers breakeven ou profit lock)
- "hold" : rien à faire ce cycle (état OK ou trop tôt pour conclure)

CONTRAINTES DURES (les viole pas) :
1. Notional par trade : $50 ≤ N ≤ $3000 (30% capital max sur 1 symbole)
2. Stop loss obligatoire pour tout open : 0.5% ≤ SL ≤ 3% selon volatility
3. Take profit obligatoire : 0.8% ≤ TP ≤ 5% (R/R ≥ 1.2 minimum, idéalement ≥ 2)
4. Confidence ≥ 0.65 pour qu'on agisse (sinon hold)
5. Pas plus de 5 positions ouvertes simultanément
6. Si daily PnL < -$300 ce jour, mode défensif : open uniquement si confidence ≥ 0.85
7. Pour les shorts : confirmer setup retournement clair (RSI > 70, distribution candle, level résistance majeur)

RÉPONSE JSON OBLIGATOIRE (1 seul objet, pas de markdown) :
{
  "action_kind": "open_directional|open_pairs|close|scale_in|trail_stop|hold",
  "symbol": "TICKER.US (si open/close/scale/trail)",
  "symbol_short": "TICKER si open_pairs",
  "direction": "long|short",
  "notional_usd": 1500,
  "stop_loss_pct": 1.2,
  "take_profit_pct": 2.5,
  "horizon_minutes": 60,
  "thesis": "1-3 phrases citant les chiffres concrets",
  "confidence": 0.75,
  "expected_pnl_usd": 30,
  "max_loss_usd": 18
}

Sois rigoureux, conservateur, sceptique. Mieux vaut 5 holds qu'1 mauvais trade.`;

@Injectable()
export class LiveTraderAgentService {
  private readonly logger = new Logger(LiveTraderAgentService.name);
  private enabled = false;
  private dailyKillUntil: number | null = null;  // timestamp epoch ms

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly llmRouter: ScannerLlmRouterService,
    private readonly lisa: LisaService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('LIVE_TRADER_AGENT_ENABLED') ?? 'false')
      .toLowerCase() === 'true';
    if (this.enabled) {
      this.logger.log(
        `[trader-agent] ENABLED — portfolio=${TRADER_AGENT_PORTFOLIO_ID.slice(0, 8)} capital=$${TRADER_AGENT_CAPITAL_USD} cron */5min`,
      );
    }
  }

  /**
   * Cron 5 min — boucle principale de décision Gemini Pro.
   */
  @Cron('*/5 * * * *', { name: 'live-trader-agent-decision', timeZone: 'UTC' })
  async runDecisionCycle(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) {
      this.logger.warn('[trader-agent] LLM router disabled, skip cycle');
      return;
    }

    // Daily kill-switch check
    if (this.dailyKillUntil !== null && Date.now() < this.dailyKillUntil) {
      this.logger.debug(`[trader-agent] daily kill active until ${new Date(this.dailyKillUntil).toISOString()}`);
      return;
    }
    if (this.dailyKillUntil !== null && Date.now() >= this.dailyKillUntil) {
      this.logger.log('[trader-agent] daily kill expired, resuming');
      this.dailyKillUntil = null;
    }

    const cycleStartedAt = new Date();
    try {
      // 1. Read state (positions, capital, daily PnL)
      const state = await this.readState();

      // 2. Check daily loss limit
      if (state.dailyPnlUsd < -MAX_DAILY_LOSS_USD) {
        this.logger.warn(
          `[trader-agent] daily PnL $${state.dailyPnlUsd.toFixed(2)} < -$${MAX_DAILY_LOSS_USD} — kill 24h`,
        );
        this.dailyKillUntil = Date.now() + 24 * 60 * 60_000;
        await this.logDecision({
          cycleStartedAt, state, action: 'hold' as const,
          notionalUsd: 0, confidence: 0,
          thesis: `Daily loss limit -$${MAX_DAILY_LOSS_USD} crossed (pnl=$${state.dailyPnlUsd.toFixed(2)}). Kill 24h activated.`,
          applied: false,
          actionKindOverride: 'skip_safety_bound',
        });
        return;
      }

      // 3. Fetch candidates + macro + news + memory
      const [candidates, macro, news, memory] = await Promise.all([
        this.fetchTopCandidates(20),
        this.fetchMacroContext(),
        this.fetchRecentNews(10),
        this.fetchActiveMemory(50),
      ]);

      // 4. Build system + user prompts
      const systemPrompt = this.buildSystemPrompt(memory);
      const userPrompt = JSON.stringify({
        current_time_utc: cycleStartedAt.toISOString(),
        portfolio_capital_usd: TRADER_AGENT_CAPITAL_USD,
        state,
        candidates,
        macro,
        news_recent: news,
        constraints: {
          max_concentration_usd: MAX_CONCENTRATION_USD,
          max_open_positions: 5,
          min_notional_usd: MIN_NOTIONAL_USD,
          daily_loss_limit_usd: MAX_DAILY_LOSS_USD,
        },
      }, null, 2);

      // 5. Call Gemini Pro
      let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
      try {
        response = await this.llmRouter.call({
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.3,
          maxTokens: 1000,
          timeoutMs: 15_000,
        });
      } catch (e) {
        this.logger.warn(`[trader-agent] LLM call failed: ${String(e).slice(0, 150)}`);
        return;
      }

      // 6. Parse decision
      let decision: TraderDecision;
      try {
        const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        decision = JSON.parse(cleaned);
      } catch (e) {
        this.logger.warn(`[trader-agent] parse JSON failed: ${String(e).slice(0, 150)} — raw: ${response.content.slice(0, 200)}`);
        return;
      }

      // 7. Apply decision with safety bounds
      const applyResult = await this.applyDecision(decision, state);

      // 8. Log everything
      await this.logDecision({
        cycleStartedAt, state, decision,
        candidates, macro, news, memory,
        rawResponse: response.content,
        provider: response.providerId,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd,
        action: decision.action_kind,
        notionalUsd: decision.notional_usd ?? 0,
        confidence: decision.confidence,
        thesis: decision.thesis,
        applied: applyResult.applied,
        ...(applyResult.positionId !== undefined ? { appliedPositionId: applyResult.positionId } : {}),
        ...(applyResult.error !== undefined ? { applyError: applyResult.error } : {}),
      });

      const tag = applyResult.applied ? '✅' : (decision.action_kind === 'hold' ? '⏸️' : '⚠️');
      this.logger.log(
        `[trader-agent] ${tag} ${decision.action_kind} ${decision.symbol ?? ''} conf=${decision.confidence?.toFixed(2)} — ${decision.thesis?.slice(0, 80) ?? ''}`,
      );
    } catch (e) {
      this.logger.error(`[trader-agent] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Cron 02:00 UTC — post-mortem nightly + génération nouvelles lessons.
   */
  @Cron('0 2 * * *', { name: 'live-trader-agent-post-mortem', timeZone: 'UTC' })
  async runNightlyPostMortem(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    if (!this.llmRouter.isEnabled()) return;

    const yesterdayStart = new Date(Date.now() - 24 * 60 * 60_000);
    this.logger.log(`[trader-agent:post-mortem] running for window ${yesterdayStart.toISOString()} → now`);

    try {
      // Récupère décisions + positions des dernières 24h
      const { data: decisions } = await this.supabase.getClient()
        .from('trader_agent_decisions')
        .select('decided_at, action_kind, target_symbol, direction, confidence, thesis, action_applied, gemini_parsed')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .gte('decided_at', yesterdayStart.toISOString())
        .order('decided_at', { ascending: true });

      const { data: positions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, direction, entry_price, exit_price, entry_timestamp, exit_timestamp, status, realized_pnl_usd, exit_reason')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .gte('entry_timestamp', yesterdayStart.toISOString())
        .order('entry_timestamp', { ascending: true });

      if ((decisions?.length ?? 0) === 0 && (positions?.length ?? 0) === 0) {
        this.logger.log('[trader-agent:post-mortem] no activity in last 24h, skip');
        return;
      }

      // Boucle d'apprentissage CROSS-PORTFOLIO — feed le post-mortem avec :
      // 1. Les 4 derniers market_close_reports (Asia/EU/US/wrap) → comparatif 5 portfolios
      // 2. Le PnL de chaque shadow et du main pour la même journée → context "ce que les autres ont fait"
      // Le trader agent apprend non seulement de SES trades mais aussi de la perf relative.
      const { data: closeReports } = await this.supabase.getClient()
        .from('market_close_reports')
        .select('session_kind, captured_at, portfolio_breakdown, total_net_pnl_usd, winner_portfolio_id, loser_portfolio_id, ai_narrative')
        .gte('captured_at', yesterdayStart.toISOString())
        .order('captured_at', { ascending: true });

      // Compute daily comparative summary direct from positions (cross-portfolio)
      const PORTFOLIO_NAMES: Record<string, string> = {
        '58439d86-3f20-4a60-82a4-307f3f252bc2': 'main',
        'a0000001-0000-0000-0000-000000000001': 'shadow_high',
        'a0000002-0000-0000-0000-000000000002': 'shadow_middle',
        'a0000003-0000-0000-0000-000000000003': 'shadow_small',
        [TRADER_AGENT_PORTFOLIO_ID]: 'trader_agent (SELF)',
      };
      const { data: allClosed } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('portfolio_id, symbol, direction, realized_pnl_usd, exit_reason')
        .in('portfolio_id', Object.keys(PORTFOLIO_NAMES))
        .gte('exit_timestamp', yesterdayStart.toISOString())
        .neq('status', 'open');

      const dailyByPortfolio: Record<string, { name: string; closed: number; wins: number; gross_pnl: number; symbols: string[] }> = {};
      for (const pid of Object.keys(PORTFOLIO_NAMES)) {
        dailyByPortfolio[pid] = { name: PORTFOLIO_NAMES[pid], closed: 0, wins: 0, gross_pnl: 0, symbols: [] };
      }
      for (const p of (allClosed ?? [])) {
        const pid = String(p.portfolio_id);
        if (!dailyByPortfolio[pid]) continue;
        const pnl = Number(p.realized_pnl_usd ?? 0);
        dailyByPortfolio[pid].closed++;
        if (pnl > 0) dailyByPortfolio[pid].wins++;
        dailyByPortfolio[pid].gross_pnl += pnl;
        if (!dailyByPortfolio[pid].symbols.includes(p.symbol as string)) {
          dailyByPortfolio[pid].symbols.push(p.symbol as string);
        }
      }

      const postMortemPrompt = `Tu es un coach trader senior. Analyse la journée du Trader Agent (portfolio $10k Gemini Pro autonome) ET le comparatif des 5 portfolios paper (main + 3 shadows + trader_agent).

OBJECTIF : générer 5 lessons concrètes pour DOPER l'apprentissage du Trader Agent. Les lessons doivent :
1. Identifier ce que LE TRADER AGENT a fait de BIEN (à reproduire)
2. Identifier ce que LE TRADER AGENT a fait de MAL (à éviter)
3. **Apprendre des AUTRES portfolios** : "shadow_X a fait +$Y avec stratégie Z, le trader agent aurait dû..."
4. Référencer les market_close_reports (Asia/EU/US sessions) pour contextualiser
5. Être actionable : "Quand le contexte est X, fais Y" (pas "il faut être prudent")

RÉPONSE JSON OBLIGATOIRE :
{
  "summary": "1-2 phrases résumé journée trader_agent vs autres portfolios",
  "trader_agent_daily_pnl_usd": <nombre net total>,
  "winning_patterns": ["pattern 1 avec chiffres", "pattern 2", ...],
  "losing_patterns": ["pattern 1 avec chiffres", "pattern 2", ...],
  "cross_portfolio_insights": ["X a battu Y de $Z grâce à...", ...],
  "new_lessons": [
    {"lesson_kind": "winning_pattern|losing_pattern|risk_observation|market_regime_rule|sizing_rule|cross_portfolio_insight", "lesson_text": "Quand X, fais Y (référence: Z trades observés)", "confidence": 0.0-1.0}
  ]
}`;

      const userPayload = JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        trader_agent_decisions: decisions ?? [],
        trader_agent_positions: positions ?? [],
        cross_portfolio_daily_summary: dailyByPortfolio,
        market_close_reports_today: closeReports ?? [],
      }, null, 2);

      const response = await this.llmRouter.call({
        system: postMortemPrompt,
        user: userPayload,
        temperature: 0.4,
        maxTokens: 1500,
        timeoutMs: 30_000,
      });

      const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const newLessons = parsed.new_lessons as Array<{ lesson_kind: string; lesson_text: string; confidence: number }>;

      if (!Array.isArray(newLessons) || newLessons.length === 0) {
        this.logger.warn('[trader-agent:post-mortem] no lessons returned');
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      for (const l of newLessons) {
        await this.supabase.getClient().from('trader_agent_memory').insert({
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          lesson_kind: l.lesson_kind,
          lesson_text: l.lesson_text,
          confidence: l.confidence,
          derived_from_date: today,
          payload: { summary: parsed.summary, winning: parsed.winning_patterns, losing: parsed.losing_patterns },
        });
      }
      this.logger.log(`[trader-agent:post-mortem] persisted ${newLessons.length} new lessons`);
    } catch (e) {
      this.logger.warn(`[trader-agent:post-mortem] failed: ${String(e).slice(0, 200)}`);
    }
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  private async readState(): Promise<{
    openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }>;
    openCount: number;
    deployedUsd: number;
    capitalAvailableUsd: number;
    dailyPnlUsd: number;
    closedTodayCount: number;
    winRateTodayPct: number | null;
  }> {
    const client = this.supabase.getClient();
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;

    const { data: open } = await client
      .from('lisa_positions')
      .select('symbol, direction, entry_price, entry_notional_usd, entry_timestamp')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('status', 'open');

    const { data: closed } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('exit_timestamp', todayStart)
      .neq('status', 'open');

    const openPositions = (open ?? []).map((p) => ({
      symbol: p.symbol as string,
      direction: p.direction as string,
      entry_price: Number(p.entry_price),
      entry_notional_usd: Number(p.entry_notional_usd ?? 0),
      entry_timestamp: p.entry_timestamp as string,
    }));
    const deployed = openPositions.reduce((s, p) => s + p.entry_notional_usd, 0);
    const dailyPnl = (closed ?? []).reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const wins = (closed ?? []).filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length;
    const winRate = (closed?.length ?? 0) > 0 ? (wins / closed!.length) * 100 : null;

    return {
      openPositions,
      openCount: openPositions.length,
      deployedUsd: deployed,
      capitalAvailableUsd: TRADER_AGENT_CAPITAL_USD - deployed,
      dailyPnlUsd: dailyPnl,
      closedTodayCount: closed?.length ?? 0,
      winRateTodayPct: winRate,
    };
  }

  private async fetchTopCandidates(n: number): Promise<object[]> {
    // On lit le dernier snapshot global du scanner gainers (persistence_log)
    const { data } = await this.supabase.getClient()
      .from('gainers_persistence_log')
      .select('snapshot_json, summary, captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return [];
    const snap = typeof data.snapshot_json === 'string' ? JSON.parse(data.snapshot_json) : data.snapshot_json;
    const candidates = (snap?.candidates ?? []) as Array<Record<string, unknown>>;
    return candidates.slice(0, n).map((c) => ({
      symbol: c.symbol,
      assetClass: c.assetClass ?? c.asset_class,
      changePct: c.changePct,
      persistenceScore: c.persistenceScore,
      close: c.close,
    }));
  }

  private async fetchMacroContext(): Promise<object> {
    // Best-effort : si LisaService expose un cache macro, l'utiliser
    try {
      const cached = (this.lisa as unknown as { lastMarketSnapshot?: object }).lastMarketSnapshot;
      if (cached) return cached;
    } catch { /* ignore */ }
    return { note: 'macro_snapshot_unavailable_this_cycle' };
  }

  private async fetchRecentNews(n: number): Promise<object[]> {
    const since = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const { data } = await this.supabase.getClient()
      .from('eodhd_news_articles')
      .select('title, symbol, sentiment, source, published_at')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .limit(n);
    return (data ?? []) as object[];
  }

  private async fetchActiveMemory(n: number): Promise<Array<{ lesson_kind: string; lesson_text: string; confidence: number }>> {
    const { data } = await this.supabase.getClient()
      .from('trader_agent_memory')
      .select('lesson_kind, lesson_text, confidence')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('is_active', true)
      .order('confidence', { ascending: false })
      .limit(n);
    return (data ?? []) as Array<{ lesson_kind: string; lesson_text: string; confidence: number }>;
  }

  private buildSystemPrompt(memory: Array<{ lesson_kind: string; lesson_text: string; confidence: number }>): string {
    if (memory.length === 0) return SYSTEM_PROMPT_BASE;
    const lessonsBlock = memory
      .map((l, i) => `${i + 1}. [${l.lesson_kind}] ${l.lesson_text} (conf=${l.confidence})`)
      .join('\n');
    return `${SYSTEM_PROMPT_BASE}

LESSONS APPRISES (post-mortems précédents, ordre confidence descendant) :
${lessonsBlock}

Garde ces lessons en tête en priorité pour ta décision actuelle.`;
  }

  private async applyDecision(
    decision: TraderDecision,
    state: Awaited<ReturnType<typeof this.readState>>,
  ): Promise<{ applied: boolean; positionId?: string; error?: string }> {
    // Confidence gate
    if (decision.confidence < MIN_CONFIDENCE) {
      return { applied: false, error: `confidence ${decision.confidence} < ${MIN_CONFIDENCE}` };
    }

    if (decision.action_kind === 'hold') return { applied: false };

    if (decision.action_kind === 'open_directional') {
      if (state.openCount >= 5) return { applied: false, error: 'max 5 open positions' };
      if (!decision.symbol || !decision.direction || !decision.notional_usd) {
        return { applied: false, error: 'missing symbol/direction/notional' };
      }
      const notional = Math.max(MIN_NOTIONAL_USD, Math.min(MAX_CONCENTRATION_USD, decision.notional_usd));
      const slPct = Math.max(0.5, Math.min(3, decision.stop_loss_pct ?? 1.2));
      const tpPct = Math.max(0.8, Math.min(5, decision.take_profit_pct ?? 2.5));

      // Live price + sanity check
      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'invalid live price' };
      if (livePriceData.source && (String(livePriceData.source).startsWith('stale_') || String(livePriceData.source).startsWith('fallback'))) {
        return { applied: false, error: `price source unreliable: ${livePriceData.source}` };
      }

      const sign = decision.direction === 'short' ? -1 : 1;
      const stopLossPrice = (livePrice * (1 - sign * slPct / 100)).toFixed(6);
      const takeProfitPrice = (livePrice * (1 + sign * tpPct / 100)).toFixed(6);

      // Open via LisaService (qui wrappe paperBroker)
      try {
        const opened = await this.lisa.openForOpportunityScout({
          portfolioId: TRADER_AGENT_PORTFOLIO_ID,
          symbol: decision.symbol,
          assetClass: 'unknown',
          venue: 'paper',
          notionalUsd: notional,
          livePrice,
          stopLossPrice,
          takeProfitPrice,
          horizonDays: Math.ceil((decision.horizon_minutes ?? 60) / (60 * 24)),
          maxOpenPositions: 5,
          rationale: `[trader-agent] ${decision.thesis}`,
        });
        if (!opened) return { applied: false, error: 'openForOpportunityScout returned null (stale/fallback price ou skipped)' };
        return { applied: true, positionId: opened.id };
      } catch (e) {
        return { applied: false, error: String(e).slice(0, 200) };
      }
    }

    if (decision.action_kind === 'close') {
      // TODO future PR : close via paperBroker
      return { applied: false, error: 'close action not yet wired (follow-up PR)' };
    }

    if (decision.action_kind === 'open_pairs' || decision.action_kind === 'scale_in' || decision.action_kind === 'trail_stop') {
      return { applied: false, error: `${decision.action_kind} not yet wired (follow-up PR)` };
    }

    return { applied: false, error: `unknown action: ${decision.action_kind}` };
  }

  private async logDecision(p: {
    cycleStartedAt: Date;
    state: object;
    decision?: TraderDecision;
    candidates?: object[];
    macro?: object;
    news?: object[];
    memory?: object[];
    rawResponse?: string;
    provider?: string;
    latencyMs?: number;
    costUsd?: number;
    action: string;
    actionKindOverride?: string;
    notionalUsd: number;
    confidence: number;
    thesis: string;
    applied: boolean;
    appliedPositionId?: string;
    applyError?: string;
  }): Promise<void> {
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: p.cycleStartedAt.toISOString(),
      input_state: p.state,
      input_candidates: p.candidates ?? null,
      input_macro: p.macro ?? null,
      input_news_summary: p.news ?? null,
      input_memory_lessons: p.memory ?? null,
      gemini_raw_response: p.rawResponse ?? null,
      gemini_parsed: p.decision ?? null,
      gemini_provider: p.provider ?? null,
      gemini_latency_ms: p.latencyMs ?? null,
      gemini_cost_usd: p.costUsd ?? null,
      action_kind: p.actionKindOverride ?? p.action,
      target_symbol: p.decision?.symbol ?? null,
      direction: p.decision?.direction ?? null,
      notional_usd: p.notionalUsd,
      confidence: p.confidence,
      thesis: p.thesis,
      action_applied: p.applied,
      applied_position_id: p.appliedPositionId ?? null,
      apply_error: p.applyError ?? null,
    });
  }

  // ====================================================================
  // PUBLIC API — /admin/trader-agent/status
  // ====================================================================
  async getLatestStatus(): Promise<object> {
    const state = await this.readState();
    const { data: recentDecisions } = await this.supabase.getClient()
      .from('trader_agent_decisions')
      .select('decided_at, action_kind, target_symbol, direction, confidence, thesis, action_applied, apply_error')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .order('decided_at', { ascending: false })
      .limit(10);
    const { data: memory } = await this.supabase.getClient()
      .from('trader_agent_memory')
      .select('lesson_kind, lesson_text, confidence, derived_from_date')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('is_active', true)
      .order('confidence', { ascending: false })
      .limit(20);
    return {
      enabled: this.enabled,
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      capital_usd: TRADER_AGENT_CAPITAL_USD,
      daily_kill_until: this.dailyKillUntil ? new Date(this.dailyKillUntil).toISOString() : null,
      state,
      recent_decisions: recentDecisions ?? [],
      active_memory: memory ?? [],
    };
  }
}
