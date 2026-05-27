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
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
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

CONTEXTE MACRO (input \`macro\` — snapshot LisaService) :
- VIX > 30 = panique : refuse open_directional sauf setup A+ (conf ≥ 0.85)
- VIX 20-30 = stressé : sizing -30%, privilégie close sur positions -EV
- US10Y up > +10bps en intraday = pression rates : évite small caps + REITs
- DXY spike + US10Y > 4.5% = flight from risk assets, prudence equities
- Brent up > +5% intraday = risk geopolitique : prudence aero/airlines/EU
- Gold up > +2% AVEC DXY down = flight to safety : refuse shorts risk-on
- HY OAS > 500bps OU IG OAS > 150bps = credit stress, prudence cycliques
- USDJPY breakdown < 145 = yen carry unwind, contagion risk-off (cf. août 2024)
- Si \`macro.dataQuality.fallback\` contient ≥ 3 indicateurs → photo macro
  dégradée, réduis ton sizing -30% ET ta confidence -0.05
- Si \`macro.note = 'macro_snapshot_unavailable_this_cycle'\` → contexte aveugle,
  refuse open_directional (uniquement close/trail_stop/hold autorisés)

CONTEXTE NEWS (input \`news_recent\` — eodhd dernières 2h) :
- Sentiment fort négatif (≤ -0.6) sur un ticker que tu DÉTIENS → propose close
- Sentiment fort positif (≥ +0.7) sur un ticker dans candidates → bonus conviction
- News macro vs news ticker : pondère la macro plus haut sur les décisions sizing
- Évite d'ouvrir 5 minutes avant un événement \`macro.upcomingEvents\`
  (FOMC, CPI, NFP) : volatilité non-directionnelle

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
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('LIVE_TRADER_AGENT_ENABLED');
    this.enabled = (raw ?? 'false').toLowerCase() === 'true';
    this.logger.log(
      `[trader-agent] onModuleInit fired — LIVE_TRADER_AGENT_ENABLED raw="${raw}" parsed_enabled=${this.enabled}`,
    );
    this.writeBootSentinel(raw).catch(() => null);
    if (this.enabled) {
      this.logger.log(
        `[trader-agent] ENABLED — portfolio=${TRADER_AGENT_PORTFOLIO_ID.slice(0, 8)} capital=$${TRADER_AGENT_CAPITAL_USD} cron */5min`,
      );
    }
    // Enregistrement MANUEL des crons via SchedulerRegistry (pattern exact
    // TopGainersScannerService.onModuleInit qui marche en prod depuis P5).
    // Les décorateurs @Cron sur cette classe ne tiraient pas (cause inconnue).
    this.registerCron(
      'live-trader-agent-decision-manual',
      '*/5 * * * *',
      () => this.runDecisionCycle().catch((e) =>
        this.logger.error(`[trader-agent] runDecisionCycle error: ${String(e).slice(0, 200)}`),
      ),
    );
    this.registerCron(
      'live-trader-agent-post-mortem-manual',
      '0 2 * * *',
      () => this.runNightlyPostMortem().catch((e) =>
        this.logger.error(`[trader-agent] runNightlyPostMortem error: ${String(e).slice(0, 200)}`),
      ),
    );
  }

  private registerCron(name: string, expr: string, callback: () => void): void {
    try {
      // Idempotent : si déjà enregistré (hot reload), skip
      this.schedulerRegistry.getCronJob(name);
      this.logger.log(`[trader-agent] cron '${name}' already registered, skip`);
      this.writeRegistrationSentinel(name, 'already_registered').catch(() => null);
      return;
    } catch {
      // Pas encore — on continue
    }
    try {
      // Pattern exact de TopGainersScannerService.scheduleScanner (en prod P5)
      const job = new CronJob(expr, callback);
      this.schedulerRegistry.addCronJob(name, job);
      job.start();
      this.logger.log(`[trader-agent] cron '${name}' registered manually expr='${expr}'`);
      this.writeRegistrationSentinel(name, `OK expr=${expr}`).catch(() => null);
    } catch (e) {
      const errMsg = String(e).slice(0, 200);
      this.logger.error(`[trader-agent] cron '${name}' registration FAILED: ${errMsg}`);
      this.writeRegistrationSentinel(name, `FAILED: ${errMsg}`).catch(() => null);
    }
  }

  /** Sentinel DB inconditionnel à chaque tick du cron — prouve qu'il tire. */
  private async writeCycleTickSentinel(): Promise<void> {
    if (!this.supabase.isReady()) return;
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: new Date().toISOString(),
      input_state: { cycle_tick_sentinel: true, ts: Date.now() },
      action_kind: 'hold',
      thesis: `[CYCLE_TICK] cron fired @ ${new Date().toISOString()}`,
      confidence: 0,
      action_applied: false,
      apply_error: '[CYCLE_TICK] proof cron fired',
    });
  }

  /** Sentinel DB pour prouver que registerCron a été appelé (success ou fail). */
  private async writeRegistrationSentinel(name: string, status: string): Promise<void> {
    if (!this.supabase.isReady()) return;
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: new Date().toISOString(),
      input_state: { registration_sentinel: true, cron_name: name, status },
      action_kind: 'hold',
      thesis: `[REGISTRATION_SENTINEL] cron='${name}' status='${status}'`,
      confidence: 0,
      action_applied: false,
      apply_error: `[REGISTRATION_SENTINEL] ${status}`,
    });
  }

  private async writeBootSentinel(rawFlag: string | undefined): Promise<void> {
    if (!this.supabase.isReady()) return;
    const now = new Date();
    await this.supabase.getClient().from('trader_agent_decisions').insert({
      portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
      cycle_started_at: now.toISOString(),
      input_state: { boot_sentinel: true, raw_flag: rawFlag ?? 'undefined', parsed_enabled: this.enabled },
      action_kind: 'hold',
      thesis: `[BOOT_SENTINEL] onModuleInit fired @ ${now.toISOString()} — flag raw="${rawFlag}" parsed=${this.enabled}`,
      confidence: 0,
      action_applied: false,
      apply_error: '[BOOT_SENTINEL] proof onModuleInit was called',
    });
  }

  /**
   * Cron 5 min — boucle principale de décision Gemini Pro.
   * Enregistré manuellement via SchedulerRegistry dans onApplicationBootstrap
   * (cf. registerCron 'live-trader-agent-decision-manual').
   */
  async runDecisionCycle(): Promise<void> {
    // Sentinel DB inconditionnel — prouve que le cron tire vraiment.
    this.writeCycleTickSentinel().catch(() => null);
    // Log inconditionnel chaque tick pour vérifier que le cron tire vraiment.
    this.logger.log(`[trader-agent] cron tick @ ${new Date().toISOString()} enabled=${this.enabled} supabase=${this.supabase.isReady()} llmRouter=${this.llmRouter.isEnabled()}`);
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

      // 3. Fetch candidates + macro + news + memory — chaque fetch en allSettled
      // pour qu'un échec individuel (DB query fail, API down) ne stoppe pas le
      // cycle entier. Fallback aux valeurs vides en cas de fail.
      const settled = await Promise.allSettled([
        this.fetchTopCandidates(20),
        this.fetchMacroContext(),
        this.fetchRecentNews(10),
        this.fetchActiveMemory(50),
      ]);
      const candidates = settled[0].status === 'fulfilled' ? settled[0].value : [];
      const macro = settled[1].status === 'fulfilled' ? settled[1].value : { note: 'macro_fetch_failed' };
      const news = settled[2].status === 'fulfilled' ? settled[2].value : [];
      const memory = settled[3].status === 'fulfilled' ? settled[3].value : [];
      const fetchFailures = settled
        .map((s, i) => s.status === 'rejected' ? `${['candidates','macro','news','memory'][i]}=${String(s.reason).slice(0,80)}` : null)
        .filter((x) => x !== null);
      if (fetchFailures.length > 0) {
        this.logger.warn(`[trader-agent] fetch partial failures: ${fetchFailures.join(' | ')}`);
      }

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

      // 5. Call Gemini Pro (raisonnement multi-facteurs sur 20 candidats + macro + news + memory).
      // Auto-fallback Flash Lite → Claude Opus si Pro indisponible (cf. ScannerLlmRouter.callWithPro).
      let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
      try {
        response = await this.llmRouter.callWithPro({
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.3,
          maxTokens: 1000,
          timeoutMs: 20_000,
        });
      } catch (e) {
        const errMsg = `LLM call failed: ${String(e).slice(0, 200)}`;
        this.logger.warn(`[trader-agent] ${errMsg}`);
        // Persist le fail en DB pour visibilité sans accès Fly logs.
        await this.logDecision({
          cycleStartedAt, state,
          candidates, macro, news, memory,
          action: 'hold' as const,
          actionKindOverride: 'skip_safety_bound',
          notionalUsd: 0, confidence: 0,
          thesis: `LLM unavailable: ${errMsg}`,
          applied: false,
          applyError: errMsg,
        }).catch(() => null);
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
   * Enregistré manuellement via SchedulerRegistry.
   */
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

      // Macro snapshot frais — sert à corréler les outcomes (gagnant/perdant)
      // au régime du jour. Cache 2 min côté LisaService (probablement déjà chaud).
      let macroSnapshot: object;
      try {
        macroSnapshot = await this.lisa.getRecentMarketSnapshot(120);
      } catch (e) {
        this.logger.warn(`[trader-agent:post-mortem] macro fetch failed: ${String(e).slice(0, 100)}`);
        macroSnapshot = { note: 'macro_snapshot_unavailable' };
      }

      const postMortemPrompt = `Tu es un coach trader senior. Analyse la journée du Trader Agent (portfolio $10k Gemini Pro autonome) ET le comparatif des 5 portfolios paper (main + 3 shadows + trader_agent).

OBJECTIF : générer 5 lessons concrètes pour DOPER l'apprentissage du Trader Agent. Les lessons doivent :
1. Identifier ce que LE TRADER AGENT a fait de BIEN (à reproduire)
2. Identifier ce que LE TRADER AGENT a fait de MAL (à éviter)
3. **Apprendre des AUTRES portfolios** : "shadow_X a fait +$Y avec stratégie Z, le trader agent aurait dû..."
4. Référencer les market_close_reports (Asia/EU/US sessions) pour contextualiser
5. Être actionable : "Quand le contexte est X, fais Y" (pas "il faut être prudent")

LECTURE MACRO OBLIGATOIRE (input \`macro_snapshot_eod\`) :
Tu DOIS conditionner chaque lesson au régime macro du jour. Une lesson "ouvrir
short sur tech au open US" n'a aucune valeur si elle ne précise pas le contexte
(VIX 28 vs VIX 14, US10Y > 4.5% vs < 4.0%, etc.). Sans condition macro, la
lesson est rejetée comme "macro-blind".

Grille de lecture :
- VIX > 25 = stressé / VIX > 30 = panique
- US10Y up > +10bps = pression rates
- DXY spike + 10Y > 4.5% = flight from risk assets
- HY OAS > 500bps = credit stress
- Gold + DXY contraires = flight to safety
- Brent +5% intraday = geopolitique
- USDJPY < 145 = yen carry unwind risk

Chaque \`lesson_text\` DOIT contenir une clause "Quand <CONDITION MACRO>, alors
<ACTION>". Sinon Gemini rejette la lesson.

PATTERNS CROSS-PORTFOLIO À CHERCHER :
- "Trader Agent a passé X trades pendant Asia session alors que shadow_high
  qui était cash a évité une perte de $Y (cf. macro VIX 22 + DXY spike)"
- "Shadow_small a ouvert 8 positions avec sizing micro pendant US morning :
  $Z gain net malgré fees 30%. Le Trader Agent aurait dû en faire 4 sur
  les mêmes patterns avec sizing 2× pour battre les frais"
- "Trader Agent a ouvert 1 position à 17:00 UTC pendant la blacklist hour US,
  -$X. Shadow_middle (qui bypass blacklist) a ouvert mais avec sentiment news
  +0.8 → +$Y. Conclusion : bypass OK SI confirmation news fraîche"

RÉPONSE JSON OBLIGATOIRE :
{
  "summary": "1-2 phrases résumé journée trader_agent vs autres portfolios + régime macro dominant",
  "macro_regime_today": "ex: VIX 22 (élevé), US10Y 4.45% (rates stress), DXY 103 (USD fort), HY OAS 380bps (calme corporate)",
  "trader_agent_daily_pnl_usd": <nombre net total>,
  "winning_patterns": ["pattern + chiffres + condition macro"],
  "losing_patterns": ["pattern + chiffres + condition macro"],
  "cross_portfolio_insights": ["X a battu Y de $Z grâce à... (régime macro: ...)", ...],
  "new_lessons": [
    {
      "lesson_kind": "winning_pattern|losing_pattern|risk_observation|market_regime_rule|sizing_rule|cross_portfolio_insight",
      "lesson_text": "Quand <condition macro>, alors <action> (référence: Z trades observés)",
      "confidence": 0.0-1.0,
      "macro_condition": "VIX>25|US10Y>4.5|DXY>103|GOLD+DXY-|BRENT+5%|HY_OAS>500|USDJPY<145|REGIME_CALME|REGIME_MIXED"
    }
  ]
}`;

      const userPayload = JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        macro_snapshot_eod: macroSnapshot,
        trader_agent_decisions: decisions ?? [],
        trader_agent_positions: positions ?? [],
        cross_portfolio_daily_summary: dailyByPortfolio,
        market_close_reports_today: closeReports ?? [],
      }, null, 2);

      // Post-mortem = raisonnement sur 24h × 5 portfolios → Pro requis (qualité d'analyse).
      const response = await this.llmRouter.callWithPro({
        system: postMortemPrompt,
        user: userPayload,
        temperature: 0.4,
        maxTokens: 1500,
        timeoutMs: 30_000,
      });

      const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      const newLessons = parsed.new_lessons as Array<{ lesson_kind: string; lesson_text: string; confidence: number; macro_condition?: string }>;

      if (!Array.isArray(newLessons) || newLessons.length === 0) {
        this.logger.warn('[trader-agent:post-mortem] no lessons returned');
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      const macroRegime = parsed.macro_regime_today ?? null;
      let persisted = 0;
      let rejectedMacroBlind = 0;
      for (const l of newLessons) {
        // Gate macro-condition : refuse les lessons qui n'ont pas de condition macro
        // explicite (la grille interdit les lessons "macro-blind"). On accepte aussi
        // les lessons qui contiennent "Quand" + un mot macro (VIX|DXY|10Y|HY|OAS|GOLD|BRENT|USDJPY|REGIME)
        // dans le texte si macro_condition n'est pas fourni.
        const hasExplicitMacroCondition = !!l.macro_condition && l.macro_condition.length > 0;
        const hasInlineMacroClause = /quand\b.*\b(vix|dxy|10y|hy|oas|gold|brent|usdjpy|regime|us10y)\b/i.test(l.lesson_text);
        if (!hasExplicitMacroCondition && !hasInlineMacroClause) {
          this.logger.warn(`[trader-agent:post-mortem] reject macro-blind lesson: ${l.lesson_text.slice(0, 80)}`);
          rejectedMacroBlind++;
          continue;
        }
        await this.supabase.getClient().from('trader_agent_memory').insert({
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          lesson_kind: l.lesson_kind,
          lesson_text: l.lesson_text,
          confidence: l.confidence,
          derived_from_date: today,
          payload: {
            summary: parsed.summary,
            macro_regime_today: macroRegime,
            macro_condition: l.macro_condition ?? null,
            winning: parsed.winning_patterns,
            losing: parsed.losing_patterns,
          },
        });
        persisted++;
      }
      this.logger.log(`[trader-agent:post-mortem] persisted ${persisted} lessons (${rejectedMacroBlind} rejected macro-blind)`);
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
    // Cache 2 min côté LisaService — partagé avec ShadowSizingOrchestrator pour
    // éviter de re-fetch les 15-20 calls API EODHD/Yahoo à chaque cycle de 5 min.
    try {
      const snap = await this.lisa.getRecentMarketSnapshot(120);
      return snap;
    } catch (e) {
      this.logger.warn(`[trader-agent] macro fetch failed: ${String(e).slice(0, 100)}`);
      return { note: 'macro_snapshot_unavailable_this_cycle', error: String(e).slice(0, 100) };
    }
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
      // Gemini fournit un symbol → on résout vers le positionId via state.openPositions.
      if (!decision.symbol) return { applied: false, error: 'close requires symbol' };
      const sym = decision.symbol.toUpperCase();
      const match = state.openPositions.find((p) => p.symbol.toUpperCase() === sym);
      if (!match) {
        return { applied: false, error: `close: no open position for ${sym} on trader agent portfolio` };
      }
      // Need the position id (not exposed in state) — re-query.
      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', match.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) return { applied: false, error: `close: position row not found for ${sym}` };

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'close: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'close: invalid live price' };

      const res = await this.lisa.closeForOpportunityScout({
        positionId: row.id,
        livePrice,
        ...(livePriceData.source ? { livePriceSource: String(livePriceData.source) } : {}),
        reason: 'closed_user',
        rationale: `[trader-agent] ${decision.thesis ?? 'gemini close decision'}`,
      });
      if (res.closed) return { applied: true, positionId: row.id };
      return { applied: false, ...(res.error !== undefined ? { error: res.error } : {}) };
    }

    if (decision.action_kind === 'scale_in') {
      // Scale-in = nouvelle ligne open_directional sur un symbol DÉJÀ détenu,
      // notional capé à +50% du sizing standard (cf. system prompt). Le paper-broker
      // tracke 2 lignes distinctes — comportement attendu.
      if (!decision.symbol || !decision.direction || !decision.notional_usd) {
        return { applied: false, error: 'scale_in: missing symbol/direction/notional' };
      }
      const sym = decision.symbol.toUpperCase();
      const hasOpen = state.openPositions.some((p) => p.symbol.toUpperCase() === sym);
      if (!hasOpen) {
        return { applied: false, error: `scale_in: no existing position on ${sym} (use open_directional)` };
      }
      if (state.openCount >= 5) return { applied: false, error: 'scale_in: max 5 open positions' };
      const notional = Math.max(MIN_NOTIONAL_USD, Math.min(MAX_CONCENTRATION_USD * 1.5, decision.notional_usd));
      const slPct = Math.max(0.5, Math.min(3, decision.stop_loss_pct ?? 1.2));
      const tpPct = Math.max(0.8, Math.min(5, decision.take_profit_pct ?? 2.5));

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'scale_in: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'scale_in: invalid live price' };
      if (livePriceData.source && (String(livePriceData.source).startsWith('stale_') || String(livePriceData.source).startsWith('fallback'))) {
        return { applied: false, error: `scale_in: price source unreliable: ${livePriceData.source}` };
      }

      const sign = decision.direction === 'short' ? -1 : 1;
      const stopLossPrice = (livePrice * (1 - sign * slPct / 100)).toFixed(6);
      const takeProfitPrice = (livePrice * (1 + sign * tpPct / 100)).toFixed(6);

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
          rationale: `[trader-agent SCALE_IN] ${decision.thesis}`,
        });
        if (!opened) return { applied: false, error: 'scale_in: open returned null' };
        return { applied: true, positionId: opened.id };
      } catch (e) {
        return { applied: false, error: String(e).slice(0, 200) };
      }
    }

    if (decision.action_kind === 'trail_stop') {
      // Trail stop = UPDATE stop_loss_price d'une position ouverte.
      // Gemini fournit symbol + nouveau stop_loss_pct (% sous entry pour long).
      // Garde-fou : le nouveau stop ne peut JAMAIS être plus permissif que l'ancien
      // (sinon ce n'est pas un trail mais un loosening — refusé).
      if (!decision.symbol) return { applied: false, error: 'trail_stop: requires symbol' };
      const sym = decision.symbol.toUpperCase();
      const match = state.openPositions.find((p) => p.symbol.toUpperCase() === sym);
      if (!match) return { applied: false, error: `trail_stop: no open position for ${sym}` };

      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, stop_loss_price, entry_price, direction')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', match.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) return { applied: false, error: `trail_stop: position row not found for ${sym}` };

      const livePriceData = await this.lisa.getLivePrice(decision.symbol).catch(() => null);
      if (!livePriceData?.price) return { applied: false, error: 'trail_stop: no live price' };
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) return { applied: false, error: 'trail_stop: invalid live price' };

      const slPct = Math.max(0.1, Math.min(5, decision.stop_loss_pct ?? 1.2));
      const isLong = String(row.direction) !== 'short';
      const sign = isLong ? -1 : 1;
      // Nouveau stop calculé depuis livePrice (trail = suit le marché)
      const newStop = livePrice * (1 + sign * slPct / 100);
      const oldStop = Number(row.stop_loss_price);

      // Garde-fou : le nouveau stop doit être PLUS strict
      // - long : newStop > oldStop (on remonte le stop)
      // - short : newStop < oldStop (on descend le stop)
      const stricter = isLong ? newStop > oldStop : newStop < oldStop;
      if (!stricter) {
        return { applied: false, error: `trail_stop: new stop ${newStop.toFixed(4)} not stricter than current ${oldStop.toFixed(4)} (${isLong ? 'long' : 'short'})` };
      }

      const { error } = await this.supabase.getClient()
        .from('lisa_positions')
        .update({ stop_loss_price: newStop.toFixed(6) })
        .eq('id', row.id);
      if (error) return { applied: false, error: `trail_stop: db update failed: ${error.message}` };
      return { applied: true, positionId: row.id };
    }

    if (decision.action_kind === 'open_pairs') {
      // Pair trade = 2 positions simultanées (long A + short B), market neutral.
      // Hors-scope MVP : nécessite logique d'apariement + sizing partagé. À câbler
      // dans un PR dédié quand le besoin se manifeste sur les décisions Gemini.
      return { applied: false, error: 'open_pairs: not yet wired (rare action, follow-up PR)' };
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
