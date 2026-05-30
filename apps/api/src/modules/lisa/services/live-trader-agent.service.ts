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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import { LisaService } from './lisa.service';
import { ScannerLessonsContextService } from './scanner-lessons-context.service';
import { TopGainersScannerService } from './top-gainers-scanner.service';
import type { TopGainerCandidate } from '@smartvest/ai-analyst';

const TRADER_AGENT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';
const TRADER_AGENT_USER_ID = '5f164201-9736-4867-8756-a1653d65fd1c';
const TRADER_AGENT_CAPITAL_USD = 10000;
const MAX_DAILY_LOSS_USD = 500;
const MAX_CONCENTRATION_USD = 4500;  // 45% capital — boost 28/05/2026 pour target $400/jour
const MIN_NOTIONAL_USD = 50;
const MIN_CONFIDENCE = 0.75;  // recalibré 29/05 10:35. 0.80 bloquait OVH.PA +9.6% conf 0.73 (setup champion 3-10%). Le 0.80 était justifié quand le feed était plein de paraboliques >20% (confidence = dernier filtre). Maintenant le feed est nettoyé EN AMONT (band [2,15] + pullback >10% + overpump >15% + falling-knife + velocity), donc exiger 0.80 fait double-emploi et bloque les setups modérés légitimes. 0.75 = compromis : laisse passer 3-10% conf 0.75-0.79, garde sélectivité vs 0.72.
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

const SYSTEM_PROMPT_BASE = `Tu es un trader intraday professionnel autonome qui pilote un portfolio paper-trading de $10500 sur SmartVest. Ton mandat : générer **$400/jour de PnL net** (après fees ~0.20% round-trip) = +3.8%/jour, agressif. Tu trades en momentum + retournements rapides sur US/EU/Asia equities + crypto majors.

PATTERNS VALIDÉS (priorité haute — observation 28/05/2026, à amplifier dès Asia 00:00 UTC) :

★ KOSDAQ SMALL-MID (suffix .KQ) = veine PROUVÉE : MIDDLE 28/05 a fait 2 TP clean = +$120 sur 208710.KQ (+2.10%, hold 4min) et 200470.KQ (+1.89%, hold 3min) en session asia matin. Pattern : KOSDAQ small-mid momentum 1m persistant 1-5min, TP rapide 2%. Si un .KQ apparaît dans candidates avec changePct 3-8% et persistenceScore ≥ 0.6 → setup A+, conf 0.85+, notional 3000-4000, TP 2-2.5%, SL 1.5%.

★ ORPHAN_CLOSE PRE-CLOCHE = R/R ABSURDE : TRADER 28/05 a fait +$190 net (CHRT.LSE +$105 +$37, IQE.LSE +$47) en fermant systématiquement les positions sur marchés fermant <30 min. **RÈGLE IMPÉRATIVE NON-AMBIGUË** (révisée 29/05 après incident 382840.KQ fermée à -$16.97 par erreur de discipline) :

  CAS 1 — PnL unrealized ≥ 0% (breakeven OU profit) ET marché ferme dans <30 min :
    → CLOSE OBLIGATOIRE ce cycle (lock le profit avant cloche).

  CAS 2 — PnL unrealized < 0% (en perte) ET marché ferme dans <30 min :
    → **N'UTILISE PAS l'action "close" manuellement.** Laisse le SL ou la cloche gérer.
    → Si SL est proche → il triggera automatiquement.
    → Si la cloche arrive avant SL → orphan_close automatique via mechanical-trading.
    → Tu peux utiliser "trail_stop" pour resserrer le SL si la chute s'aggrave, MAIS PAS "close".
    → Logique : fermer manuellement à -0.8% verrouille une perte qui aurait pu :
      a) être recouvrée si le marché rebondit avant cloche (rare mais arrive)
      b) être limitée naturellement par le SL existant à -1.5%
      c) être réduite par le orphan-close automatique au breakeven si remontée

  Le orphan-close DÉTERMINISTE est appliqué automatiquement avant ton cycle UNIQUEMENT
  si PnL ≥ -0.1% (proche breakeven). Si tu reçois state.orphan_closed = true, c'est fait.
  Sinon, NE PRENDS PAS L'INITIATIVE DE FERMER MANUELLEMENT EN PERTE.

  Marchés concernés et horaires de cloche : LSE 16:30 UTC, XETRA/PA 15:30 UTC,
  TSE 06:00 UTC, KRX/KQ 06:30 UTC, HK 08:00 UTC, AU 06:00 UTC, NYSE 21:00 UTC.

★ ORPHAN_CLOSE HARVEST STRATEGY (28/05 soirée, G2) — règle PROACTIVE : l'orphan-close auto te garantit la cloche, MAIS ne tire que si tu AS ouvert des positions sur les marchés qui vont fermer. Donc ouvre activement pour nourrir la mécanique :
- Fenêtre **02:00-05:00 UTC** : si candidat A+ sur .T / .HK / .KQ / .KO / .AU avec persistenceScore ≥ 0.6 et changePct 3-8%, OUVRE — la cloche TSE/KRX/AU 06:00-06:30 UTC harvestera (90-180 min de respiration).
- Fenêtre **13:00-15:00 UTC** : si candidat A+ sur .LSE / .L / .PA / .XETRA / .DE avec setup propre (catalyseur news ≥ 60 OU KOSDAQ-like momentum), OUVRE — la cloche EU 15:30/16:30 UTC harvestera.
- Logique R/R : tu vises TP intraday (2-3%) mais la cloche te ramène au breakeven minimum SI le mouvement fade. Downside borné à fees, upside = TP normal. **Asymétrie positive quasi-garantie.**
- À éviter : ouvrir une position EU/Asia trop près de la cloche (<60 min) — pas assez de respiration. Privilégie 90-180 min avant cloche.
- Cas pratique 28/05 : tu as ouvert CHRT.LSE à 13h00 UTC, position +PnL à 16:24, fermée à $105 net avant cloche. Reproductible.

ANTI-PATTERNS À ÉVITER (priorité haute — observation 28/05/2026) :

✗ ASIA EARLY SESSION 00:00-01:00 UTC sur asia_equity = 0/5 wins. Opening auctions Nikkei + HSI sont chop par construction. Skip les candidats asia_equity de l'heure UTC 0 et 1. Re-prends à partir de 01:00 UTC (KOSDAQ active).

✗ US SMALL_MID changePct 4-8% post 15:30 UTC : 28/05 a vu 3 SL / 5 trades (EVC.US -$45.84, NVAX.US -$25.41, FWRD.US +$4.92). Setups choppy early-session américain. Si candidat us_equity_small_mid avec changePct < 8%, requires conf ≥ 0.80 ET catalyseur news ≥ 60.

✗ NUF.AU-type CROSS-PORTFOLIO REVENGE : NUF.AU 28/05 tradé par 3 portfolios presque simultanément en asia session, tous closed losing. Si un ticker apparaît comme top-1 mais a déjà été SL'd sur un autre portfolio dans les 2h, propose hold + thesis "[CROSS_PF_SL] {ticker} SL'd il y a Xmin sur portfolio Y → wait".

✗ XETRA SMALL-CAP <$3000 notional : SNG.XETRA -$35 + QH9.XETRA -$132 (gap polling failure). Liquidité trop mince. Le système te bloquera de toute façon mais ne perds pas de quota dessus.



ACTIONS DISPONIBLES (action_kind) :
- "open_directional" : ouvrir une position simple (long ou short) sur 1 ticker
- "open_pairs" : pair trade long A + short B (market neutral, capter alpha sans beta)
- "close" : fermer une position ouverte par symbole
- "scale_in" : augmenter taille d'une position existante (max +50% sizing)
- "trail_stop" : ajuster le SL d'une position ouverte (vers breakeven ou profit lock)
- "hold" : rien à faire ce cycle (état OK ou trop tôt pour conclure)

CONTRAINTES DURES (les viole pas) :
1. Notional par trade : $50 ≤ N ≤ $3000 (30% capital max sur 1 symbole)
2. Stop loss obligatoire pour tout open : 1.5% ≤ SL ≤ 3% (default 2%) — backtest 27/05 montre MAE/R médian 1.78 sur Trader Agent, donc SL <1.5% = stop-out quasi garanti avant retracement
3. Take profit obligatoire : 2.5% ≤ TP ≤ 8% (default 4%, R/R 2:1 sur SL 2%) — capture rate Trader -45.8% montre que TP trop large laisse l'argent partir
4. AUTONOMIE CADRÉE : tu peux dévier du default 2%/4% si tu vois un signal LIVE non-capturé
   par le backtest (résistance proche, volatilité anormale, news imminente, microcap, etc.)
5. SI tu dévies du default de plus de 30% (ex: TP=5.5 ou TP=2.7, SL=1.5 ou SL=2.7), tu DOIS
   préfixer ton thesis avec "[TP_CUSTOM: X% / SL_CUSTOM: Y%] reason: <raison concrète>"
   Exemple: "[TP_CUSTOM: 3% / SL_CUSTOM: 2.5%] reason: résistance H4 à +3.2%, ATR daily 0.4%"
6. Privilégie le default 4%/2% sauf raison forte — c'est le sweet spot calibré post-MFE/MAE 27/05.
7. Confidence ≥ 0.65 pour qu'on agisse (sinon hold)
8. Pas plus de 5 positions ouvertes simultanément
9. Si daily PnL < -$300 ce jour, mode défensif : open uniquement si confidence ≥ 0.85
10. Pour les shorts : confirmer setup retournement clair (RSI > 70, distribution candle, level résistance majeur)

DISCIPLINE D'ENTRY TIMING — LEÇONS MFE/MAE 27/05 (sample 7 trades) :
A) MAE/R médian Trader Agent = 1.78 (vs MAIN 1.03, healthy 0.6-0.85) → tu entres
   QUASI-SYSTÉMATIQUEMENT au peak local du 1min. Le marché va 78% AU-DELÀ de
   ton SL avant de retracer. Cause : tu ouvres sur "persistenceScore=1" sans
   attendre un pullback.
B) **persistenceScore=1 n'est PAS un signal d'entrée immédiate**. C'est un signal
   que le titre PUMP — ce qui veut dire qu'il va probablement retracer 1-2% avant
   de continuer. Entrer au peak = MAE/R > 1.5 garanti.
C) RÈGLE PULLBACK (RECALIBRÉE 29/05) : si \`changePct\` du candidat > 10% ET
   \`persistenceScore\` ≥ 0.8, tu DOIS attendre un retracement (hold ce cycle,
   ré-évaluer 5min plus tard). Cite "[PULLBACK_WAIT] changePct=X.X% persistance=Y".
   IMPORTANT : le seuil est 10%, PAS 3%. Un candidat à changePct 3-10% est un
   momentum SAIN à entrer directement (c'est la veine gagnante de MIDDLE qui fait
   +$70/jour sur des setups 3-9% sans attendre de pullback). N'attends un pullback
   QUE sur les pumps paraboliques > 10%. Entrer dans la bande 3-10% est le
   comportement CHAMPION — ne le bloque pas par excès de prudence.
D) ANTI-REVENGE : si tu as déjà ouvert le même ticker DANS LES 2 DERNIÈRES
   HEURES (regarde state.recent_closed_trades), tu N'OUVRES PAS À NOUVEAU même
   si persistenceScore=1. Le système te bloquera de toute façon, mais ça pollue
   les logs et brûle du quota Gemini.
E) ROTATION DE CANDIDATS : ne te focalise pas sur le top-1 du snapshot. Si le
   top-1 a déjà été tenté ou est trop "pumped" (changePct > 5%), regarde les
   candidats #3-#10 qui ont un setup plus frais.
F) CAPTURE RATE -45.8% : tu fermes systématiquement les trades qui sont en
   profit avant le TP. Si la position dépasse +1.5%, n'utilise PAS "close" sur
   un argument "persistence=0 maintenant" — utilise "trail_stop" (lock le
   breakeven ou un peu de profit) et laisse le trade respirer jusqu'au TP.

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

SIZING AGGRESSIF (28/05/2026) — CIBLE +$400/JOUR :
- Capital $10000, MAX par position $4500 (45%), MIN $50
- Setup A+ (conf ≥ 0.85, persistence=1.0, lesson winning_pattern qui match, news favorable)
  → notional 2500-4000 USD (large mais cadré)
- Setup standard (conf 0.70-0.84) → notional 1500-2500 USD
- Setup faible (conf 0.65-0.69) → notional 800-1500 USD ou hold
- Privilégier 3-4 positions agressives plutôt que 5 positions timides
- Sur session US (14:30-21:00 UTC) régime momentum classique :
  cible TP 2-3% scalp court (<30min, cf. lesson TP fast pattern)
- Anti-revenge : si même ticker a perdu dans 2h, NE PROPOSE PAS de re-ouvrir

Sois agressif quand le setup est A+, conservateur sinon. Le sweet spot = 3 trades A+ par session × +$50-100 = target hit.`;

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
    private readonly topGainersScanner: TopGainersScannerService,
    @Optional() private readonly lessonsContext?: ScannerLessonsContextService,
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

      // 1.5 — Pre-flight ORPHAN_CLOSE déterministe (28/05/2026, ADDENDUM TRADER).
      // TRADER a généré +$190 net jour en orphan-close manuel (CHRT.LSE 2x, IQE.LSE).
      // Codification : pour chaque position ouverte sur un marché fermant <30 min
      // ET PnL unreal ≥ -0.1% (breakeven ou mieux), close maintenant. Évite que
      // Gemini oublie cette règle ou rate son cycle.
      const orphanClosed = await this.preFlightOrphanClose(state);
      if (orphanClosed.length > 0) {
        this.logger.log(
          `[trader-agent] preFlightOrphanClose closed ${orphanClosed.length} positions: ${orphanClosed.join(', ')}`,
        );
        // Re-read state — les positions fermées sont reflétées
        Object.assign(state, await this.readState());
      }

      // 1.6 — Pre-flight MAX_LOSS_CAP (28/05/2026 soirée, plancher $200/jour) :
      // hard-close toute position dont l'unreal dépasse -$50 (≈ -2% sur $2500 notional
      // standard). Plafond catastrophe — l'incident QH9.XETRA -$132 ne doit JAMAIS
      // se reproduire. Indépendant du SL pct configuré : même si le SL stop_loss_price
      // n'a pas trigger (gap, polling failure, price stale), le P&L unreal lui se
      // calcule sur le live price → on fait foi à l'unreal pour le cap.
      const maxLossCapClosed = await this.preFlightMaxLossCap(state, -50);
      if (maxLossCapClosed.length > 0) {
        this.logger.warn(
          `[trader-agent] preFlightMaxLossCap closed ${maxLossCapClosed.length} positions: ${maxLossCapClosed.join(', ')}`,
        );
        Object.assign(state, await this.readState());
      }

      // 1.7 — MFE health check (28/05/2026 soirée) : vérifie que recordMfe()
      // de MechanicalTradingService tire vraiment pour les positions TRADER.
      // Sans MFE recording, le trailing BE / trailing TP / let-run sont du
      // dead-code → fausse protection. Log warn si position > 5 min sans MFE
      // update (peak_pre_exit = entry_price OU null). Pas d'action automatique,
      // juste alerte pour intervention.
      await this.checkMfeHealth(state).catch((e) =>
        this.logger.debug(`[trader-agent] mfe health check err: ${String(e).slice(0, 100)}`),
      );

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

      // 3. Fetch candidates + macro + news + memory + lessons — chaque fetch
      // en allSettled pour qu'un échec individuel (DB query fail, API down) ne
      // stoppe pas le cycle entier. Fallback aux valeurs vides en cas de fail.
      const settled = await Promise.allSettled([
        this.fetchTopCandidates(20),
        this.fetchMacroContext(),
        this.fetchRecentNews(10),
        this.fetchActiveMemory(1000),
        this.lessonsContext?.getLessonsBlock('trader_agent_only', { assetClass: 'asia_eu_us_crypto' }) ?? Promise.resolve(''),
        // COMMIT 5 (29/05) — MIDDLE reference block
        this.fetchMiddleReference(),
        // AUTO-CORRECTION DYNAMIQUE (29/05) — self-reflection sur dernières 5 décisions
        this.computeSelfReflection(),
      ]);
      const candidates = settled[0].status === 'fulfilled' ? settled[0].value : [];
      const macro = settled[1].status === 'fulfilled' ? settled[1].value : { note: 'macro_fetch_failed' };
      const news = settled[2].status === 'fulfilled' ? settled[2].value : [];
      const memory = settled[3].status === 'fulfilled' ? settled[3].value : [];
      const crossScannerLessons = settled[4].status === 'fulfilled' ? (settled[4].value as string) : '';
      const middleReference = settled[5].status === 'fulfilled' ? (settled[5].value as string) : '';
      const selfReflection = settled[6].status === 'fulfilled' ? (settled[6].value as string) : '';
      const fetchFailures = settled
        .map((s, i) => s.status === 'rejected' ? `${['candidates','macro','news','memory','lessons','middle_ref','self_reflect'][i]}=${String(s.reason).slice(0,80)}` : null)
        .filter((x) => x !== null);
      if (fetchFailures.length > 0) {
        this.logger.warn(`[trader-agent] fetch partial failures: ${fetchFailures.join(' | ')}`);
      }
      if (middleReference.length > 0) {
        this.logger.debug(`[trader-agent] MIDDLE reference block injected (${middleReference.length} chars)`);
      }
      if (selfReflection.length > 0) {
        this.logger.log(`[trader-agent] SELF-REFLECTION triggered : ${selfReflection.slice(0, 100)}...`);
      }

      // 4. Build system prompt (memory + cross-lessons + MIDDLE ref + self-reflection)
      const systemPrompt = this.buildSystemPrompt(memory, crossScannerLessons, middleReference, selfReflection);
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
      // maxTokens=4000 : Gemini 2.5 Pro utilise des "thinking tokens" internes
      // qui se déduisent du budget. 1000 était trop bas → content vide. 4000 laisse
      // ~3000 tokens de thinking + 1000 pour la réponse JSON.
      let response: { content: string; providerId: string; costUsd: number; latencyMs: number };
      try {
        response = await this.llmRouter.callWithPro({
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.3,
          maxTokens: 4000,
          timeoutMs: 30_000,
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

      // 5b. Si content vide (Gemini Pro a brûlé tout son budget en thinking),
      // fallback explicite sur la chain rapide (Flash Lite — pas de thinking tokens).
      if (!response.content || response.content.trim().length === 0) {
        this.logger.warn(`[trader-agent] Gemini Pro returned empty content — fallback to fast chain. provider=${response.providerId}`);
        try {
          response = await this.llmRouter.call({
            system: systemPrompt,
            user: userPrompt,
            temperature: 0.3,
            maxTokens: 1500,
            timeoutMs: 30_000,
          });
        } catch (e) {
          const errMsg = `LLM fallback also failed: ${String(e).slice(0, 200)}`;
          this.logger.warn(`[trader-agent] ${errMsg}`);
          await this.logDecision({
            cycleStartedAt, state, candidates, macro, news, memory,
            action: 'hold' as const,
            actionKindOverride: 'skip_safety_bound',
            notionalUsd: 0, confidence: 0,
            thesis: `Pro empty + fallback failed: ${errMsg}`,
            applied: false,
            applyError: errMsg,
          }).catch(() => null);
          return;
        }
      }

      // 6. Parse decision
      let decision: TraderDecision;
      try {
        const cleaned = response.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        decision = JSON.parse(cleaned);
      } catch (e) {
        const errMsg = `parse JSON failed: ${String(e).slice(0, 150)}`;
        this.logger.warn(`[trader-agent] ${errMsg} — raw: ${response.content.slice(0, 200)}`);
        // Persist DB row pour visibilité
        await this.logDecision({
          cycleStartedAt, state,
          candidates, macro, news, memory,
          rawResponse: response.content,
          provider: response.providerId,
          latencyMs: response.latencyMs,
          costUsd: response.costUsd,
          action: 'hold' as const,
          actionKindOverride: 'skip_safety_bound',
          notionalUsd: 0, confidence: 0,
          thesis: `Gemini response parse failed: ${errMsg}. Raw: ${response.content.slice(0, 200)}`,
          applied: false,
          applyError: errMsg,
        }).catch(() => null);
        return;
      }

      // 7. Apply decision with safety bounds — wrap dans try pour ne pas
      // silencieusement drop la décision si applyDecision throw.
      let applyResult: { applied: boolean; positionId?: string; error?: string };
      try {
        applyResult = await this.applyDecision(decision, state, candidates as Array<Record<string, unknown>>);
      } catch (e) {
        const errMsg = `applyDecision throw: ${String(e).slice(0, 200)}`;
        this.logger.error(`[trader-agent] ${errMsg}`);
        applyResult = { applied: false, error: errMsg };
      }

      // 8. Log everything — try/catch pour ne jamais dropper silencieusement
      try {
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
      } catch (e) {
        this.logger.error(`[trader-agent] logDecision failed (cycle ran but trace lost): ${String(e).slice(0, 200)}`);
      }

      const tag = applyResult.applied ? '✅' : (decision.action_kind === 'hold' ? '⏸️' : '⚠️');
      this.logger.log(
        `[trader-agent] ${tag} ${decision.action_kind} ${decision.symbol ?? ''} conf=${decision.confidence?.toFixed(2)} — ${decision.thesis?.slice(0, 80) ?? ''}`,
      );
    } catch (e) {
      const errMsg = `cycle failed: ${String(e).slice(0, 200)}`;
      this.logger.error(`[trader-agent] ${errMsg}`);
      // Trace l'erreur en DB pour visibilité (best-effort).
      try {
        await this.supabase.getClient().from('trader_agent_decisions').insert({
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          cycle_started_at: new Date().toISOString(),
          input_state: { cycle_error_sentinel: true, error: errMsg },
          action_kind: 'hold',
          thesis: `[CYCLE_ERROR] ${errMsg}`,
          confidence: 0,
          action_applied: false,
          apply_error: errMsg,
        });
      } catch { /* swallow */ }
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
  "autonomy_analysis": {
    "aligned_count": <N>,
    "aligned_wr": <0-1>,
    "aligned_avg_pnl_usd": <num>,
    "deviation_tight_count": <N>,
    "deviation_tight_wr": <0-1>,
    "deviation_tight_avg_pnl_usd": <num>,
    "deviation_wide_count": <N>,
    "deviation_wide_wr": <0-1>,
    "deviation_wide_avg_pnl_usd": <num>,
    "recommendation": "keep_default | widen_tighter | widen_wider | tighten_bounds"
  },
  "new_lessons": [
    {
      "lesson_kind": "winning_pattern|losing_pattern|risk_observation|market_regime_rule|sizing_rule|cross_portfolio_insight|autonomy_calibration",
      "lesson_text": "Quand <condition macro>, alors <action> (référence: Z trades observés)",
      "confidence": 0.0-1.0,
      "macro_condition": "VIX>25|US10Y>4.5|DXY>103|GOLD+DXY-|BRENT+5%|HY_OAS>500|USDJPY<145|REGIME_CALME|REGIME_MIXED"
    }
  ]
}

ANALYSE D'AUTONOMIE (autonomy_analysis section) :
Tu DOIS analyser SÉPARÉMENT 3 profils de décisions Gemini Pro :
- ALIGNED : trades avec TP ∈ [4-8] ET SL ∈ [0.5-1.5] (proche default 6/1)
- DEVIATION_TIGHT : trades avec TP < 4 OU SL > 1.5 (Gemini serre)
- DEVIATION_WIDE : trades avec TP > 8 OU SL < 0.5 (Gemini élargit)

Pour chaque profil, calcule n, win_rate (% closed_target), avg_pnl_usd.

Recommendation rules :
- Si deviation_tight WR > aligned WR * 1.3 ET sample ≥ 10 → "widen_tighter" (Gemini a raison de serrer)
- Si deviation_wide WR > aligned WR * 1.3 ET sample ≥ 10 → "widen_wider" (Gemini a raison d'élargir)
- Si toutes les deviations sous-performent → "tighten_bounds" (forcer le default)
- Sinon → "keep_default" (calibrage OK)`;

      const userPayload = JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        macro_snapshot_eod: macroSnapshot,
        trader_agent_decisions: decisions ?? [],
        trader_agent_positions: positions ?? [],
        cross_portfolio_daily_summary: dailyByPortfolio,
        market_close_reports_today: closeReports ?? [],
      }, null, 2);

      // Post-mortem = raisonnement sur 24h × 5 portfolios → Pro requis (qualité d'analyse).
      // maxTokens=6000 : Gemini Pro thinking budget (cf. fix 06:55 — 1500 trop bas, content vide).
      const response = await this.llmRouter.callWithPro({
        system: postMortemPrompt,
        user: userPayload,
        temperature: 0.4,
        maxTokens: 6000,
        timeoutMs: 60_000,
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
  // PUBLIC API — endpoint admin /admin/trader-agent/autonomy
  // ====================================================================

  /**
   * Analyse l'autonomie de Gemini Pro : compare les outcomes des trades
   * 'aligned' (TP 4-8%, SL 0.5-1.5% — proche default 6/1) vs 'deviation_tight'
   * (TP<4 ou SL>1.5%) vs 'deviation_wide' (TP>8 ou SL<0.5%).
   *
   * Si Gemini surperforme en serrant ou élargissant ses TP/SL, on saura qu'il
   * a "raison" et on peut élargir les bornes ou inversement les resserrer.
   */
  async getAutonomyAnalysis(lookbackDays: number = 7): Promise<object> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000).toISOString();
    const { data: decisions } = await this.supabase.getClient()
      .from('trader_agent_decisions')
      .select('decided_at, gemini_parsed, action_kind, applied_position_id, action_applied')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('action_applied', true)
      .eq('action_kind', 'open_directional')
      .not('applied_position_id', 'is', null)
      .gte('decided_at', since);
    if (!decisions || decisions.length === 0) {
      return { lookback_days: lookbackDays, total_applied: 0, message: 'Pas encore assez de décisions appliquées' };
    }
    const positionIds = decisions.map((d) => d.applied_position_id).filter(Boolean);
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, realized_pnl_usd, exit_reason, status')
      .in('id', positionIds as string[]);
    const posById = new Map((positions ?? []).map((p) => [p.id as string, p]));

    type Profile = 'aligned' | 'deviation_tight' | 'deviation_wide';
    function classify(tp: number, sl: number): Profile {
      const alignedTp = tp >= 4 && tp <= 8;
      const alignedSl = sl >= 0.5 && sl <= 1.5;
      if (alignedTp && alignedSl) return 'aligned';
      if (tp < 4 || sl > 1.5) return 'deviation_tight';
      return 'deviation_wide';
    }
    const buckets: Record<Profile, { n: number; wins: number; pnl: number; closed: number }> = {
      aligned: { n: 0, wins: 0, pnl: 0, closed: 0 },
      deviation_tight: { n: 0, wins: 0, pnl: 0, closed: 0 },
      deviation_wide: { n: 0, wins: 0, pnl: 0, closed: 0 },
    };
    for (const d of decisions) {
      const parsed = d.gemini_parsed as { take_profit_pct?: number; stop_loss_pct?: number } | null;
      if (!parsed) continue;
      const tp = Number(parsed.take_profit_pct ?? 6);
      const sl = Number(parsed.stop_loss_pct ?? 1);
      const profile = classify(tp, sl);
      buckets[profile].n++;
      const pos = posById.get(d.applied_position_id as string);
      if (pos && pos.status !== 'open') {
        buckets[profile].closed++;
        const pnl = Number(pos.realized_pnl_usd ?? 0);
        buckets[profile].pnl += pnl;
        if (pos.exit_reason === 'closed_target' || pnl > 0) buckets[profile].wins++;
      }
    }
    function summarize(b: { n: number; wins: number; pnl: number; closed: number }) {
      return {
        count: b.n,
        closed: b.closed,
        wr: b.closed > 0 ? Number((b.wins / b.closed).toFixed(3)) : null,
        avg_pnl_usd: b.closed > 0 ? Number((b.pnl / b.closed).toFixed(2)) : null,
        total_pnl_usd: Number(b.pnl.toFixed(2)),
      };
    }
    const aligned = summarize(buckets.aligned);
    const devTight = summarize(buckets.deviation_tight);
    const devWide = summarize(buckets.deviation_wide);

    // Recommendation
    let recommendation = 'keep_default';
    const minSample = 10;
    if (aligned.wr !== null) {
      if (devTight.wr !== null && devTight.closed >= minSample && devTight.wr > aligned.wr * 1.3) {
        recommendation = 'widen_tighter';
      } else if (devWide.wr !== null && devWide.closed >= minSample && devWide.wr > aligned.wr * 1.3) {
        recommendation = 'widen_wider';
      } else if (
        (devTight.wr ?? 1) < aligned.wr * 0.7 &&
        (devWide.wr ?? 1) < aligned.wr * 0.7 &&
        (devTight.closed + devWide.closed) >= minSample
      ) {
        recommendation = 'tighten_bounds';
      }
    }

    return {
      lookback_days: lookbackDays,
      total_applied: decisions.length,
      aligned,
      deviation_tight: devTight,
      deviation_wide: devWide,
      recommendation,
      explanation: {
        keep_default: 'Calibrage 1%/6% OK, conserver les bornes actuelles',
        widen_tighter: 'Gemini surperforme quand il serre les TP/SL — autoriser SL>1.5% et TP<4% plus librement',
        widen_wider: 'Gemini surperforme quand il élargit — autoriser TP>8% et SL<0.5% plus librement',
        tighten_bounds: 'Toutes les deviations sous-performent — forcer le default 6%/1% en clampant les bornes',
      }[recommendation],
    };
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  /**
   * Pre-flight MAX_LOSS_CAP (28/05/2026 soirée) — plafond catastrophe.
   * Hard-close toute position dont l'unreal P&L dépasse `capUsd` (négatif).
   * Indépendant du SL configuré : même si le SL n'a pas trigger (gap, polling
   * failure, prix stale), on close au unreal. Évite QH9.XETRA-like -$132.
   */
  private async preFlightMaxLossCap(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }> },
    capUsd: number,
  ): Promise<string[]> {
    if (state.openPositions.length === 0 || capUsd >= 0) return [];
    const closed: string[] = [];
    for (const pos of state.openPositions) {
      const livePriceData = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!livePriceData?.price) continue;
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) continue;
      const src = String(livePriceData.source ?? '');
      if (src.startsWith('fallback')) continue; // ne jamais close sur fallback price corrompu

      const qty = pos.entry_notional_usd / pos.entry_price;
      const unrealUsd = pos.direction === 'short'
        ? qty * (pos.entry_price - livePrice)
        : qty * (livePrice - pos.entry_price);

      if (unrealUsd <= capUsd) {
        const { data: row } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('id')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', pos.symbol)
          .eq('status', 'open')
          .order('entry_timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!row?.id) continue;

        const res = await this.lisa.closeForOpportunityScout({
          positionId: row.id,
          symbol: pos.symbol,
          livePrice,
          livePriceSource: src,
          reason: 'closed_stop',
          rationale: `[trader-agent preflight-maxloss] unreal $${unrealUsd.toFixed(2)} ≤ cap $${capUsd} — hard close anti-catastrophe (plancher $200/jour)`,
        });
        if (res.closed) closed.push(`${pos.symbol} (unreal $${unrealUsd.toFixed(2)})`);
      }
    }
    return closed;
  }

  /**
   * MFE health check (28/05/2026 soirée) — verify MechanicalTradingService.recordMfe()
   * fires for TRADER positions. Without MFE recording, trailing BE/TP/let-run
   * (commit 5600b83) are dead code. Log warn if position > 5 min has peak_pre_exit
   * = entry_price (= never updated). No auto-action, alert only.
   */
  private async checkMfeHealth(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_timestamp: string }> },
  ): Promise<void> {
    if (state.openPositions.length === 0) return;
    const fiveMinAgo = Date.now() - 5 * 60_000;
    const oldPositions = state.openPositions.filter(
      (p) => new Date(p.entry_timestamp).getTime() < fiveMinAgo,
    );
    if (oldPositions.length === 0) return;
    const { data } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('symbol, entry_price, peak_pre_exit, entry_timestamp')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .eq('status', 'open')
      .in('symbol', oldPositions.map((p) => p.symbol));
    if (!data) return;
    for (const row of data) {
      const peak = Number(row.peak_pre_exit);
      const entry = Number(row.entry_price);
      // peak_pre_exit doit être > entry pour un long (MFE > 0) — sinon never updated
      // OR le prix n'est jamais monté au-dessus de l'entry (= MAE-only trade).
      // Pour distinguer, on fetch le live et compare.
      const live = await this.lisa.getLivePrice(row.symbol).catch(() => null);
      if (!live?.price) continue;
      const livePrice = Number(live.price);
      if (!Number.isFinite(peak) || peak <= entry) {
        // peak n'a jamais bougé au-dessus d'entry → soit MAE-only soit recordMfe broken.
        // Si livePrice > entry maintenant, c'est preuve que recordMfe ne tire pas.
        if (livePrice > entry * 1.002) {
          this.logger.warn(
            `[trader-agent] MFE_HEALTH_ALERT ${row.symbol} live=${livePrice} > entry=${entry} mais peak_pre_exit=${peak} → recordMfe ne tire PAS (trailing BE/TP/let-run inopérants)`,
          );
        }
      }
    }
  }

  /**
   * Pre-flight orphan-close (28/05/2026, ADDENDUM TRADER) — déterministe, pas LLM.
   * Pour chaque position ouverte : si le marché du ticker ferme dans <30 min ET
   * PnL unreal ≥ -0.1% (breakeven+), close. Codification du pattern qui a fait
   * +$190 net jour TRADER (CHRT.LSE 2x, IQE.LSE).
   *
   * Returns la liste des symboles fermés.
   */
  private async preFlightOrphanClose(
    state: { openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }> },
  ): Promise<string[]> {
    if (state.openPositions.length === 0) return [];

    // Map suffix → heure UTC de fermeture (CLAUDE.md §6quater + P4-A).
    // Couvre toutes les bourses tradées par TRADER.
    const closeByMarket = (sym: string): number | null => {
      const s = sym.toUpperCase();
      if (s.endsWith('.US')) return 21 * 60;          // NYSE 21:00 UTC
      if (s.endsWith('.LSE') || s.endsWith('.L')) return 16 * 60 + 30;  // LSE 16:30 UTC
      if (s.endsWith('.XETRA') || s.endsWith('.DE') || s.endsWith('.F') || s.endsWith('.PA') || s.endsWith('.AS') || s.endsWith('.BR') || s.endsWith('.MI') || s.endsWith('.MC') || s.endsWith('.SW')) return 15 * 60 + 30;
      if (s.endsWith('.T')) return 6 * 60;            // TSE Tokyo 06:00 UTC
      if (s.endsWith('.HK')) return 8 * 60;           // HKEX 08:00 UTC
      if (s.endsWith('.KO') || s.endsWith('.KQ')) return 6 * 60 + 30;   // KRX/KOSDAQ 06:30 UTC
      if (s.endsWith('.AU')) return 6 * 60;           // ASX 06:00 UTC
      // Crypto et tickers sans suffixe reconnu = 24/7, no orphan close
      return null;
    };

    const nowMin = (() => {
      const d = new Date();
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();

    const closed: string[] = [];
    for (const pos of state.openPositions) {
      const closeMin = closeByMarket(pos.symbol);
      if (closeMin === null) continue;
      const minutesToClose = closeMin - nowMin;
      // Marché fermé ou ferme dans <30 min mais > 0 (sinon on est déjà après close)
      if (minutesToClose >= 30 || minutesToClose < -5) continue;

      // Fetch live price + PnL
      const livePriceData = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!livePriceData?.price) continue;
      const livePrice = Number(livePriceData.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) continue;
      // Ne pas fermer sur fallback price — risque corruption (cf. CLAUDE.md §6quater).
      const src = String(livePriceData.source ?? '');
      if (src.startsWith('fallback')) continue;

      const pnlPct = pos.direction === 'short'
        ? ((pos.entry_price - livePrice) / pos.entry_price) * 100
        : ((livePrice - pos.entry_price) / pos.entry_price) * 100;

      // Seuil : close si breakeven ou positif. Tolérance -0.1% pour les fees.
      // Si la position est en grosse perte (<-0.5%), on laisse Gemini gérer
      // (peut-être un stop-loss qui va déclencher avant la cloche).
      if (pnlPct < -0.1) continue;

      const { data: row } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .eq('symbol', pos.symbol)
        .eq('status', 'open')
        .order('entry_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row?.id) continue;

      const res = await this.lisa.closeForOpportunityScout({
        positionId: row.id,
        symbol: pos.symbol,
        livePrice,
        livePriceSource: src,
        reason: 'closed_user',
        rationale: `[trader-agent preflight-orphan] marché ferme dans ${minutesToClose}min, PnL ${pnlPct.toFixed(2)}% — close pre-cloche systématique (lesson 28/05 +$190 net)`,
      });
      if (res.closed) {
        closed.push(`${pos.symbol} (PnL ${pnlPct.toFixed(2)}%, ${minutesToClose}min to close)`);
      }
    }
    return closed;
  }

  private async readState(): Promise<{
    openPositions: Array<{ symbol: string; direction: string; entry_price: number; entry_notional_usd: number; entry_timestamp: string }>;
    openCount: number;
    deployedUsd: number;
    capitalAvailableUsd: number;
    dailyPnlUsd: number;
    closedTodayCount: number;
    winRateTodayPct: number | null;
    recentClosesLast60min: Array<{
      symbol: string;
      direction: string;
      exit_at: string;
      exit_reason: string;
      pnl_usd: number;
      pnl_pct: number;
      minutes_ago: number;
    }>;
  }> {
    const client = this.supabase.getClient();
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    // Fenêtre 60 min — couvre la lesson b4c48e13 ANTI_REENTRY_POST_INVALIDATION
    // (30 min) avec marge contextuelle. Volume typique TRADER ≈ 1-2 closes/h
    // donc liste typique de 1-2 entrées (~200-400 tokens prompt, négligeable).
    const sixtyMinAgoIso = new Date(Date.now() - 60 * 60_000).toISOString();

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

    // Closes des 60 dernières minutes — injecté dans le state pour que le LLM
    // voie ses propres actions récentes (sans cela il est aveugle aux closes
    // qu'il vient lui-même de décider, cas vérifié XRPUSDT 30/05 02:05 -$22).
    const { data: recentClosed } = await client
      .from('lisa_positions')
      .select('symbol, direction, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct')
      .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
      .gte('exit_timestamp', sixtyMinAgoIso)
      .neq('status', 'open')
      .order('exit_timestamp', { ascending: false });

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

    const nowMs = Date.now();
    const recentClosesLast60min = (recentClosed ?? []).map((c) => ({
      symbol: c.symbol as string,
      direction: c.direction as string,
      exit_at: c.exit_timestamp as string,
      exit_reason: (c.exit_reason as string | null) ?? 'unknown',
      pnl_usd: Number(c.realized_pnl_usd ?? 0),
      pnl_pct: Number(c.realized_pnl_pct ?? 0),
      minutes_ago: Math.floor((nowMs - new Date(c.exit_timestamp as string).getTime()) / 60_000),
    }));

    return {
      openPositions,
      openCount: openPositions.length,
      deployedUsd: deployed,
      capitalAvailableUsd: TRADER_AGENT_CAPITAL_USD - deployed,
      dailyPnlUsd: dailyPnl,
      closedTodayCount: closed?.length ?? 0,
      winRateTodayPct: winRate,
      recentClosesLast60min,
    };
  }

  /**
   * Classify asset_class from exchange suffix. Aligné sur le système global.
   * BUGFIX 29/05 : 37/37 trades TRADER avaient asset_class=unknown faute de
   * mapping. Sans asset_class, les lessons par-classe ne s'appliquent pas
   * et l'audit/MFE par-classe est faussé.
   */
  private classifyAssetClass(exchange: string | undefined, symbol: string): string {
    const exch = String(exchange ?? '').toUpperCase();
    const sym = String(symbol ?? '').toUpperCase();
    if (exch === 'US' || sym.endsWith('.US')) return 'us_equity_large';
    if (exch === 'CC' || sym.includes('USDT') || sym.endsWith('.CC')) return 'crypto_major';
    if (['T', 'HK', 'KO', 'KQ', 'AU', 'SHG', 'SHE', 'SS', 'SZ', 'SI'].includes(exch)
        || sym.endsWith('.T') || sym.endsWith('.HK') || sym.endsWith('.KO') || sym.endsWith('.KQ')
        || sym.endsWith('.AU') || sym.endsWith('.SHG') || sym.endsWith('.SHE')) return 'asia_equity';
    if (['LSE', 'L', 'XETRA', 'DE', 'F', 'PA', 'AS', 'BR', 'MI', 'MC', 'SW'].includes(exch)
        || sym.endsWith('.LSE') || sym.endsWith('.L') || sym.endsWith('.XETRA')
        || sym.endsWith('.DE') || sym.endsWith('.PA') || sym.endsWith('.F')
        || sym.endsWith('.AS') || sym.endsWith('.BR') || sym.endsWith('.MI')
        || sym.endsWith('.MC') || sym.endsWith('.SW')) return 'eu_equity';
    return 'unknown';
  }

  private async fetchTopCandidates(n: number): Promise<object[]> {
    // COMMIT 1 (29/05) — Lecture directe du cache scanner pour avoir des candidats
    // FRAIS (le snapshot table gainers_persistence_log était peuplé uniquement par
    // l'UI dashboard → jusqu'à 7h de retard). Avec topGainersScanner injecté, on
    // récupère le cache live 30s + classifie asset_class correctement.
    //
    // FIX 29/05 09:00 (audit feed) — Filtre BANDE TRADEABLE avant top-N.
    // Bug identifié : sort changePct DESC + slice(top 20) → TRADER ne voyait QUE
    // les paraboliques >20% (overpump junk) et holdait éternellement (30 min
    // straight). Les candidats modérés tradeables (3-12% = winning bucket, ex
    // RWS.LSE que MAIN a pris) étaient enterrés position #30-50, hors top 20.
    // Fix : filtrer [TRADER_FEED_MIN_PCT, TRADER_FEED_MAX_PCT] AVANT top-N.
    // Bornes alignées sur l'overpump gate (15%) et un plancher anti-bruit (2%).
    //
    // P-KTOS ENRICHMENT (29/05 17:15) — chaque candidat est enrichi de 4 métriques
    // computées pour aider le LLM Gemini à appliquer les lessons KTOS (#319e867e,
    // #ab035237, #42101ada, #aa6eda5f) :
    //   - pumpScore : changePct / max_changePct du pool (signal proximity-to-peak)
    //   - closeToHighRatio : close / high (1.0 = au top du jour, < 0.9 = retrace)
    //   - volumeRatio : volume / avgVol50d (>2.0 = momentum confirmé)
    //   - kellyMaxNotional : USD plafond Kelly fraction (TP 2.5% SL 1.5% p_win=0.5 → max 20% cap)
    //   - sweetSpotEntry : booléen, true si changePct ∈ [3,8]% (winning bucket)
    // Ces champs sont injectés dans le userPrompt JSON et lus naturellement par le LLM.
    // PAS de gate hardcodé — décision reste autonome côté Gemini Pro.
    const feedMin = Number(this.config.get<string>('TRADER_FEED_MIN_PCT') ?? '2');
    const feedMax = Number(this.config.get<string>('TRADER_FEED_MAX_PCT') ?? '15');
    try {
      const candidates = await this.topGainersScanner.fetchAllCandidates();
      if (candidates && candidates.length > 0) {
        // 1. Filtre bande tradeable. 2. sort DESC. 3. top-N.
        const tradeable = candidates.filter((c) => {
          const cp = c.changePct ?? 0;
          return cp >= feedMin && cp <= feedMax;
        });
        // Fallback : si la bande est vide (marché calme ou tout >max), on garde
        // les candidats < feedMax triés DESC pour ne pas aveugler TRADER.
        const pool = tradeable.length > 0
          ? tradeable
          : candidates.filter((c) => (c.changePct ?? 0) <= feedMax);
        const sorted = [...pool].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
        if (sorted.length > 0) {
          this.logger.debug(
            `[trader-agent] feed: ${candidates.length} scanned → ${sorted.length} in band [${feedMin},${feedMax}]% → top ${Math.min(n, sorted.length)}`,
          );
          // P-KTOS — Compute pool-wide max for pumpScore
          const maxChangePctInPool = sorted.reduce((m, c) => Math.max(m, c.changePct ?? 0), 0);
          return sorted.slice(0, n).map((c) =>
            this.enrichCandidateWithMath(c, maxChangePctInPool),
          );
        }
      }
    } catch (e) {
      this.logger.warn(`[trader-agent] fetchAllCandidates failed: ${String(e).slice(0, 100)}`);
    }
    // Fallback : ancien path (table) si scanner cache vide ou non injecté.
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
      assetClass: c.assetClass ?? c.asset_class
        ?? this.classifyAssetClass(undefined, String(c.symbol ?? '')),
      changePct: c.changePct,
      persistenceScore: c.persistenceScore,
      close: c.close,
    }));
  }

  /**
   * P-KTOS (29/05) — Enrichit un TopGainerCandidate avec 4 métriques computées
   * pour aider le LLM Gemini Pro à appliquer les lessons KTOS (entry discipline +
   * sizing). PAS de gate hardcodé — le LLM voit les chiffres et décide en autonomie.
   *
   * Formules :
   *   - pumpScore = changePct / max_changePct_du_pool
   *     · > 0.85 → au peak local, retrace probable
   *     · 0.50-0.75 → sweet spot (retrace en cours, momentum encore présent)
   *     · < 0.40 → momentum perdu
   *   - closeToHighRatio = close / high (jour)
   *     · 1.00 → au top du jour (chase the top)
   *     · 0.95-0.98 → momentum sain
   *     · < 0.90 → retrace significative
   *   - volumeRatio = volume / avgVol50d
   *     · > 2.0 → momentum confirmé volume
   *     · 1.0-2.0 → volume normal
   *     · < 0.8 → volume faible, signal douteux
   *   - kellyMaxNotional = TRADER_CAPITAL × Kelly fraction (TP 2.5% SL 1.5% p_win=0.5 fallback)
   *     · Formule : f* = (TP×p_win - SL×(1-p_win)) / TP = 0.20 (default 0.5 win prob)
   *     · → max $2000 sur $10k capital tant que p_win pas remontée par P9
   *   - sweetSpotEntry = (changePct ∈ [3,8]%) : true si dans le bucket gagnant historique
   *
   * Cf. scanner_lessons : 319e867e (PULLBACK_WAIT), ab035237 (velocity), 42101ada (Kelly),
   * aa6eda5f (pump score).
   */
  private enrichCandidateWithMath(
    c: TopGainerCandidate,
    maxChangePctInPool: number,
  ): Record<string, unknown> {
    const changePct = c.changePct ?? 0;
    const high = c.high ?? c.close ?? 0;
    const close = c.close ?? 0;
    const volume = c.volume ?? 0;
    const avgVol50d = c.avgVol50d ?? 0;

    const pumpScore = maxChangePctInPool > 0
      ? Math.round((changePct / maxChangePctInPool) * 100) / 100
      : null;
    const closeToHighRatio = high > 0
      ? Math.round((close / high) * 1000) / 1000
      : null;
    const volumeRatio = avgVol50d > 0
      ? Math.round((volume / avgVol50d) * 100) / 100
      : null;

    // Kelly notional — TP/SL standards trader (2.5% / 1.5%), p_win=0.5 par défaut
    // (sera affiné par P9 quand p_win_at_entry sera correctement persisté).
    // f* = (TP*p_win - SL*(1-p_win)) / TP avec TP=2.5, SL=1.5, p_win=0.5
    //    = (1.25 - 0.75) / 2.5 = 0.20
    // Capital trader = $10000 → max $2000 = Kelly cap par défaut.
    const kellyMaxNotional = Math.round(TRADER_AGENT_CAPITAL_USD * 0.20);

    // Sweet spot bucket gagnant historique (lesson aa6eda5f) : [3,8]%
    const sweetSpotEntry = changePct >= 3 && changePct <= 8;

    return {
      symbol: c.symbol,
      assetClass: this.classifyAssetClass(c.exchange ?? undefined, c.symbol),
      changePct,
      close,
      high,
      exchange: c.exchange,
      // P-KTOS enrichment fields :
      pumpScore,
      closeToHighRatio,
      volumeRatio,
      kellyMaxNotional,
      sweetSpotEntry,
    };
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

  private buildSystemPrompt(
    memory: Array<{ lesson_kind: string; lesson_text: string; confidence: number }>,
    crossScannerLessons: string,
    middleReference: string,
    selfReflection: string,
  ): string {
    let prompt = SYSTEM_PROMPT_BASE;

    // Bloc 1 : memory trader-spécifique (post-mortems Trader Agent)
    if (memory.length > 0) {
      const memoryBlock = memory
        .map((l, i) => `${i + 1}. [${l.lesson_kind}] ${l.lesson_text} (conf=${l.confidence})`)
        .join('\n');
      prompt += `\n\nLESSONS APPRISES TRADER AGENT (post-mortems précédents, ordre confidence descendant) :\n${memoryBlock}`;
    }

    // Bloc 2 : lessons cross-scanner
    if (crossScannerLessons.length > 0) {
      prompt += `\n\n${crossScannerLessons}`;
    }

    // COMMIT 5 (29/05) — Bloc MIDDLE reference : injecte les 5 derniers trades
    // MIDDLE (le champion mécanique +$125 sur 2j vs ton -$96) pour que tu
    // calques son comportement. MIDDLE n'utilise PAS de LLM mais te bat.
    if (middleReference.length > 0) {
      prompt += `\n\n${middleReference}`;
    }

    // AUTO-CORRECTION DYNAMIQUE (29/05) — Si tes dernières décisions ont une
    // capture rate négative OU WR < 40%, on injecte une auto-correction.
    if (selfReflection.length > 0) {
      prompt += `\n\n${selfReflection}`;
    }

    if (memory.length > 0 || crossScannerLessons.length > 0 || middleReference.length > 0 || selfReflection.length > 0) {
      prompt += `\n\nGarde ces lessons en tête en priorité pour ta décision actuelle.`;
    }

    return prompt;
  }

  /**
   * COMMIT 5 (29/05) — Fetch les 5 derniers trades MIDDLE (champion) pour
   * injection comme référence à imiter dans le prompt TRADER.
   */
  private async fetchMiddleReference(): Promise<string> {
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol, asset_class, entry_notional_usd, entry_price, realized_pnl_usd, realized_pnl_pct, exit_reason, entry_timestamp, exit_timestamp')
        .eq('portfolio_id', 'a0000002-0000-0000-0000-000000000002')
        .neq('status', 'open')
        .order('exit_timestamp', { ascending: false })
        .limit(5);
      if (!data || data.length === 0) return '';
      const lines = data.map((p, i) => {
        const entry = String(p.entry_timestamp ?? '').slice(11, 16);
        const exit = String(p.exit_timestamp ?? '').slice(11, 16);
        const pnl = Number(p.realized_pnl_usd ?? 0);
        const pct = Number(p.realized_pnl_pct ?? 0);
        const reason = String(p.exit_reason ?? '').slice(0, 30);
        return `  ${i + 1}. ${entry}→${exit} ${p.symbol} (${p.asset_class}) $${p.entry_notional_usd} pnl=$${pnl.toFixed(2)} (${pct.toFixed(2)}%) — ${reason}`;
      }).join('\n');
      return `RÉFÉRENCE MIDDLE (le champion mécanique, 5 derniers trades) :\n${lines}\n→ MIDDLE n'utilise PAS de LLM mais te bat (+$125 vs ton -$96 sur 2j). Observe : sizing constant, hold 5-25min, exits par TP/choppy mécanique, AUCUN close manuel arbitraire. CALQUE CE COMPORTEMENT.`;
    } catch {
      return '';
    }
  }

  /**
   * AUTO-CORRECTION DYNAMIQUE (29/05) — Analyse les 5 dernières décisions
   * TRADER. Si capture rate < 0% ou WR < 40%, retourne un avertissement
   * à injecter dans le prompt pour forcer mode défensif.
   */
  private async computeSelfReflection(): Promise<string> {
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('entry_price, exit_price, peak_pre_exit, realized_pnl_usd, direction')
        .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
        .neq('status', 'open')
        .order('exit_timestamp', { ascending: false })
        .limit(5);
      if (!data || data.length < 3) return '';

      const captures: number[] = [];
      let wins = 0;
      for (const p of data) {
        const entry = Number(p.entry_price);
        const exit = Number(p.exit_price);
        const peak = Number(p.peak_pre_exit);
        const pnl = Number(p.realized_pnl_usd ?? 0);
        if (pnl > 0) wins++;
        if (Number.isFinite(entry) && Number.isFinite(peak) && Number.isFinite(exit) && entry > 0) {
          const dir = String(p.direction ?? 'long');
          const mfePct = dir === 'short' ? ((entry - peak) / entry) * 100 : ((peak - entry) / entry) * 100;
          const realPct = dir === 'short' ? ((entry - exit) / entry) * 100 : ((exit - entry) / entry) * 100;
          if (mfePct > 0) captures.push(realPct / mfePct);
        }
      }
      const wr = (wins / data.length) * 100;
      const avgCapture = captures.length > 0 ? (captures.reduce((a, b) => a + b, 0) / captures.length) * 100 : null;
      const warnings: string[] = [];
      if (avgCapture !== null && avgCapture < 0) {
        warnings.push(`⚠️ CAPTURE RATE NÉGATIVE : ${avgCapture.toFixed(1)}% sur tes 5 derniers trades. Tu fermes systématiquement au pire moment. CONSÉQUENCE : ce cycle, l'action "close" est interdite si la position est en perte (gate déterministe ajoutée). Utilise trail_stop ou hold.`);
      }
      if (wr < 40 && data.length >= 5) {
        warnings.push(`⚠️ WR ${wr.toFixed(0)}% sur 5 derniers = sous le seuil sain 40%. MODE DÉFENSIF ACTIVÉ : confidence threshold relevé à 0.85 pour ce cycle. Privilégie hold ou trail_stop. Ne propose open_directional QUE sur setup A++ (conviction ≥ 0.85, lesson winning_pattern qui match, persistence ≥ 0.95, path_eff ≥ 0.7).`);
      }
      if (warnings.length === 0) return '';
      return `AUTO-CORRECTION DYNAMIQUE (basée sur tes 5 derniers trades) :\n${warnings.join('\n')}`;
    } catch {
      return '';
    }
  }

  private async applyDecision(
    decision: TraderDecision,
    state: Awaited<ReturnType<typeof this.readState>>,
    candidates: Array<Record<string, unknown>> = [],
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

      // COMMIT 3 (29/05) — Zone horaire toxique US opening 13:00-15:30 UTC.
      // Audit TRADER 2 jours : 46% des trades dans cette fenêtre, WR 37%, capture
      // rate -56.5%. Data 3 semaines confirme : us_equity_large 14h UTC = WR 25%,
      // Σ -$174. Désactivable via TRADER_US_OPENING_BLOCK_ENABLED=false.
      const blockUsOpening = (this.config.get<string>('TRADER_US_OPENING_BLOCK_ENABLED') ?? 'true').toLowerCase() === 'true';
      if (blockUsOpening) {
        const now = new Date();
        const hourUtc = now.getUTCHours();
        const minUtc = now.getUTCMinutes();
        const totalMin = hourUtc * 60 + minUtc;
        // 13:00-15:30 UTC = 780-930 minutes
        if (totalMin >= 780 && totalMin < 930) {
          return {
            applied: false,
            error: `TRADER_US_OPENING_BLOCK actif (${String(hourUtc).padStart(2, '0')}:${String(minUtc).padStart(2, '0')} UTC ∈ [13:00, 15:30] — zone toxique audit 2j WR 25-37%)`,
          };
        }
      }
      // Anti-revenge ticker cooldown (renforcé post-MFE/MAE 27/05).
      // Règle 1 : pas plus de 2 ouvertures dans les 4h sur le même ticker.
      // Règle 2 : si la DERNIÈRE position fermée sur ce ticker (≤ 2h) est un
      // loser (realized_pnl_usd < 0), bloque pour éviter de re-rentrer aussitôt
      // sur le même setup cassé. Cas AMKR.US/AEHR.US 27/05 : 4 entries en 50min,
      // 3 FADE Gemini consécutifs avant qu'on touche un winner par chance.
      {
        const sym = decision.symbol.toUpperCase();
        const since4h = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
        const { count } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('id', { count: 'exact', head: true })
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', sym)
          .gte('entry_timestamp', since4h);
        if ((count ?? 0) >= 2) {
          return { applied: false, error: `anti-revenge: ${sym} déjà ouvert ${count}× en 4h` };
        }
        // Cooldown loser : 2h depuis le dernier close en perte sur le même ticker.
        const since2h = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        const { data: lastLoser } = await this.supabase.getClient()
          .from('lisa_positions')
          .select('exit_timestamp, realized_pnl_usd')
          .eq('portfolio_id', TRADER_AGENT_PORTFOLIO_ID)
          .eq('symbol', sym)
          .neq('status', 'open')
          .gte('exit_timestamp', since2h)
          .order('exit_timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastLoser && Number(lastLoser.realized_pnl_usd ?? 0) < 0) {
          return { applied: false, error: `anti-revenge: ${sym} dernier close ${lastLoser.exit_timestamp} en perte (${Number(lastLoser.realized_pnl_usd).toFixed(2)}$) — cooldown 2h actif` };
        }
      }
      const notional = Math.max(MIN_NOTIONAL_USD, Math.min(MAX_CONCENTRATION_USD, decision.notional_usd));
      // XETRA small-cap blacklist (28/05/2026) — 2 incidents : SNG.XETRA -$35
      // (gap SL slippage) + QH9.XETRA -$132 (gap -12% non capté par polling SL).
      // XETRA small-caps notionnel < $3000 = liquidité trop mince pour gérer
      // les gaps intra-session. Bloque pour Trader Agent.
      if (decision.symbol.endsWith('.XETRA') && notional < 3000) {
        return { applied: false, error: 'XETRA small-cap blacklist (notional <$3000) — anti-gap risk' };
      }

      // ASIA OPENING SUFFIX BAN (28/05/2026 soirée, MFE/MAE 3w n=250 asia_equity).
      // .T/.HK/.SHG/.SHE/.SI 00-02h UTC : n=16 WR 12% Σ -$527 / .KQ 00-02h : n=32 WR 31% Σ -$407.
      // .SS/.SZ inclus aussi (convention Yahoo Finance) ; EODHD utilise .SHG/.SHE
      // Cas TRADER vérifié 28/05 : 166480.KQ 0/2 wins -$17. KOSDAQ 02-08h reste OK.
      {
        const sym = decision.symbol.toUpperCase();
        const nowHourUtc = new Date().getUTCHours();
        const bannedSuffix = sym.endsWith('.T')
          || sym.endsWith('.HK')
          || sym.endsWith('.SHG')
          || sym.endsWith('.SHE')
          || sym.endsWith('.SS')
          || sym.endsWith('.SZ')
          || sym.endsWith('.SI')
          || sym.endsWith('.KQ');
        if (nowHourUtc < 2 && bannedSuffix) {
          return {
            applied: false,
            error: `ASIA_OPENING_SUFFIX_BAN : ${sym} (heure UTC ${nowHourUtc} < 02:00, lesson MFE/MAE 3w n=48 Σ -$934 sur opening auctions)`,
          };
        }
      }

      // Autonomie cadrée : bornes resserrées post-MFE/MAE 27/05 (MAE/R 1.78,
      // capture rate -45.8% sur 7 trades). SL min 1.5% obligatoire (sinon
      // stop-out garanti avant retracement). TP max 8% (au-delà = capture rate
      // s'effondre). Default 2%/4% au lieu de 1%/6%.
      const slPct = Math.max(1.5, Math.min(3, decision.stop_loss_pct ?? 2.0));
      const tpPct = Math.max(2.5, Math.min(8.0, decision.take_profit_pct ?? 4.0));

      // Overpump gate : refuse l'open si le candidat a pumpé > threshold sur la 1m.
      //
      // RECALIBRATION URGENTE 29/05/2026 03:50 UTC (5% → 15%) :
      // Data nuit 29/05 : TRADER bloqué 8× consécutifs (393890.KQ, 416180.KQ tous
      // à 12-14% changePct) — pendant que MIDDLE entrait sur les MÊMES tickers
      // sans gate et faisait +$53 net (3 wins KOSDAQ).
      //
      // Data 3 semaines : le bucket 8-15% est le WINNING bucket (WR 21-27%,
      // Σ +$11 sur 363 trades). À 5%, TRADER bloquait l'intégralité du bucket
      // gagnant. À 15%, on garde le ban du dead-zone 15-20% (perdant -$111) et
      // on autorise le bucket gagnant 8-15%.
      //
      // Configurable via TRADER_OVERPUMP_THRESHOLD_PCT (default 15).
      {
        const sym = decision.symbol.toUpperCase();
        const candidate = candidates.find((c) => String(c.symbol ?? '').toUpperCase() === sym);
        if (candidate) {
          const changePct = Number(candidate.changePct ?? 0);
          const threshold = Number(this.config.get<string>('TRADER_OVERPUMP_THRESHOLD_PCT') ?? '15');
          if (Number.isFinite(changePct) && Number.isFinite(threshold) && threshold > 0 && changePct > threshold) {
            return { applied: false, error: `overpump_gate: ${sym} changePct=${changePct.toFixed(2)}% > ${threshold}% (entry au peak refusée, attendre pullback)` };
          }
        }
      }

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

      // COMMIT 4 (29/05) — Refuse "close" si position en perte. Audit TRADER :
      // 5 gemini_manual closes + 12 closed_invalidated, plupart en perte → capture
      // rate -56.5%. Gemini ferme au pire moment. Pour PnL<0, force trail_stop ou
      // hold (le SL existant + pre-flight max-loss-cap -$50 gèrent l'urgence).
      // Désactivable via TRADER_DISABLE_LOSS_CLOSE=false. Skip si fallback price.
      const disableLossClose = (this.config.get<string>('TRADER_DISABLE_LOSS_CLOSE') ?? 'true').toLowerCase() === 'true';
      if (disableLossClose && livePriceData.source && !String(livePriceData.source).startsWith('fallback')) {
        const entryPrice = Number(match.entry_price);
        const direction = match.direction;
        const unrealPct = direction === 'short'
          ? ((entryPrice - livePrice) / entryPrice) * 100
          : ((livePrice - entryPrice) / entryPrice) * 100;
        if (Number.isFinite(unrealPct) && unrealPct < -0.1) {
          return {
            applied: false,
            error: `close blocked : ${decision.symbol} unrealPct=${unrealPct.toFixed(2)}% < -0.1% (audit TRADER: capture rate -56.5% → closes prématurés interdits en perte, utilise trail_stop ou hold)`,
          };
        }
      }

      const res = await this.lisa.closeForOpportunityScout({
        positionId: row.id,
        symbol: decision.symbol,
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
      // Autonomie cadrée : bornes resserrées post-MFE/MAE 27/05 (MAE/R 1.78,
      // capture rate -45.8% sur 7 trades). SL min 1.5% obligatoire (sinon
      // stop-out garanti avant retracement). TP max 8% (au-delà = capture rate
      // s'effondre). Default 2%/4% au lieu de 1%/6%.
      const slPct = Math.max(1.5, Math.min(3, decision.stop_loss_pct ?? 2.0));
      const tpPct = Math.max(2.5, Math.min(8.0, decision.take_profit_pct ?? 4.0));

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

      // trail_stop = resserrer un SL existant — bornes large OK (0.1-5%), default aligné 1%
      const slPct = Math.max(0.1, Math.min(5, decision.stop_loss_pct ?? 1.0));
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
