/**
 * MechanicalTradingService — agent de trading sans LLM.
 *
 * Tourne toutes les minutes. Pour chaque portfolio avec autopilot actif :
 *   1. Lit la directive la plus récente écrite par Lisa (via lisa_mechanical_directives).
 *   2. Ferme les positions qui atteignent leur stop-loss ou take-profit.
 *   3. Exécute les fermetures explicites demandées par Lisa (close_conditions).
 *   4. Ouvre les nouvelles positions définies dans target_symbols, sous réserve
 *      des contraintes de risque de la session.
 *
 * Coût : $0 par cycle (pas d'appel Claude).
 * La directive expire 35 min après sa génération — passé ce délai, le service
 * passe en mode défensif (fermetures uniquement, plus d'ouvertures).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import {
  computeAtrStopByKind,
  computeRealisticFee,
  computeVenueFeeDetail,
  evaluateWarmup,
  formatWarmupLog,
  resolveFeesAwareBuffer,
  type ThesisKind,
} from '@smartvest/ai-analyst';
import { mapPositionRows } from '../helpers/position.mapper';
import { isLongPosition } from '../utils/position-direction';
import { SupabaseService } from '../../supabase/supabase.service';
import { PerformanceService } from '../../performance/performance.service';
import { DecisionLogService } from './decision-log.service';
import { LisaService } from './lisa.service';
import { EodhdTechnicalService } from './eodhd-technical.service';
import { ExchangeHoursService } from './exchange-hours.service';
import { PortfolioCorrelationService } from './portfolio-correlation.service';
import { AgentLisaSyncService } from './agent-lisa-sync.service';
import { OptionBrokerService } from './option-broker.service';
import { EodhdCalendarService } from './eodhd-calendar.service';
import { BinanceMarketService } from './binance-market.service';
import { TradeOutcomeRecorderService } from './trade-outcome-recorder.service';
import { DailyProfitGovernor } from './daily-profit-governor.service';
import { PatternAdoptionService } from '../../bot-lab/services/pattern-adoption.service';
import { EodhdEnrichmentService } from './eodhd-enrichment.service';
import { isInExchangeSession } from './exchange-sessions.helper';
// Phase 5 N1 PR-1 — Quick Wins gate (sessions/blacklist/class-pause/repeat-cap/exchange-mult)
import { QuickWinsPipelineService } from '../quick-wins';
// Phase 5 N1 PR-2 — matrice TP/SL par asset_class
import { AssetClassTpSlConfigService } from './asset-class-tpsl-config.service';
import { resolveTpSlPcts } from './tpsl-resolver';
// Phase 5 N1 PR-3+PR-4 — circuit breaker + sanity R5 + warmup asymétrique
import { LisaCircuitBreakerService } from './circuit-breaker.service';
import { SanityR5Service } from './sanity-r5.service';
import { Qw3WarmupExtendedService } from '../quick-wins/qw-3-warmup-extended.service';
// Phase 5 N2 — Kelly fractional sizing per asset_class
import { AssetClassKellyConfigService } from './asset-class-kelly-config.service';

// ─────────────────────────────────────────────────────────────────────────────
// Types internes
// ─────────────────────────────────────────────────────────────────────────────

interface TargetSymbol {
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  stopLossPct: number;
  takeProfitPct: number;
  convictionScore: number;
  horizonDays: number;
  venue?: string;
  thesisId?: string;
  /** PATCH 5 — type de thèse pour calibrer la posture de risque
   *  (multiplier ATR du stop). Cf. ThesisKind dans @smartvest/ai-analyst.
   *  Default 'momentum' (1.0× ATR) si absent. */
  thesisKind?: ThesisKind;
  /** Si présent, ouvrir une option (long call/put) au lieu d'une position
   *  equity classique. Routé vers OptionBrokerService.openOption() :
   *   - direction 'long' → call (parie sur la hausse du sous-jacent)
   *   - direction 'short' → put (parie sur la baisse, sans short physique)
   *   - asymétrie naturelle : downside borné au premium payé. */
  optionStructure?: {
    /** Décalage strike vs spot, en %. 0 = ATM, 5 = +5% OTM call / −5% OTM put. */
    strikeOtmPct: number;
    /** Days-to-expiry (5-45 typiquement). */
    dteDays: number;
    /** IV implicite à l'achat (défaut 0.30 si non spécifié). */
    iv?: number;
  };
}

interface CloseCondition {
  positionId: string;
  reason: string;
  urgency: 'immediate' | 'at_stop' | 'on_next_unfavorable_price';
}

interface TacticalOverrides {
  pauseOpens?: boolean;
  pauseOpensReason?: 'stops_cluster' | 'vix_spike' | 'drawdown' | 'exposure_high' | 'choppiness' | 'regime_break';
  tightenStopsMultiplier?: number;
  minConvictionOverride?: number;
  maxNewOpensOverride?: number;
  closeLowestConvictionIfExposureAbovePct?: number;
  preferredAssetClasses?: string[];
}

interface MechanicalDirective {
  id: string;
  portfolioId: string;
  marketMomentum: 'bullish_strong' | 'neutral' | 'bearish';
  trajectoryStatus: 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';
  activeThemes: string[];
  favoredAssetClasses: string[];
  avoidedAssetClasses: string[];
  targetSymbols: TargetSymbol[];
  closeConditions: CloseCondition[];
  riskPosture: 'aggressive' | 'normal' | 'defensive';
  tacticalOverrides: TacticalOverrides;
  generatedAt: Date;
  validUntil: Date;
}

interface OpenPosition {
  id: string;
  symbol: string;
  assetClass: string;
  direction: string;
  entryPrice: string;
  entryNotionalUsd: string;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  status: string;
  autonomy_rules?: AutonomyRuleDb[] | null;
  conviction_score?: number | null;
}

interface AutonomyRuleDb {
  metric: 'vix' | 'price' | 'funding_annual_pct' | 'pnl_pct';
  op: 'gt' | 'lt' | 'gte' | 'lte';
  value: number;
  action: 'close' | 'tighten_stop' | 'scale_down_50pct' | 'take_profit';
  reason: string;
}

interface SessionConfig {
  portfolio_id: string;
  autopilot_enabled: boolean;
  kill_switch_active: boolean;
  capital_usd: string;
  risk_constraints: Record<string, unknown>;
  autopilot_market_hours_only?: boolean;
  /** Profile sniper / long_term / hyper_active. Détermine si on autorise
   *  les overrides défensifs extrêmes (Signal A-H persona). En hyper_active
   *  l'utilisateur a explicitement choisi le risque — on ignore les pause/
   *  blocage totaux pour ne pas annuler son intention. */
  profile?: string;
  enable_leverage?: boolean;
  /** Active l'exécution des propositions options (long calls/puts) via
   *  OptionBrokerService. Sans ce flag, les optionStructure dans les
   *  thèses Lisa sont skippées (la position equity est ouverte à la place). */
  enable_derivatives?: boolean;
  /** 'NONE' | 'DAILY_HARVEST'. Couplé avec profile=hyper_active, escalade
   *  la sensibilité des wake-up triggers (VIX/drawdown/position pnl)
   *  pour aligner sur l'horizon scalping. */
  capital_discipline_mode?: string;
  /** PR Gainers-autonomy — 'investment' | 'harvest' | 'gainers'. En 'gainers' :
   *  Step 0.5 wake-up Lisa, Step 1 closes Lisa et Step 3 opens Lisa sont skippés.
   *  Le scanner Gainers gère seul les ouvertures (cron dédié). Les protections
   *  capital (Step 0 drawdown, Step 0.6 news shock, Step 2 stops/TP/trailing)
   *  restent actives universellement. */
  strategy_mode?: string;
}

@Injectable()
export class MechanicalTradingService {
  private readonly logger = new Logger(MechanicalTradingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly decisionLog: DecisionLogService,
    private readonly lisa: LisaService,
    private readonly performance: PerformanceService,
    private readonly technical: EodhdTechnicalService,
    private readonly exchangeHours: ExchangeHoursService,
    private readonly correlation: PortfolioCorrelationService,
    private readonly agentLisaSync: AgentLisaSyncService,
    private readonly optionBroker: OptionBrokerService,
    private readonly earningsCalendar: EodhdCalendarService,
    private readonly binance: BinanceMarketService,
    private readonly tradeOutcomeRecorder: TradeOutcomeRecorderService,
    private readonly dailyProfitGovernor: DailyProfitGovernor,
    private readonly patternAdoption: PatternAdoptionService,
    private readonly enrichment: EodhdEnrichmentService,
    private readonly quickWins: QuickWinsPipelineService,
    private readonly tpSlConfig: AssetClassTpSlConfigService,
    private readonly circuitBreaker: LisaCircuitBreakerService,
    private readonly sanityR5: SanityR5Service,
    private readonly qw3Warmup: Qw3WarmupExtendedService,
    private readonly assetClassKelly: AssetClassKellyConfigService,
  ) {}

  /**
   * PR F — DEGRADED_OPEN mode pour HORS_TRAJECTOIRE.
   *
   * Quand le portfolio est en HORS_TRAJECTOIRE (réalisé négatif OU coûts >
   * 50% des gains 7j), le comportement par défaut est de SKIP toutes les
   * ouvertures (cf. ligne ~430 + CLAUDE.md). Mais en prod 27/04 ce
   * comportement bloque 96% des cycles → 0.00 EUR de valeur de marché.
   *
   * Le mode dégradé active des micro-positions d'apprentissage :
   *   - taille / 5 (sizingMultiplier × 0.2)
   *   - SL serré 0.5 × ATR14 (vs 1-2.2× selon thesis.kind normalement)
   *   - max 2 positions concurrentes total
   *   - whitelist tickers via env (RTX, LMT, GDX confirmés profitables)
   *
   * Strictement opt-in via `MECH_DEGRADED_MODE=true`. Whitelist via
   * `MECH_DEGRADED_WHITELIST=RTX,LMT,GDX` (CSV, case-insensitive). Pas de
   * whitelist → mode dégradé désactivé même si le flag est on (sécurité).
   */
  private getDegradedConfig(): { enabled: boolean; whitelist: Set<string> } {
    const enabledEnv = (process.env.MECH_DEGRADED_MODE ?? '').toLowerCase();
    const enabled = enabledEnv === 'true' || enabledEnv === '1';
    const rawWhitelist = process.env.MECH_DEGRADED_WHITELIST ?? '';
    const whitelist = new Set(
      rawWhitelist
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0),
    );
    // Garde-fou : sans whitelist explicite, on désactive même si le flag
    // est on. Évite qu'un opérateur active le mode et ouvre n'importe
    // quel ticker en HORS_TRAJECTOIRE.
    return { enabled: enabled && whitelist.size > 0, whitelist };
  }

  /**
   * BOT LAB Phase 4 — boucle feedback : enregistre les triggers de patterns
   * adoptés quand un trade est fermé. Permet de mesurer dans la durée si
   * les patterns adoptés tiennent leurs promesses sur les vrais trades Lisa.
   */
  private async recordPatternFeedback(
    portfolioId: string,
    assetClass: string,
    direction: string,
    pnlUsd: number,
  ): Promise<void> {
    const patterns = await this.patternAdoption.getActiveAdoptedPatterns(portfolioId);
    if (patterns.length === 0) return;

    // Note : on ne dispose pas de vix_at_entry sur la position dans
    // mechanical-trading (pas tagged). On match donc sans vix_bucket.
    const tradeContext = { assetClass, direction };

    for (const pattern of patterns) {
      // Match conditions partielles (asset_class + direction). Si le pattern
      // requiert vix_bucket, ce match sera large mais c'est OK pour le feedback.
      const conditionsForMatch: Record<string, unknown> = { ...pattern.conditions };
      delete conditionsForMatch.vix_bucket; // ignoré dans le feedback

      if (this.patternAdoption.matchesPattern(tradeContext, conditionsForMatch)) {
        await this.patternAdoption.recordTriggered(pattern.adoptionId, pnlUsd);
      }
    }
  }

  /**
   * Mappe un ticker "natif" (AAPL, BTC, EURUSD) vers un ticker EODHD
   * (AAPL.US). Pour les crypto/FX on retombe sur le ticker brut — EODHD
   * /eod supporte EURUSD.FOREX et BTC-USD.CC mais la corrélation fonctionne
   * mieux sur actions/ETF. Pour ce commit on se concentre sur equity/ETF.
   */
  private toEodhdForCorrelation(symbol: string, assetClass: string): string {
    // Defensive guard : assetClass typé string mais peut être undefined si
    // le caller passe un row Supabase non-mappé (cf. fix/position-data-integrity).
    const cls = (assetClass ?? '').toLowerCase();
    if (cls.includes('crypto')) return `${symbol.toUpperCase()}-USD.CC`;
    if (cls.includes('fx') || cls.includes('forex')) return `${symbol.toUpperCase()}.FOREX`;
    // equity / etf / commodity ETF / bond ETF → suffixe .US si pas déjà présent
    return symbol.includes('.') ? symbol : `${symbol.toUpperCase()}.US`;
  }

  /**
   * Dérive un stopPct basé sur l'ATR14 (volatilité réelle) plutôt qu'un
   * pourcentage fixe arbitraire. Objectif : le stop s'adapte à la dynamique
   * propre de chaque actif — BTC (σ élevée) aura un stop plus large que
   * SPY (σ faible), donc moins de "stops sur bruit normal".
   *
   * PATCH 5 — Multiplicateur modulé par `thesisKind` :
   *   momentum=1.0 (serré), mean_reversion=2.0 (respire), breakout=1.2,
   *   event=1.5, macro_hedge=2.2. Default 1.5 si kind absent (rétrocompat).
   *   Ceiling étendu 5% → 7% pour mean_reversion / macro_hedge avec ATR > 3%.
   *
   * Formule (cf. computeAtrStopByKind dans @smartvest/ai-analyst) :
   *   stopATR% = MULTIPLIER[kind] × ATR14% du prix actuel
   *   stopFinal% = clamp(stopATR%, FLOOR=1.0%, CEILING=7.0%)
   *   si ATR indispo → fallback sur stopPct "Lisa" (propagé)
   *
   * Le caller peut aussi récupérer recommendedSizeUsd pour appliquer un
   * sizing compensatoire (size inversement proportionnelle au stop pour
   * que le risk$ par trade reste constant). Aujourd'hui retourné mais
   * NON-appliqué automatiquement (le sizing Lisa prévaut). À câbler dans
   * un PR ultérieur quand on aura le riskPerTradePct configurable user.
   */
  private async deriveAtrStopPct(
    eodhdTicker: string,
    currentPrice: number,
    fallbackPct: number,
    thesisKind?: ThesisKind,
    capitalUsd?: number,
  ): Promise<{
    stopPct: number;
    atr14Pct: number | null;
    source: 'atr' | 'fallback';
    kindMultiplier: number;
    recommendedSizeUsd: number | null;
  }> {
    try {
      const ind = await this.technical.getIndicators(eodhdTicker, currentPrice);
      if (ind.atr14Pct != null && ind.atr14Pct > 0) {
        const result = computeAtrStopByKind(ind.atr14Pct, thesisKind, capitalUsd);
        return {
          stopPct: result.stopPct,
          atr14Pct: ind.atr14Pct,
          source: 'atr',
          kindMultiplier: result.kindMultiplier,
          recommendedSizeUsd: result.recommendedSizeUsd,
        };
      }
    } catch { /* fall through */ }
    return {
      stopPct: fallbackPct,
      atr14Pct: null,
      source: 'fallback',
      kindMultiplier: thesisKind
        ? (computeAtrStopByKind(0, thesisKind).kindMultiplier)
        : 1.5,
      recommendedSizeUsd: null,
    };
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'mechanical-trading' })
  async runMechanicalCycle(): Promise<void> {
    if (!this.supabase.isReady()) return;

    const currentHourUtc = new Date().getUTCHours();
    const inMarketHours = currentHourUtc >= 7 && currentHourUtc < 20;

    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('*')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error || !configs?.length) return;

    for (const cfg of configs as SessionConfig[]) {
      // ⚠️ CHANGEMENT IMPORTANT (avr 2026) : on n'écarte PLUS le portfolio
      // entier hors heures de marché. Sinon les stops/take-profits crypto
      // (BTC/ETH 24/7) ne sont plus contrôlés la nuit → trou de protection.
      // Désormais : `skipNewOpens` est calculé ici, processPortfolio garde
      // toujours les Steps 0-2 (drawdown guard, autonomy rules, agent-Lisa
      // sync, closes Lisa, stop/take-profit) et ne skippe que le Step 3
      // (ouverture de nouvelles positions par Lisa) si market_hours_only
      // est activé hors fenêtre.
      const skipNewOpens = !!cfg.autopilot_market_hours_only && !inMarketHours;
      try {
        await this.processPortfolio(cfg, skipNewOpens);
      } catch (e) {
        this.logger.error(`Mechanical cycle failed for ${cfg.portfolio_id}: ${String(e)}`);
      }
    }
  }

  private async processPortfolio(cfg: SessionConfig, skipNewOpens: boolean = false): Promise<void> {
    const portfolioId = cfg.portfolio_id;

    // Load latest valid directive
    const directive = await this.loadDirective(portfolioId);

    // Load open positions — mapPositionRows ajoute les alias camelCase aux
    // colonnes snake_case de Supabase (entry_price → entryPrice, etc.).
    // SANS ce mapping, `pos.stopLossPrice` / `pos.takeProfitPrice` /
    // `pos.assetClass` étaient undefined → checkStopTarget early-return
    // ligne ~1446 → stops jamais déclenchés (incident 27/04/2026).
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const openPositions: OpenPosition[] = mapPositionRows(positions) as unknown as OpenPosition[];

    // Step 0 — P4.1 Portfolio Drawdown Guard (protection capital niveau portefeuille)
    // Vérifie le drawdown intraday AVANT toute autre action. Si franchi :
    //   - kill-switch auto (default -1.0%) → ferme TOUTES les positions + désactive autopilot
    //   - close-weakest (default -0.5%) → ferme la position plus faible, bloque les ouvertures
    const guard = await this.checkPortfolioDrawdownGuard(cfg, openPositions);
    if (guard === 'kill_switch_triggered') return;  // tout fermé, fin de cycle

    // Step 0bis — Évaluation des AutonomyRules (Phase 2)
    // Pour chaque position avec autonomy_rules, évalue les triggers en live
    // (vix, price, funding, pnl_pct) et exécute l'action correspondante
    // (close, tighten_stop, scale_down_50pct, take_profit).
    // Permet une réactivité H24 entre les cycles Lisa (15-20 min).
    // Non-bloquant : si une règle échoue, on continue avec les suivantes.
    await this.evaluateAutonomyRules(portfolioId, openPositions)
      .catch((e) => this.logger.warn(`AutonomyRules eval failed: ${String(e).slice(0, 120)}`));

    // Step 0.5 — P5.1 Agent ↔ Lisa interactive loop
    // Détecte les triggers Tier 1 (drawdown proche kill-switch, position en
    // souffrance, VIX spike) et réveille Lisa pour ré-analyse contextuelle.
    // Non-bloquant : échec Lisa n'interrompt pas le cycle mécanique.
    // Budget 8 wake-ups/jour + cooldown 5min par trigger pour éviter le spam.
    //
    // PR Gainers-autonomy — skip en mode 'gainers' : Lisa LLM est totalement
    // déconnectée. Les protections capital (Step 0 drawdown, Step 0.6 news shock,
    // Step 2 stops/TP/trailing) suffisent pour ce mode déterministe.
    const isGainersMode = (cfg.strategy_mode as string | null | undefined) === 'gainers';
    if (!isGainersMode) {
      await this.triggerAgentLisaSyncIfNeeded(cfg, openPositions)
        .catch((e) => this.logger.warn(`[P5.1] Agent sync eval failed: ${String(e).slice(0, 120)}`));
    }

    // Step 0.6 — Close réactif sur news contraires fraîches.
    // Ne réveille pas Lisa : ferme directement avant qu'un wake-up Lisa
    // ne tarde 5-20 min. Critères stricts (sentiment ≤ -0.6, age < 30 min,
    // direct hit ticker tenu) pour éviter les faux positifs.
    await this.checkNewsShockClose(openPositions)
      .catch((e) => this.logger.warn(`[news-shock-close] eval failed: ${String(e).slice(0, 120)}`));

    // Step 1 — Explicit close requests from Lisa
    // PR Gainers-autonomy — en mode 'gainers' Lisa LLM ne tourne pas, donc
    // aucune directive n'est générée. On skip explicitement par sécurité au
    // cas où une directive obsolète traînerait en DB (ex: bascule investment
    // → gainers). Les closes Gainers passent par Step 2 (stops/TP) uniquement.
    if (directive && !isGainersMode) {
      for (const cond of directive.closeConditions) {
        if (cond.urgency !== 'immediate') continue;
        const pos = openPositions.find((p) => p.id === cond.positionId);
        if (!pos) continue;
        const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
        if (!quote) continue;
        // 🛡️ Garde-fou prix fallback (cf. checkStopTarget pour rationale)
        if (this.isFallbackSource(quote.source)) {
          this.logger.warn(`[FALLBACK_GUARD] close_invalidated ${pos.symbol} skip — source=${quote.source}`);
          continue;
        }
        await this.closePosition(pos.id, quote.price, 'closed_invalidated',
          `[MÉCANIQUE] Lisa: ${cond.reason}`);
      }
    }

    // Reload open positions after explicit closes
    const { data: positionsAfterClose } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const currentPositions: OpenPosition[] = mapPositionRows(positionsAfterClose) as unknown as OpenPosition[];

    // Step 2 — Stop-loss / take-profit checks (toutes positions, pas besoin de directive)
    const isHyperActiveProfile = cfg.profile === 'hyper_active';
    for (const pos of currentPositions) {
      await this.checkStopTarget(pos, isHyperActiveProfile);
    }

    // Si le guard a fermé la plus faible → on bloque les nouvelles ouvertures
    // mais on laisse les stops/targets tourner (déjà fait ci-dessus).
    if (guard === 'weakest_closed_block_opens') return;

    // Hors heures de marché si le user a coché market_hours_only : on a
    // déjà fait tourner les stops/take-profits (Step 2) — on saute juste
    // l'ouverture de nouvelles positions. Crypto = protégé H24, Lisa
    // n'ouvre rien la nuit.
    if (skipNewOpens) {
      await this.writeDefensiveCycleSummary(portfolioId, currentPositions)
        .catch((e) => this.logger.debug(`defensive summary failed: ${String(e).slice(0, 80)}`));
      return;
    }

    // Step 3 — Open new positions (seulement si directive valide + trajectoire permet)
    // PR Gainers-autonomy — en mode 'gainers' les ouvertures sont gérées
    // exclusivement par TopGainersScannerService (cron dédié). Le mécanique
    // ne doit JAMAIS ouvrir de positions Lisa-driven en parallèle.
    if (isGainersMode) {
      await this.writeDefensiveCycleSummary(portfolioId, currentPositions)
        .catch((e) => this.logger.debug(`defensive summary failed: ${String(e).slice(0, 80)}`));
      return;
    }

    if (!directive || directive.validUntil <= new Date()) {
      if (directive) {
        this.logger.debug(`${portfolioId}: directive expirée — mode défensif uniquement`);
      }
      // Même sans directive valide, on écrit un cycle summary "défensif" pour
      // que l'UI montre que le mécanique a bien tourné (sinon affiche dernier
      // summary stale, ex: "il y a 752 min" alors que les ticks 60s tournent).
      // Coût : 1 INSERT/min négligeable.
      await this.writeDefensiveCycleSummary(portfolioId, currentPositions)
        .catch((e) => this.logger.debug(`defensive summary failed: ${String(e).slice(0, 80)}`));
      return;
    }

    // HORS_TRAJECTOIRE → préservation du capital, aucune ouverture par défaut.
    // Bypass autorisé si : ≥ 30 cycles mécaniques sans opens (= 30 min de gel)
    // ET Lisa a délibérément proposé ≥ 1 thèse A+ malgré sa règle STOP+DIAGNOSTIC.
    // Logique : si Lisa, qui sait qu'elle est en HT, propose quand même quelque
    // chose après long gel, c'est qu'elle a un setup A+ qui justifie l'exception.
    // Le mécanique respecte cette intention plutôt que de bloquer mécaniquement.
    const htConsecutiveZero = await this.countConsecutiveZeroOpenCycles(portfolioId);
    const htBypassAllowed =
      directive.trajectoryStatus === 'HORS_TRAJECTOIRE' &&
      htConsecutiveZero >= 30 &&
      directive.targetSymbols.length >= 1;

    // PR F — DEGRADED_OPEN : autorise des micro-ouvertures d'apprentissage
    // en HORS_TRAJECTOIRE, sous whitelist ticker stricte + sizing /5 + SL
    // serré 0.5×ATR. Strictement opt-in via env MECH_DEGRADED_MODE=true
    // ET whitelist non-vide via MECH_DEGRADED_WHITELIST=RTX,LMT,GDX.
    // Cf. PR feat/mech-degraded-open (incident 27/04 — 96% cycles bloqués).
    const degradedConfig = this.getDegradedConfig();
    const degradedActive =
      directive.trajectoryStatus === 'HORS_TRAJECTOIRE' &&
      !htBypassAllowed &&
      degradedConfig.enabled;

    if (directive.trajectoryStatus === 'HORS_TRAJECTOIRE' && !htBypassAllowed && !degradedActive) {
      this.logger.debug(`${portfolioId}: HORS_TRAJECTOIRE — ouvertures suspendues, protection capital`);
      await this.writeDefensiveCycleSummary(portfolioId, currentPositions)
        .catch((e) => this.logger.debug(`defensive summary failed: ${String(e).slice(0, 80)}`));
      return;
    }
    if (degradedActive) {
      this.logger.log(
        `[MECH_DEGRADED] ${portfolioId.slice(0, 8)} — HORS_TRAJECTOIRE + flag actif → micro-ouvertures (size/5, SL 0.5×ATR, max 2 concurrent, whitelist=${[...degradedConfig.whitelist].join(',')})`,
      );
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: `[MECH_DEGRADED] HORS_TRAJECTOIRE bypass-learn activé — sizing /5, SL serré, whitelist ${[...degradedConfig.whitelist].length} tickers`,
        rationale:
          'MECH_DEGRADED_MODE=true : autorise des micro-positions d\'apprentissage sur tickers historiquement profitables même en HORS_TRAJECTOIRE, plutôt que de figer le bot et accumuler 0 P&L pendant des heures.',
        payload: {
          whitelist: [...degradedConfig.whitelist],
          consecutive_zero_cycles: htConsecutiveZero,
          target_symbols_count: directive.targetSymbols.length,
        },
        triggeredBy: 'mechanical_cron',
      });
    }
    if (htBypassAllowed) {
      this.logger.log(
        `[HT_BYPASS] ${portfolioId.slice(0, 8)} — ${htConsecutiveZero} cycles sans opens + Lisa propose ${directive.targetSymbols.length} thèse(s) A+ → Step 3 débloqué (1 ouverture max)`,
      );
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: `[HT_BYPASS] HORS_TRAJECTOIRE débloqué après ${htConsecutiveZero} cycles inactifs — Lisa a proposé ${directive.targetSymbols.length} thèse(s) A+, 1 exception autorisée`,
        rationale:
          'Évite la paralysie perpétuelle quand HT persiste : le mécanique fait confiance à Lisa qui a délibérément bypassé sa règle STOP+DIAGNOSTIC pour proposer 1 setup A+.',
        payload: {
          consecutive_zero_cycles: htConsecutiveZero,
          target_symbols_count: directive.targetSymbols.length,
        },
        triggeredBy: 'mechanical_cron',
      });
    }

    // === Overrides tactiques de Lisa (golden-trader) — s'appliquent AVANT le flow trajectoire ===
    const rawOverrides = directive.tacticalOverrides ?? {};

    // Auto-relax : si N cycles consécutifs ont ouvert 0 position ET que des
    // overrides défensifs sont actifs, on les relâche progressivement pour
    // éviter qu'un wake-up ponctuel paralyse le système indéfiniment.
    const consecutiveZeroOpens = htConsecutiveZero;
    const overrides = await this.relaxDefensiveOverrides(
      rawOverrides,
      consecutiveZeroOpens,
      directive.trajectoryStatus,
      portfolioId,
    );

    // BYPASS HYPER_ACTIVE — quand l'utilisateur a explicitement choisi le mode
    // aggressive (profile=hyper_active + enable_leverage=true), on ignore les
    // pauses TOTALES (pauseOpens, maxNewOpens=0) émises par les Signaux A-H
    // de la persona. Sinon le mode aggressive est annulé par les garde-fous
    // automatiques de Lisa qui le sur-protègent contre sa propre intention.
    // Les overrides "modérés" (tightenStops, minConviction réduit) restent
    // actifs — on cap juste les valeurs extrêmes.
    const isHyperAggressive =
      cfg.profile === 'hyper_active' && cfg.enable_leverage === true;

    // Lisa a explicitement demandé une pause → aucune ouverture ce cycle
    // (sauf en mode hyper_active où on ignore le pauseOpens auto)
    if (overrides.pauseOpens === true && !isHyperAggressive) {
      this.logger.log(
        `[MÉCANIQUE] ${portfolioId.slice(0, 8)} — pauseOpens=true (reason=${overrides.pauseOpensReason ?? 'unspecified'}) — skip ouvertures`,
      );
      await this.writeDefensiveCycleSummary(portfolioId, currentPositions)
        .catch((e) => this.logger.debug(`defensive summary failed: ${String(e).slice(0, 80)}`));
      return;
    }
    if (overrides.pauseOpens === true && isHyperAggressive) {
      this.logger.log(
        `[HYPER_ACTIVE BYPASS] ${portfolioId.slice(0, 8)} — pauseOpens ignoré (mode aggressive choisi explicitement)`,
      );
    }

    // Reload open positions after stop/target checks
    const { data: positionsForOpen } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const activePositions: OpenPosition[] = mapPositionRows(positionsForOpen) as unknown as OpenPosition[];

    const constraints = cfg.risk_constraints ?? {};
    // P4.3 — Defaults golden-trader diversifiés :
    //   - Plus de positions (20 vs 10) → réduit la variance idiosyncratique
    //   - Positions unitaires plus petites (8% vs 25%) → cap la perte par ticker
    //   - Plafond par classe d'actif (25%) → évite la concentration sectorielle
    // On supporte les deux conventions de clé pour le cap par classe :
    //   - maxExposurePerAssetClassPct (ancienne convention SmartVest, déjà
    //     présente dans les configs existantes)
    //   - maxAssetClassExposurePct (nouvelle convention P4.3)
    // La nouvelle prend priorité si présente, sinon on lit l'ancienne, sinon default.
    const maxPositions = (constraints['maxOpenPositions'] as number) ?? 20;
    const maxPositionPct = (constraints['maxPositionSizePct'] as number) ?? 8;
    const maxAssetClassPct =
      (constraints['maxAssetClassExposurePct'] as number) ??
      (constraints['maxExposurePerAssetClassPct'] as number) ??
      25;
    const capitalUsd = new Decimal(cfg.capital_usd || '10000');

    if (activePositions.length >= maxPositions) return;

    // Calcul de l'exposition courante par classe d'actif (pour enforcement P4.3)
    const readNotionalPos = (p: OpenPosition) =>
      Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
    const readAssetClass = (p: OpenPosition) =>
      String((p as unknown as Record<string, unknown>)['asset_class'] ?? '').toLowerCase();
    const exposureByClass = new Map<string, number>();
    for (const p of activePositions) {
      const cls = readAssetClass(p);
      exposureByClass.set(cls, (exposureByClass.get(cls) ?? 0) + readNotionalPos(p));
    }

    // PATCH 2 (PR#2 P0) — Bloc P4.3 2-way (post-close) SUPPRIMÉ.
    //
    // Rationale incident LMT 27/04/2026 :
    //   16:12:55 — Lisa propose 2 thèses (GDX commodities + LMT equity)
    //              au cycle. Le pré-check P4.3 (ligne 887-899) refuse
    //              correctement LMT car projected = (RTX 2000 + LMT 1800) /
    //              10000 = 38% > cap 28%. MAIS le post-check 2-way s'exécutait
    //              en plus, et ferme la "weakest" → le système fermait des
    //              positions VIRTUELLES (race avec ouverture juste avant).
    //   16:13:08 — Post-check ferme LMT 13s après ouverture, P&L -$3.60 frais.
    //
    // La seule source de vérité pour le cap classe est désormais le pré-check
    // INCRÉMENTAL ligne 887-899 + 996. La map `exposureByClass` est mise à
    // jour APRÈS chaque insert réussi (ligne 996). Suffisant et déterministe.
    //
    // Helper readConviction conservé car utilisé par d'autres branches (ex:
    // override closeLowestConvictionIfExposureAbovePct ligne ~568).
    const readConviction = (p: OpenPosition): number | null => {
      const v = (p as unknown as Record<string, unknown>)['conviction_score'];
      const n = v == null ? null : Number(v);
      return n != null && Number.isFinite(n) ? n : null;
    };

    // Override : fermer la plus basse conviction si exposition > seuil.
    // Tri prioritaire sur conviction_score (vrai score Lisa), fallback
    // sur notional pour les positions héritées sans score explicite.
    if (overrides.closeLowestConvictionIfExposureAbovePct != null && activePositions.length > 0) {
      const readNotional = (p: OpenPosition) =>
        Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
      const totalExposure = activePositions.reduce((s, p) => s + readNotional(p), 0);
      const exposurePct = capitalUsd.gt(0) ? (totalExposure / capitalUsd.toNumber()) * 100 : 0;
      if (exposurePct > overrides.closeLowestConvictionIfExposureAbovePct) {
        const weakest = [...activePositions].sort((a, b) => {
          const ca = readConviction(a);
          const cb = readConviction(b);
          if (ca != null && cb != null && ca !== cb) return ca - cb;
          if (ca != null && cb == null) return -1;
          if (ca == null && cb != null) return 1;
          return readNotional(a) - readNotional(b);
        })[0];
        if (weakest) {
          const quote = await this.lisa.getLivePrice(weakest.symbol).catch(() => null);
          if (quote && !this.isFallbackSource(quote.source)) {
            await this.closePosition(
              weakest.id,
              quote.price,
              'closed_invalidated',
              `[MÉCANIQUE] Override Lisa: exposition ${exposurePct.toFixed(1)}% > seuil ${overrides.closeLowestConvictionIfExposureAbovePct}% — fermeture plus basse conviction`,
            );
          } else if (quote) {
            this.logger.warn(`[FALLBACK_GUARD] override_close ${weakest.symbol} skip — source=${quote.source}`);
          }
        }
      }
    }

    // Get available cash from snapshot
    const { data: snap } = await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .select('cash_usd')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    const cashUsd = new Decimal(snap?.cash_usd ?? capitalUsd.toString());
    if (cashUsd.lt(10)) return; // pas assez de cash

    // Sizing multiplier : combine trajectoire × momentum pour optimiser
    // l'atteinte de l'objectif. La trajectoire PRIME sur le momentum.
    let sizingMultiplier = 1.0;
    if (directive.trajectoryStatus === 'EN_RETARD') {
      // On rattrape le retard — max size, pleins pots si momentum le permet
      sizingMultiplier = directive.marketMomentum === 'bearish' ? 0.9 : 1.25;
    } else if (directive.trajectoryStatus === 'DANS_LE_PLAN') {
      sizingMultiplier =
        directive.marketMomentum === 'bullish_strong' ? 1.1 :
        directive.marketMomentum === 'bearish' ? 0.8 : 1.0;
    } else if (directive.trajectoryStatus === 'EN_AVANCE') {
      // Marge avant objectif — on lock les gains, sélectivité accrue
      sizingMultiplier = 0.7;
    }

    // PR F — DEGRADED_OPEN : taille / 5 (micro-positions d'apprentissage).
    // S'applique APRÈS le multiplicateur de trajectoire pour préserver la
    // logique métier (HORS_TRAJECTOIRE n'a pas de multiplicateur dédié dans
    // le flow nominal — le mode dégradé est l'unique cas où on peut ouvrir).
    if (degradedActive) {
      sizingMultiplier *= 0.2;
    }

    // Plafond de nouvelles ouvertures par cycle selon trajectoire
    const openCapFromTrajectory =
      directive.trajectoryStatus === 'EN_RETARD' ? 4 :
      directive.trajectoryStatus === 'EN_AVANCE' ? 1 : 2;

    // Override Lisa : maxNewOpensOverride ne peut que RÉDUIRE, jamais relâcher.
    // En mode hyper_active aggressive, on plancher à 1 (au lieu de 0) pour
    // permettre AU MOINS une ouverture par cycle quand l'utilisateur a choisi
    // explicitement ce risque.
    const rawMaxNewOpens = overrides.maxNewOpensOverride;
    const effectiveMaxNewOpens =
      isHyperAggressive && rawMaxNewOpens != null && rawMaxNewOpens === 0
        ? null // ignore le blocage total
        : rawMaxNewOpens;
    let openCap = effectiveMaxNewOpens != null
      ? Math.min(openCapFromTrajectory, effectiveMaxNewOpens)
      : openCapFromTrajectory;

    // PR F — DEGRADED_OPEN : max 2 positions concurrentes total (positions
    // déjà tenues + nouvelles ouvertures du cycle). Cap dur, indépendant
    // du multiplicateur d'overrides Lisa.
    if (degradedActive) {
      const remainingSlots = Math.max(0, 2 - currentPositions.length);
      openCap = Math.min(openCap, remainingSlots);
    }

    // Override Lisa : conviction minimum (surcharge le seuil EN_AVANCE).
    // En mode hyper_active, on cap le minConviction à 6 max — sinon Lisa
    // peut imposer 8/10 et personne ne passe.
    const minConvictionFromTrajectory = directive.trajectoryStatus === 'EN_AVANCE' ? 7 : 0;
    const rawMinConviction = overrides.minConvictionOverride;
    const cappedMinConviction =
      isHyperAggressive && rawMinConviction != null && rawMinConviction > 6
        ? 6
        : rawMinConviction;
    const minConviction = cappedMinConviction != null
      ? Math.max(minConvictionFromTrajectory, cappedMinConviction)
      : minConvictionFromTrajectory;

    // Override Lisa : stops serrés (multiplier < 1 = stops plus proches du prix d'entrée)
    // En mode hyper_active, plancher le stopsMultiplier à 0.95 (stops à
    // peine resserrés) pour ne pas laisser Lisa trop serrer (0.7-0.85)
    // alors que l'utilisateur veut respirer.
    const rawStopsMult = typeof overrides.tightenStopsMultiplier === 'number'
      ? overrides.tightenStopsMultiplier
      : 1.0;
    const stopsMult = isHyperAggressive && rawStopsMult < 0.95 ? 0.95 : rawStopsMult;

    // Override Lisa : classes d'actifs préférées (filtrage positif, si défini)
    const preferredClasses = Array.isArray(overrides.preferredAssetClasses) && overrides.preferredAssetClasses.length > 0
      ? new Set(overrides.preferredAssetClasses)
      : null;

    // P4.4 — Crisis regime detection : on calcule la corrélation moyenne
    // des positions ouvertes actuellement avec SPY. Si > 0.85, c'est que
    // "correlation goes to 1 in a crisis" → on refuse toutes les nouvelles
    // ouvertures ce cycle pour ne pas empiler du beta risk.
    const crisisCorrThreshold = Number((constraints['crisisCorrelationThreshold'] as number | undefined) ?? 0.85);
    let crisisRegimeActive = false;
    if (activePositions.length >= 3) {
      const eodhdTickers = activePositions
        .map((p) => this.toEodhdForCorrelation(p.symbol, readAssetClass(p)))
        .filter((t) => t.endsWith('.US'));  // uniquement actions/ETF US pour bench SPY
      if (eodhdTickers.length >= 3) {
        const { avg, n } = await this.correlation.getAvgCorrelationWithBenchmark(eodhdTickers, 'SPY.US', 30);
        if (avg != null && avg > crisisCorrThreshold) {
          crisisRegimeActive = true;
          this.logger.warn(
            `[P4.4] ${portfolioId.slice(0, 8)} CRISIS REGIME detected: avg_corr_vs_SPY=${avg.toFixed(2)} > ${crisisCorrThreshold} (n=${n}) — ouvertures bloquées`,
          );
          await this.decisionLog.append({
            portfolioId,
            kind: 'market_regime_changed',
            summary: `[P4.4] Regime crisis détecté : corrélation moyenne positions ↔ SPY = ${avg.toFixed(2)} > seuil ${crisisCorrThreshold} — ouvertures bloquées ce cycle`,
            rationale: 'Correlation regime shock : en crise, toutes corrélations convergent vers 1, la diversification ne protège plus. Mode défensif.',
            payload: {
              avg_correlation_vs_spy: avg,
              threshold: crisisCorrThreshold,
              sample_size: n,
              positions_scanned: eodhdTickers.length,
            },
            triggeredBy: 'risk_monitor',
          });
        }
      }
    }

    // Si crisis regime → on sort immédiatement (pas d'ouvertures)
    if (crisisRegimeActive) return;

    // P4.2 — Pré-calcul des tickers EODHD des positions existantes pour
    // vérifier la corrélation des nouvelles propositions contre elles.
    const existingEodhdTickers = activePositions.map((p) =>
      this.toEodhdForCorrelation(p.symbol, readAssetClass(p)),
    );
    const maxPairwiseCorrThreshold = Number((constraints['maxPairwiseCorrelation'] as number | undefined) ?? 0.7);

    // Cap "first wave" en hyper_active : on limite le notional CUMULÉ
    // ouvert dans un même cycle à 50 % du capital. Évite que 3 thèses
    // consécutives à 30 % chacune saturent le cash en 1 cycle (puis Lisa
    // ne peut plus rien proposer pendant 30+ min).
    // Cap "per position" en hyper_active : on plafonne maxPositionPct à
    // 25 % pour les ouvertures (le user peut toujours atteindre 80 % par
    // accumulation sur plusieurs cycles, mais pas en un seul).
    const isHyperActive = cfg.profile === 'hyper_active';
    const cycleNotionalCap = isHyperActive
      ? capitalUsd.mul(0.5)
      : capitalUsd; // pas de cap cumulé hors hyper_active
    const effectiveMaxPositionPct = isHyperActive
      ? Math.min(maxPositionPct, 25)
      : maxPositionPct;
    let cycleNotionalUsed = new Decimal(0);

    let slotsUsed = 0;

    // DAILY_HARVEST gatekeeper — bloque toutes les ouvertures du cycle si
    // état terminal de session (DAILY_LOCKED, LOSS_LIMIT_HIT, SESSION_CLOSED,
    // ou TARGET_HIT avec stopTradingWhenTargetHit). Inerte si mode != DAILY_HARVEST.
    const harvestGate = await this.dailyProfitGovernor.canOpenPosition(cfg.portfolio_id);
    if (!harvestGate.allowed) {
      this.logger.log(`[DAILY_HARVEST] Cycle skip ouvertures: ${harvestGate.reason}`);
      await this.decisionLog.append({
        portfolioId: cfg.portfolio_id,
        kind: 'daily_harvest_block_new_entries',
        summary: `Ouvertures bloquées (state: ${harvestGate.state})`,
        rationale: harvestGate.reason ?? 'Mode DAILY_HARVEST en état non-tradant',
        payload: {
          state: harvestGate.state,
          targetCount: directive.targetSymbols.length,
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => null);
      return; // skip toutes les ouvertures
    }

    for (const target of directive.targetSymbols) {
      if (activePositions.length + slotsUsed >= maxPositions) break;
      if (slotsUsed >= openCap) break; // plafond trajectoire (éventuellement réduit par override)

      // PR F — DEGRADED_OPEN : whitelist ticker stricte. Si en mode dégradé
      // ET le ticker n'est PAS dans la whitelist, on skip (pas d'ouverture
      // sauvage en HORS_TRAJECTOIRE).
      if (degradedActive && !degradedConfig.whitelist.has(target.symbol.toUpperCase())) {
        this.logger.debug(`[MECH_DEGRADED] skip ${target.symbol}: not in whitelist`);
        continue;
      }

      // Filtre conviction (trajectoire + override Lisa)
      if (target.convictionScore < minConviction) continue;

      // Skip si asset class évitée
      if (directive.avoidedAssetClasses.includes(target.assetClass)) continue;

      // Si Lisa a défini preferredAssetClasses, on filtre positivement
      if (preferredClasses && !preferredClasses.has(target.assetClass)) continue;

      // Skip si position déjà ouverte sur ce symbole
      const alreadyOpen = activePositions.some(
        (p) => p.symbol.toUpperCase() === target.symbol.toUpperCase(),
      );
      if (alreadyOpen) continue;

      // Phase 5 N1 PR-1+PR-3+PR-4 — Quick Wins gate (no-op si QUICK_WINS_PIPELINE_ENABLED=false).
      // Cascade : CircuitBreaker → QW#46 → #47 → #1 → #6 → #11 → #9 → #27 → #4 → #17 → #15 → #18.
      let qwSizingMultiplier = 1.0;
      const qwResult = await this.quickWins.evaluate({
        symbol: target.symbol,
        assetClass: target.assetClass,
        timestamp: new Date().toISOString(),
        score: target.convictionScore,
        portfolioId,
      });
      if (qwResult.decision === 'block') {
        this.logger.debug(
          `[QW] skip ${target.symbol} — blocked by ${qwResult.blockedBy}: ${qwResult.reason}`,
        );
        continue;
      }
      if (qwResult.decision === 'modify') {
        qwSizingMultiplier = qwResult.sizingMultiplier;
        this.logger.debug(
          `[QW] ${target.symbol} sizing ×${qwSizingMultiplier.toFixed(2)} (${qwResult.modifications.join(', ')})`,
        );
      }

      // Skip si le marché n'est pas ouvert — évite les ouvertures à prix
      // stale en afterhours/weekend/holiday qui gappent au réveil.
      const marketState = this.exchangeHours.getMarketState(target.symbol, target.assetClass);
      if (!marketState.isOpen) {
        this.logger.debug(
          `[MÉCANIQUE] Skip ${target.symbol} — marché ${this.exchangeHours.summarize(marketState)}`,
        );
        continue;
      }

      // EARNINGS FILTER — refuse les ouvertures equity dont les earnings
      // tombent dans la fenêtre d'horizon de la position. Un earnings est
      // un évènement binaire (gap ±5-15% possible) qui détruit le R/R sniper.
      // Pour une thèse 5j horizon, on bloque si earnings < 5+1 jours.
      // Skip pour les options (jouées explicitement event-driven en option).
      // Skip pour ETF/FX/crypto via isEarningsRelevant() interne.
      if (!target.optionStructure) {
        const horizonBufferDays = (target.horizonDays ?? 3) + 1;
        const hasEarnings = await this.earningsCalendar
          .hasEarningsWithinDays(target.symbol, horizonBufferDays)
          .catch(() => false);
        if (hasEarnings) {
          const nextDate = await this.earningsCalendar
            .getNextEarningsDate(target.symbol, horizonBufferDays)
            .catch(() => null);
          this.logger.log(
            `[MÉCANIQUE] Skip ${target.symbol} — earnings ${nextDate ?? '?'} dans la fenêtre horizon ${target.horizonDays}j (event binaire à éviter)`,
          );
          continue;
        }
      }

      // P4.2 — Filtre corrélation : refuse l'ouverture si fortement corrélée
      // avec une position existante (défault 0.7). Évite la concentration
      // cachée (AMD + NVDA + INTC = 1 cluster "semi" en réalité).
      if (existingEodhdTickers.length > 0) {
        const newEodhd = this.toEodhdForCorrelation(target.symbol, target.assetClass);
        const { max: maxCorr, withTicker } = await this.correlation.getMaxCorrelationAgainst(
          newEodhd,
          existingEodhdTickers,
          30,
        );
        if (maxCorr != null && maxCorr > maxPairwiseCorrThreshold) {
          this.logger.debug(
            `[P4.2] Skip ${target.symbol} — corrélation ${maxCorr.toFixed(2)} > ${maxPairwiseCorrThreshold} avec ${withTicker}`,
          );
          continue;
        }
      }

      // Prix live
      const quote = await this.lisa.getLivePrice(target.symbol).catch(() => null);
      if (!quote || Number(quote.price) <= 0) continue;
      // 🛡️ Garde-fou : ne JAMAIS ouvrir une position à un prix fallback
      // (cf. incident 26/04 — LMT ouvert à $513 vrai puis liquidé à fallback $100).
      if (this.isFallbackSource(quote.source)) {
        this.logger.warn(`[FALLBACK_GUARD] open_target ${target.symbol} skip — source=${quote.source}`);
        continue;
      }

      const price = new Decimal(quote.price);

      // Taille de position (trajectoire + momentum)
      // En hyper_active, effectiveMaxPositionPct cape à 25 % (cf. ci-dessus).
      //
      // Phase 5 N2 — Kelly fractional sizing override par asset_class :
      // si la matrice Kelly retourne un notional pour cette classe (edge positif
      // détecté, sample_size >= 30), on l utilise comme BASE en lieu et place du
      // calcul capital × pct. Les multipliers QW#15 / QW#18 / directive sizing
      // s appliquent ENSUITE en aval pour booster / couper sur cette base.
      const kellyNotional = this.assetClassKelly.getNotionalUsd(target.assetClass);
      const baseNotional = kellyNotional !== null
        ? new Decimal(kellyNotional)
        : capitalUsd.mul(effectiveMaxPositionPct).div(100);
      if (kellyNotional !== null) {
        const defaultBase = capitalUsd.mul(effectiveMaxPositionPct).div(100);
        this.logger.log(
          `[Kelly] ${target.symbol} (${target.assetClass}) base notional override: $${kellyNotional.toFixed(0)} (vs default $${defaultBase.toFixed(0)})`,
        );
      }
      const maxNotional = baseNotional.mul(sizingMultiplier).mul(qwSizingMultiplier);
      // Cap "first wave" : si on a déjà ouvert près de cycleNotionalCap
      // dans ce cycle, on réduit le notional restant pour ne pas dépasser.
      const remainingCycleBudget = cycleNotionalCap.minus(cycleNotionalUsed);
      const notional = Decimal.min(maxNotional, cashUsd.mul(0.9), remainingCycleBudget);
      if (notional.lt(10)) {
        if (isHyperActive && cycleNotionalUsed.gte(cycleNotionalCap.mul(0.95))) {
          this.logger.debug(`[hyper_active] cycle budget cap reached for ${target.symbol} — saving cash for next cycle`);
        }
        continue;
      }

      // ─── ROUTING OPTIONS ───────────────────────────────────────────────
      // Si la thèse Lisa contient optionStructure, on ouvre une option (long
      // call/put) au lieu de la position equity. Asymétrie : downside borné
      // au premium payé. Conditions :
      //  - enableDerivatives doit être activé sur la session (sinon skip)
      //  - le notional cible devient le PREMIUM target pour OptionBroker
      // En cas d'échec d'ouverture (ex. premium > cash), on saute le ticker
      // sans fallback en equity (intent Lisa explicite).
      if (target.optionStructure) {
        if (!cfg.enable_derivatives) {
          this.logger.debug(
            `[OPTIONS] Skip ${target.symbol} — optionStructure proposé mais enable_derivatives=false`,
          );
          continue;
        }
        const otm = target.optionStructure.strikeOtmPct / 100;
        const strike =
          target.direction === 'long' ? price.toNumber() * (1 + otm) : price.toNumber() * (1 - otm);
        const expiryDate = new Date(Date.now() + target.optionStructure.dteDays * 86_400_000);
        const expiry = expiryDate.toISOString().slice(0, 10);
        const iv = target.optionStructure.iv ?? 0.30;

        const result = await this.optionBroker.openOption({
          portfolioId,
          thesisId: target.thesisId ?? null,
          underlying: target.symbol,
          assetClass: target.assetClass,
          kind: target.direction === 'long' ? 'call' : 'put',
          strike,
          expiry,
          premiumTargetUsd: notional.toNumber(),
          underlyingPrice: price.toNumber(),
          iv,
          convictionScore: target.convictionScore,
          source: 'mechanical',
        });
        if (result) {
          slotsUsed++;
          cycleNotionalUsed = cycleNotionalUsed.plus(notional);
          this.logger.log(
            `[OPTIONS] Ouverture ${result.kind} ${target.symbol} K=${strike.toFixed(2)} exp=${expiry} contracts=${result.contracts} premium=$${Number(result.premium_paid_usd).toFixed(2)}`,
          );
        }
        continue; // option ouverte (ou refusée), passer au target suivant
      }
      // ─── FIN ROUTING OPTIONS ──────────────────────────────────────────

      // P4.3 — Plafond par classe d'actif : refuse l'ouverture si elle
      // pousserait l'exposition de la classe au-delà du seuil (default 25%).
      // PATCH 2 (PR#2 P0) — audit DECISION_LOG pour visibility (avant : simple
      // logger.debug invisible côté UI).
      // Defense-in-depth : `?? ''` au cas où la directive Lisa serait corrompue
      // (target.assetClass undefined). Évite un crash silencieux en plein cycle.
      const classKey = (target.assetClass ?? '').toLowerCase();
      const currentClassExposure = exposureByClass.get(classKey) ?? 0;
      const projectedClassExposurePct = capitalUsd.gt(0)
        ? ((currentClassExposure + notional.toNumber()) / capitalUsd.toNumber()) * 100
        : 0;
      if (projectedClassExposurePct > maxAssetClassPct) {
        this.logger.log(
          `[P4.3] Skip ${target.symbol} — exposition classe "${classKey}" projetée ${projectedClassExposurePct.toFixed(1)}% > cap ${maxAssetClassPct}%`,
        );
        await this.decisionLog.append({
          portfolioId,
          kind: 'risk_limit_breached',
          summary: `[P4.3] Ouverture ${target.symbol} refusée — class ${classKey} projetée ${projectedClassExposurePct.toFixed(1)}% > cap ${maxAssetClassPct}%`,
          rationale: `Pré-check incremental : exposition courante ${(currentClassExposure / capitalUsd.toNumber() * 100).toFixed(1)}% + nouvelle position $${notional.toFixed(0)} aurait poussé la classe à ${projectedClassExposurePct.toFixed(1)}%. Position rejetée AVANT ouverture (pas de close forcé post-fait).`,
          payload: {
            reason: 'would_exceed_class_cap',
            symbol: target.symbol,
            asset_class: classKey,
            current_exposure_pct: Number(((currentClassExposure / capitalUsd.toNumber()) * 100).toFixed(2)),
            projected_exposure_pct: Number(projectedClassExposurePct.toFixed(2)),
            cap_pct: maxAssetClassPct,
            notional_usd: notional.toNumber(),
          },
          triggeredBy: 'mechanical_cron',
        }).catch((e) => this.logger.warn(`risk_limit_breached log failed: ${String(e).slice(0, 120)}`));
        continue;
      }

      // Stop / target prices — stop dynamique ATR-based avec override Lisa
      // applicable par-dessus (tightenStopsMultiplier < 1 = stops plus serrés).
      // Le fallback (quand Lisa ne spécifie pas dans la thèse) est lu
      // dans risk_constraints.defaultStopLossPct, sinon 2%.
      const sessionDefaultStop = Number(
        (constraints['defaultStopLossPct'] as number | undefined) ?? 2,
      );
      const fallbackStopPct = target.stopLossPct ?? sessionDefaultStop;
      const eodhdTicker = this.lisa['toEodhdTicker']
        ? (this.lisa as unknown as { toEodhdTicker(s: string): string }).toEodhdTicker(target.symbol)
        : target.symbol;
      // PATCH 5 — passer thesisKind à deriveAtrStopPct pour multiplier ATR
      // adapté (momentum 1×, mean_reversion 2×, breakout 1.2×, event 1.5×,
      // macro_hedge 2.2×). Default 'momentum' si Lisa n'a pas tagué.
      const atrDerived = await this.deriveAtrStopPct(
        eodhdTicker,
        price.toNumber(),
        fallbackStopPct,
        target.thesisKind,
        capitalUsd.toNumber(),
      );
      // PR F — DEGRADED_OPEN : SL serré à 0.5×ATR14 indépendamment du
      // thesis.kind (qui ferait 1×-2.2×). Plancher 0.3% identique au flow
      // nominal. Si ATR indispo (atr14Pct null), on tombe sur le calcul
      // habituel — pas de fail-soft trompeur en degraded mode.
      // PR-2 v2 — matrice TP/SL par asset_class (priorité 2, après override Lisa).
      // Décimal en DB (0.030 = 3 %) → conversion ×100 pour scale local (% ; floor 0.3 / 0.5).
      // Master flag QW_TPSL_MATRIX_ENABLED (default true). DEGRADED_OPEN ignore la
      // matrice : son SL serré 0.5×ATR a sa propre logique apprentissage micro-position.
      const matrixEnabled = (process.env.QW_TPSL_MATRIX_ENABLED ?? 'true') === 'true';
      const matrixTpDecimal = matrixEnabled ? this.tpSlConfig.getTpPct(target.assetClass) : null;
      const matrixSlDecimal = matrixEnabled ? this.tpSlConfig.getSlPct(target.assetClass) : null;
      const tpSlResolved = resolveTpSlPcts({
        targetTakeProfitPct: target.takeProfitPct,
        matrixTpPct: matrixTpDecimal != null ? matrixTpDecimal * 100 : null,
        matrixSlPct: matrixSlDecimal != null ? Math.abs(matrixSlDecimal) * 100 : null,
        atrStopPct: atrDerived.stopPct,
        stopsMult,
        degradedActive,
        degradedAtr14Pct: atrDerived.atr14Pct,
      });
      const stopPct = tpSlResolved.stopPct;
      const tpPct = tpSlResolved.tpPct;

      const stopPrice = target.direction === 'long'
        ? price.mul(1 - stopPct / 100).toFixed(6)
        : price.mul(1 + stopPct / 100).toFixed(6);
      const takeProfitPrice = target.direction === 'long'
        ? price.mul(1 + tpPct / 100).toFixed(6)
        : price.mul(1 - tpPct / 100).toFixed(6);

      if (degradedActive) {
        this.logger.log(
          `[MECH] DEGRADED_OPEN ${target.symbol} size=${notional.toFixed(2)} sl=${stopPct.toFixed(2)}% reason=HORS_TRAJ_LEARN`,
        );
      }
      this.logger.log(
        `[MÉCANIQUE] ${target.symbol} stop=${stopPct.toFixed(2)}% tp=${tpPct.toFixed(2)}% ` +
        `(source=${atrDerived.source}, ATR14=${atrDerived.atr14Pct?.toFixed(2) ?? 'n/a'}%, ` +
        `kind=${target.thesisKind ?? 'default'} ×${atrDerived.kindMultiplier}, override×${stopsMult})`,
      );

      const horizonDays = target.horizonDays ?? 3;
      const horizonTargetDate = new Date(Date.now() + horizonDays * 86_400_000).toISOString();

      // P19x (29/04/2026) — Fix double bug observé en prod ce soir :
      // 8/10 trades fermés "TP hit" avec P&L négatif. Cause #1 : ce code
      // path utilisait feeBps=10 + slippageBps=10 = 20bps round-trip per
      // side = 0.40% total (~$10 sur $2500 notional) — 50× IBKR Pro réel.
      // P19u a fixé `paper-broker.service.ts` mais PAS ce code path
      // mechanical-trading qui est le vrai chemin du scanner Gainers.
      //
      // Fix : utilise computeRealisticFee partagé (P19u). IBKR Pro Tiered :
      //   - US equities + ETFs : max($0.35, $0.005/share), capped 1%
      //   - EU/Asia equities   : 5bps proxy
      //   - Crypto (Paxos)     : 0.085%
      //   - FX / commodity     : 1bp / 5bps
      //
      // Slippage modélé séparément (5bps additionnel, hypothèse paper sim
      // pour ne pas surestimer la perf vs réel). C'est conservateur mais
      // pas absurde.
      const tentativeQty = notional.div(price);
      const feeIbkr = computeRealisticFee(
        tentativeQty,
        price,
        target.assetClass as string | undefined,
      );
      const slippageBps = 5;
      const slippageCost = notional.mul(slippageBps).div(10000);
      const estimatedCost = feeIbkr.plus(slippageCost);
      const notionalNet = notional.minus(estimatedCost);
      const quantity = notionalNet.div(price);

      // P20.1 (30/04/2026) — FEES-AWARE TARGET guard miroir paper-broker.
      // P20.2 (30/04/2026) — include slippage 5bps (entry + exit) in roundTripFees.
      //
      // Ce code path (mechanical-trading INSERT direct) bypass paperBroker.openPosition
      // et donc le P20 guard. On duplique ici le check sur les mêmes critères :
      // expected_gain_at_TP ≥ FEES_AWARE_BUFFER × round_trip_fees_with_slippage.
      // Cf. paper-broker.service.ts pour la justification chiffrée (9 losses J-7).
      {
        const tpPriceDec = new Decimal(takeProfitPrice);
        const isLong = target.direction === 'long';
        const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';
        const exitFeeBreakdown = computeVenueFeeDetail(
          tentativeQty,
          tpPriceDec,
          target.assetClass as string | undefined,
          target.venue as string | undefined,
          exitSide,
        );
        // P20.2 — slippage 5bps × notional sur chaque side (cohérent avec
        // entry slippageBps=5 ligne 1082 + exit slippageBps=5 ligne 2087).
        const SLIPPAGE_BPS = 5;
        const exitNotional = tentativeQty.mul(tpPriceDec);
        const entrySlippage = notional.mul(SLIPPAGE_BPS).div(10000);
        const exitSlippage = exitNotional.mul(SLIPPAGE_BPS).div(10000);
        const venueFeesRT = feeIbkr.plus(new Decimal(exitFeeBreakdown.total));
        const roundTripFees = venueFeesRT.plus(entrySlippage).plus(exitSlippage);
        const expectedGain = isLong
          ? tpPriceDec.minus(price).mul(tentativeQty)
          : price.minus(tpPriceDec).mul(tentativeQty);
        const buffer = resolveFeesAwareBuffer();
        const requiredGain = roundTripFees.mul(buffer);
        if (expectedGain.lt(requiredGain)) {
          this.logger.log(
            `[MÉCANIQUE:P20.1] ${target.symbol} skip open: ` +
            `expected_gain_at_TP=$${expectedGain.toFixed(2)} < ${buffer.toFixed(2)}× round_trip_fees_with_slip=$${requiredGain.toFixed(2)} ` +
            `(entry=$${price.toFixed(4)} TP=$${tpPriceDec.toFixed(4)} qty=${tentativeQty.toFixed(4)} notional=$${notional.toFixed(2)} ` +
            `venue=$${venueFeesRT.toFixed(2)} slip=$${entrySlippage.plus(exitSlippage).toFixed(2)})`,
          );
          await this.decisionLog.append({
            portfolioId,
            kind: 'mechanical_open_skipped_fees_aware',
            summary: `[P20.1] ${target.symbol}: open mechanical refusée — gain TP < ${buffer.toFixed(2)}× (fees + slippage round-trip)`,
            rationale:
              `Gain attendu au TP $${expectedGain.toFixed(2)} insuffisant vs round-trip cost $${roundTripFees.toFixed(2)} ` +
              `(venue $${venueFeesRT.toFixed(2)} + slippage 5bps × 2 = $${entrySlippage.plus(exitSlippage).toFixed(2)}, ` +
              `buffer=${buffer.toFixed(2)}). Augmenter TP ou notional pour ouvrir.`,
            payload: {
              symbol: target.symbol,
              asset_class: target.assetClass,
              venue: target.venue ?? null,
              direction: target.direction,
              entry_price: price.toFixed(4),
              tp_price: tpPriceDec.toFixed(4),
              tp_pct: tpPct.toFixed(3),
              qty: tentativeQty.toFixed(4),
              notional_usd: notional.toFixed(2),
              entry_fee_usd: feeIbkr.toFixed(4),
              exit_fee_usd: exitFeeBreakdown.total.toFixed(4),
              entry_slippage_usd: entrySlippage.toFixed(4),
              exit_slippage_usd: exitSlippage.toFixed(4),
              round_trip_total_usd: roundTripFees.toFixed(4),
              expected_gain_at_tp_usd: expectedGain.toFixed(4),
              required_gain_usd: requiredGain.toFixed(4),
              buffer: buffer.toFixed(2),
            },
            triggeredBy: 'mechanical_cron',
          }).catch(() => null);
          continue; // skip cette ouverture, passe au prochain target
        }
      }

      // PR #349 — Gate session exchange (defense en profondeur).
      // Preuve empirique 14j : 10 entrées pré-marché Shanghai/Shenzhen
      // (.SHG/.SHE) → 8 SL / 1 TP / 1 inval = -$289.47 net. Le gate amont
      // getMarketState() ligne 928 a un trou pour asia. On verrouille ici
      // contre EXCHANGE_SESSIONS (source de vérité EODHD, DST-safe).
      // Crypto/forex/commodities passent via ALWAYS_ON_SUFFIXES.
      const nowDate = new Date();
      if (!isInExchangeSession(target.symbol, nowDate)) {
        this.logger.warn(
          `[MÉCANIQUE] Skip ${target.symbol} (${target.assetClass}) — off_exchange_session @ ${nowDate.toISOString()}`,
        );
        await this.decisionLog.append({
          portfolioId,
          kind: 'mechanical_skip',
          summary: `[MÉCANIQUE] Skip ${target.symbol} — off_exchange_session`,
          rationale: `Gate isInExchangeSession bloque ouverture pré/post-marché contre EXCHANGE_SESSIONS (source EODHD). asset_class=${target.assetClass} now=${nowDate.toISOString()}`,
          payload: {
            symbol: target.symbol,
            assetClass: target.assetClass,
            reason: 'off_exchange_session',
            timestampUtc: nowDate.toISOString(),
            directiveId: directive.id,
          },
          triggeredBy: 'mechanical_cron',
        }).catch(() => null);
        continue; // passe au prochain target
      }

      const positionId = randomUUID();
      const syntheticThesisId = target.thesisId ?? randomUUID();
      const now = new Date().toISOString();

      const { error: insErr } = await this.supabase.getClient()
        .from('lisa_positions')
        .insert({
          id: positionId,
          portfolio_id: portfolioId,
          proposal_id: null, // position mécanique — pas de proposal Claude
          thesis_id: syntheticThesisId,
          symbol: target.symbol,
          asset_class: target.assetClass,
          direction: target.direction,
          venue: target.venue ?? 'PAPER',
          quantity: quantity.toFixed(10),
          entry_price: price.toFixed(10),
          entry_timestamp: now,
          entry_notional_usd: notional.toFixed(2),
          conviction_score: target.convictionScore,
          status: 'open',
          stop_loss_price: stopPrice,
          take_profit_price: takeProfitPrice,
          horizon_target_date: horizonTargetDate,
          estimated_entry_cost_usd: estimatedCost.toFixed(2),
          source: 'mechanical',
          created_at: now,
          updated_at: now,
        });

      if (insErr) {
        this.logger.warn(`mechanical_open insert failed ${target.symbol}: ${insErr.message}`);
        continue;
      }

      // Déduire du cash (snapshot sera recalculé au prochain cycle complet)
      await this.supabase.getClient()
        .from('lisa_portfolio_snapshots')
        .upsert({
          id: randomUUID(),
          portfolio_id: portfolioId,
          timestamp: now,
          cash_usd: cashUsd.minus(notional).toFixed(2),
          open_positions_value_usd: '0',
          total_value_usd: capitalUsd.toFixed(2),
          realized_pnl_cumulative_usd: '0',
          unrealized_pnl_usd: '0',
          return_from_inception_pct: 0,
          open_positions_count: activePositions.length + slotsUsed + 1,
          drawdown_from_peak_pct: 0,
        });

      slotsUsed++;
      cycleNotionalUsed = cycleNotionalUsed.plus(notional);
      // P4.3 — Cumule l'exposition de la classe pour les itérations suivantes
      exposureByClass.set(classKey, currentClassExposure + notional.toNumber());
      // P4.2 — Cumule le ticker pour les prochains checks de corrélation
      existingEodhdTickers.push(this.toEodhdForCorrelation(target.symbol, target.assetClass));

      const overridesTag = Object.keys(overrides).length > 0
        ? ` · overrides=[${Object.entries(overrides).map(([k, v]) => `${k}=${JSON.stringify(v)}`).slice(0, 4).join(', ')}]`
        : '';

      await this.decisionLog.append({
        portfolioId,
        kind: 'mechanical_open',
        summary: `[MÉCANIQUE] Ouverture ${target.direction.toUpperCase()} ${target.symbol} @ ${price.toFixed(4)} · notional $${notional.toFixed(0)} · stop ${stopPct.toFixed(2)}% · target ${tpPct}%`,
        rationale: `Directive Lisa: thèmes=[${directive.activeThemes.slice(0, 3).join(', ')}] trajectoire=${directive.trajectoryStatus} momentum=${directive.marketMomentum} conviction=${target.convictionScore}/10 sizing×${sizingMultiplier.toFixed(2)}${overridesTag}`,
        payload: {
          positionId,
          symbol: target.symbol,
          direction: target.direction,
          entryPrice: price.toFixed(6),
          notionalUsd: notional.toFixed(2),
          stopPrice,
          takeProfitPrice,
          directiveId: directive.id,
          source: 'mechanical',
        },
        triggeredBy: 'mechanical_cron',
      });

      this.logger.log(`[MÉCANIQUE] ${portfolioId.slice(0, 8)} — OPEN ${target.direction} ${target.symbol} @ ${price.toFixed(4)}`);
    }

    // PATCH 2 (PR#2 P0) — Invariant assert post-batch.
    // Vérifie en environnement non-prod que l'invariant cap classe tient
    // après la boucle d'ouverture. Remplace l'ancien post-check 2-way qui
    // fermait des positions a posteriori. Ici on log uniquement (pas
    // d'action destructive) — si l'invariant casse, c'est un bug du
    // pré-check à investiguer, pas un état à "réparer".
    if (process.env.NODE_ENV !== 'production') {
      const currentCapital = capitalUsd.toNumber();
      if (currentCapital > 0) {
        for (const [cls, exposureUsd] of exposureByClass.entries()) {
          const pct = (exposureUsd / currentCapital) * 100;
          if (pct > maxAssetClassPct + 0.001) {
            this.logger.error(
              `[INVARIANT BROKEN] class ${cls} at ${pct.toFixed(2)}% > cap ${maxAssetClassPct}% post-batch — pré-check P4.3 défaillant à investiguer`,
            );
          }
        }
      }
    }

    // P4.5 — Hedge recommendation (alerte seule, aucune exécution)
    // Non-bloquant ; rate-limité à une alerte par 24h par portefeuille.
    await this.checkHedgeRecommendation(cfg, activePositions, capitalUsd)
      .catch((e) => this.logger.warn(`hedge recommendation check failed: ${String(e)}`));

    // Snapshot daily performance + résumé cycle pour Lisa (non-bloquants)
    await Promise.all([
      this.performance.takeSnapshot(portfolioId)
        .catch((e) => this.logger.warn(`performance snapshot failed: ${String(e)}`)),
      this.writeCycleSummary(portfolioId, directive, capitalUsd)
        .catch((e) => this.logger.warn(`cycle summary failed: ${String(e)}`)),
    ]);
  }

  /**
   * P4.5 — Hedge Recommendation (alerte passive, pas d'exécution)
   *
   * Si l'exposition long equity dépasse 40% du portefeuille, on émet une
   * recommandation de hedge dans le decision log. La recommandation est
   * lisible par Lisa au prochain cycle ou par l'utilisateur via l'UI.
   *
   * Rate limit : 1 alerte par 24h par portefeuille (évite le spam).
   * Aucune exécution automatique — conforme à CLAUDE.md § 2 (MANUAL_EXPLICIT).
   *
   * Pourquoi 40% : au-delà, un choc -5% sur les equities coûte > 2% au
   * portefeuille, ce qui déclenche déjà close-weakest (P4.1). Un hedge
   * préventif (SH, VIXY, put protecteur) aurait absorbé cette baisse.
   */

  /**
   * P5.1 — Agent ↔ Lisa interactive loop (trigger wake-up if Tier 1 signal).
   *
   * Agrège les metrics nécessaires (drawdown portfolio, P&L position la plus
   * faible, VIX live) et délègue la décision à AgentLisaSyncService qui gère
   * la détection de trigger + budget + cooldown + invocation Lisa.
   */
  private async triggerAgentLisaSyncIfNeeded(
    cfg: SessionConfig,
    openPositions: OpenPosition[],
  ): Promise<void> {
    const portfolioId = cfg.portfolio_id;

    // Récupérer l'userId propriétaire du portefeuille (requis pour generateProposal)
    const { data: portfolio } = await this.supabase.getClient()
      .from('portfolios')
      .select('user_id')
      .eq('id', portfolioId)
      .maybeSingle();
    const userId = (portfolio?.user_id as string | undefined) ?? null;
    if (!userId) return;  // pas de propriétaire, on ne peut pas invoquer

    // 1. Drawdown portefeuille intraday (peak-to-current depuis 00:00 UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { data: snaps } = await this.supabase.getClient()
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', todayStart.toISOString())
      .order('timestamp', { ascending: true });
    let portfolioDrawdownPct: number | null = null;
    if (snaps && snaps.length >= 2) {
      const values = snaps
        .map((s) => Number(s.total_value_usd))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length >= 2) {
        const peak = Math.max(...values);
        const current = values[values.length - 1];
        portfolioDrawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : null;
      }
    }

    // 2. Position avec le pire P&L live (si positions ouvertes)
    let worstPositionPnlPct: number | null = null;
    let worstPositionSymbol: string | null = null;
    if (openPositions.length > 0) {
      const pnlChecks = await Promise.all(
        openPositions.map(async (p) => {
          const quote = await this.lisa.getLivePrice(p.symbol).catch(() => null);
          if (!quote) return null;
          // 🛡️ Garde-fou : ignorer les fallback dans le calcul du worst P&L,
          // sinon on tag la position comme catastrophique sur prix factice.
          if (this.isFallbackSource(quote.source)) return null;
          const entry = Number(p.entryPrice);
          const current = Number(quote.price);
          if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current)) return null;
          const raw = ((current - entry) / entry) * 100;
          const signed = p.direction === 'short' ? -raw : raw;
          return { symbol: p.symbol, pnlPct: signed };
        }),
      );
      for (const check of pnlChecks) {
        if (!check) continue;
        if (worstPositionPnlPct == null || check.pnlPct < worstPositionPnlPct) {
          worstPositionPnlPct = check.pnlPct;
          worstPositionSymbol = check.symbol;
        }
      }
    }

    // 3. VIX cross-validé (pour détecter un choc marché).
    //
    // Defense en profondeur — DEUX oracles indépendants :
    //   - getLivePrice('VIX') : passe par toEodhdTicker + fallback générique
    //   - fetchMacroIndicator('VIX') : EODHD direct sur l'indice + fallback ciblé
    //
    // Si les deux divergent de plus de 30%, c'est un signal fort qu'au moins
    // une source est corrompue → on traite comme donnée indisponible plutôt
    // que paniquer. Sanity bound additionnel [5, 90] pour les valeurs
    // intrinsèquement absurdes (ex. fallback sentinel à 100).
    const [vixQuote, vixOracle2] = await Promise.all([
      this.lisa.getLivePrice('VIX').catch(() => null),
      this.lisa.fetchMacroIndicator('VIX').catch(() => null),
    ]);
    const vixRaw = vixQuote ? Number(vixQuote.price) : null;
    const vixOracle2Val = vixOracle2 ? vixOracle2.value : null;

    let vixLevel: number | null = null;
    if (
      vixRaw != null &&
      Number.isFinite(vixRaw) &&
      vixRaw >= 5 &&
      vixRaw <= 90
    ) {
      // Cross-validation : si oracle2 dispo, comparer
      if (vixOracle2Val != null) {
        const divergencePct = Math.abs((vixRaw - vixOracle2Val) / vixOracle2Val) * 100;
        if (divergencePct > 30) {
          this.logger.warn(
            `[mechanical-trading] VIX divergence: live=${vixRaw} vs oracle2=${vixOracle2Val} (${divergencePct.toFixed(0)}%) — donnée non-fiable, ignorée`,
          );
        } else {
          vixLevel = vixRaw;
        }
      } else {
        vixLevel = vixRaw;
      }
    } else if (vixRaw != null) {
      this.logger.warn(
        `[mechanical-trading] VIX=${vixRaw} hors plage plausible [5,90] — ignoré`,
      );
    }

    // Délégation à AgentLisaSyncService
    // Sensibilité Tier 1 : si HARVEST + hyper_active, on serre les seuils
    // (~½) pour aligner les wake-ups sur le scalping intraday (TP 2.5%).
    const isHarvestHyper =
      cfg.capital_discipline_mode === 'DAILY_HARVEST' &&
      cfg.profile === 'hyper_active';
    await this.agentLisaSync.evaluateTriggers({
      portfolioId,
      userId,
      openPositions: openPositions.map((p) => ({
        symbol: p.symbol,
        assetClass: (p as unknown as Record<string, unknown>)['asset_class'] as string ?? '',
        direction: p.direction,
        entryPrice: p.entryPrice,
      })),
      portfolioDrawdownPct,
      worstPositionPnlPct,
      worstPositionSymbol,
      vixLevel,
      sensitivityProfile: isHarvestHyper ? 'harvest_hyper' : 'standard',
    });
  }

  private async checkHedgeRecommendation(
    cfg: SessionConfig,
    positions: OpenPosition[],
    capitalUsd: Decimal,
  ): Promise<void> {
    const constraints = (cfg.risk_constraints ?? {}) as Record<string, unknown>;
    const threshold = Number(constraints['hedgeRecommendationThresholdPct'] ?? 40);

    // Calcul exposition long equity (equity + etf long)
    const readNotional = (p: OpenPosition) =>
      Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
    const readAssetClass = (p: OpenPosition) =>
      String((p as unknown as Record<string, unknown>)['asset_class'] ?? '').toLowerCase();
    const readDirection = (p: OpenPosition) =>
      String((p as unknown as Record<string, unknown>)['direction'] ?? '').toLowerCase();

    const longEquityNotional = positions
      .filter((p) => {
        const cls = readAssetClass(p);
        return readDirection(p) === 'long' && (cls.includes('equity') || cls.includes('etf') || cls.includes('stock'));
      })
      .reduce((s, p) => s + readNotional(p), 0);

    const longEquityPct = capitalUsd.gt(0) ? (longEquityNotional / capitalUsd.toNumber()) * 100 : 0;
    if (longEquityPct <= threshold) return;  // exposition sous seuil, rien à faire

    // Rate limit : pas d'alerte si une existe déjà < 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('timestamp')
      .eq('portfolio_id', cfg.portfolio_id)
      .eq('kind', 'hedge_recommendation')
      .gte('timestamp', since)
      .limit(1)
      .maybeSingle();
    if (recent) return;

    // Émet l'alerte
    await this.decisionLog.append({
      portfolioId: cfg.portfolio_id,
      kind: 'hedge_recommendation',
      summary: `[P4.5] Hedge recommandé : exposition long equity ${longEquityPct.toFixed(1)}% > seuil ${threshold}%. Envisager SH/VIXY/put protecteur.`,
      rationale: 'Protection passive suggérée. Pas d\'exécution automatique — l\'utilisateur valide manuellement toute action. Conforme MANUAL_EXPLICIT.',
      payload: {
        long_equity_notional_usd: longEquityNotional,
        long_equity_pct: longEquityPct,
        threshold_pct: threshold,
        hedge_candidates: ['SH', 'VIXY', 'UVXY', 'protective_put_SPY'],
      },
      triggeredBy: 'risk_monitor',
    });

    this.logger.log(
      `[P4.5] ${cfg.portfolio_id.slice(0, 8)} hedge_recommendation émise : longEq=${longEquityPct.toFixed(1)}% > ${threshold}%`,
    );
  }

  /**
   * P4.1 — Portfolio Drawdown Guard
   *
   * Calcule le drawdown intraday du portefeuille (peak-to-current sur les
   * snapshots depuis 00:00 UTC) et déclenche une action de protection si
   * les seuils configurables sont franchis.
   *
   * Niveaux (lus depuis cfg.risk_constraints, defaults conservateurs) :
   *   - killSwitchIntradayDrawdownPct (default 1.0%) →
   *       kill-switch armé (autopilot désactivé) + fermeture de TOUTES les
   *       positions au marché. Protection capital absolue.
   *   - closeWeakestIntradayDrawdownPct (default 0.5%) →
   *       fermeture de la position au plus petit notional (proxy de plus
   *       basse conviction) + blocage des ouvertures pour le cycle courant.
   *
   * Philosophie golden-trader : "cut losers fast", appliqué au niveau
   * portefeuille et pas juste position. Rejoint la discipline de
   * Druckenmiller (5 trimestres perdants sur 120 en 30 ans) — on préfère
   * réaliser une petite perte contrôlée plutôt que laisser courir.
   */
  private async checkPortfolioDrawdownGuard(
    cfg: SessionConfig,
    openPositions: OpenPosition[],
  ): Promise<'ok' | 'weakest_closed_block_opens' | 'kill_switch_triggered'> {
    // PR #254 — Skip P4.1 en mode gainers déterministe.
    //
    // Le P4.1 a été conçu pour le pipeline Lisa LLM avec stops larges
    // (3-5%) et ouvertures lentes. En mode gainers, chaque position a son
    // propre SL serré (default 1%) appliqué par le scanner ; un guard
    // portfolio à 0.5% de drawdown ferme prématurément des positions
    // saines en cascade (5 closes en quelques minutes observé prod 06/05/2026
    // sur portfolio Korea TP=2%/SL=1%).
    //
    // Le SL individuel par position garde la protection capital sans tuer
    // les setups dans leur fenêtre normale de jeu (~30-60 min Asia).
    // Le `expectancy watchdog` (skip cycle si E<0 sur 10 derniers trades)
    // reste actif comme circuit-breaker structurel.
    if ((cfg.strategy_mode as string | null | undefined) === 'gainers') {
      return 'ok';
    }

    const client = this.supabase.getClient();
    const portfolioId = cfg.portfolio_id;

    // Seuils configurables (defaults conservateurs golden-trader)
    const rc = (cfg.risk_constraints ?? {}) as Record<string, unknown>;
    const killDD = Number(rc['killSwitchIntradayDrawdownPct'] ?? 1.0);
    const weakestDD = Number(rc['closeWeakestIntradayDrawdownPct'] ?? 0.5);

    // Snapshots depuis 00:00 UTC aujourd'hui
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { data: snaps } = await client
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd, timestamp')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', todayStart.toISOString())
      .order('timestamp', { ascending: true });

    if (!snaps || snaps.length < 2) return 'ok';  // historique insuffisant, pas de jugement

    const values = snaps
      .map((s) => Number(s.total_value_usd))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length < 2) return 'ok';

    const peak = Math.max(...values);
    const current = values[values.length - 1];
    const drawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;

    // ── Kill-switch : drawdown critique → tout fermer ──
    if (drawdownPct > killDD) {
      this.logger.warn(
        `[P4.1] ${portfolioId.slice(0, 8)} KILL-SWITCH armed: dd=${drawdownPct.toFixed(2)}% > ${killDD.toFixed(2)}%`,
      );

      // 1. Désactive l'autopilot (kill-switch)
      await client
        .from('lisa_session_configs')
        .update({ kill_switch_active: true, autopilot_enabled: false })
        .eq('portfolio_id', portfolioId);

      // 2. Ferme toutes les positions au marché
      let closedCount = 0;
      for (const pos of openPositions) {
        const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
        if (!quote) continue;
        try {
          // 🛡️ Bug #M Part 3 (#C1) — garde fallback : si le quote est corrompu
          // (source fallback, NaN, ≤0) on ferme à entry_price (pnl≈0) plutôt
          // qu'au sentinel '0' qui produirait une perte maximale. Pattern aligné
          // sur risk-monitor.liquidateAll.
          const priceNum = parseFloat(quote.price);
          const corrupt =
            this.isFallbackSource(quote.source) ||
            !Number.isFinite(priceNum) ||
            priceNum <= 0;
          const closePx = corrupt ? pos.entryPrice : quote.price;
          await this.closePosition(
            pos.id,
            closePx,
            'closed_invalidated',
            `[P4.1 KILL-SWITCH] Drawdown intraday ${drawdownPct.toFixed(2)}% > ${killDD.toFixed(2)}% — fermeture auto`
              + (corrupt ? ' [Bug#M-guard: closed at entry_price]' : ''),
          );
          closedCount++;
        } catch (e) {
          this.logger.error(`[P4.1] Close failed on ${pos.symbol}: ${String(e).slice(0, 100)}`);
        }
      }

      // 3. Trace hash-chaînée
      await this.decisionLog.append({
        portfolioId,
        kind: 'kill_switch_triggered',
        summary: `[P4.1] Kill-switch auto-armé : drawdown intraday ${drawdownPct.toFixed(2)}% > seuil ${killDD.toFixed(2)}% (${closedCount}/${openPositions.length} positions fermées)`,
        rationale: 'Portfolio Drawdown Guard P4.1 — protection capital niveau portefeuille. Autopilot désactivé jusqu\'à réactivation explicite.',
        payload: {
          drawdown_pct: drawdownPct,
          threshold_pct: killDD,
          peak_value_usd: peak,
          current_value_usd: current,
          positions_total: openPositions.length,
          positions_closed: closedCount,
        },
        triggeredBy: 'risk_monitor',
      });

      return 'kill_switch_triggered';
    }

    // ── Close-weakest : drawdown modéré → trim la plus faible ──
    if (drawdownPct > weakestDD && openPositions.length > 0) {
      const readNotional = (p: OpenPosition) =>
        Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
      const weakest = [...openPositions].sort(
        (a, b) => readNotional(a) - readNotional(b),
      )[0];
      if (!weakest) return 'ok';

      const quote = await this.lisa.getLivePrice(weakest.symbol).catch(() => null);
      if (!quote) return 'ok';
      if (this.isFallbackSource(quote.source)) {
        this.logger.warn(`[FALLBACK_GUARD] close-weakest ${weakest.symbol} skip — source=${quote.source}`);
        return 'ok';
      }

      this.logger.warn(
        `[P4.1] ${portfolioId.slice(0, 8)} close-weakest ${weakest.symbol}: dd=${drawdownPct.toFixed(2)}% > ${weakestDD.toFixed(2)}%`,
      );

      try {
        await this.closePosition(
          weakest.id,
          quote.price,
          'closed_invalidated',
          `[P4.1] Drawdown intraday ${drawdownPct.toFixed(2)}% > ${weakestDD.toFixed(2)}% — fermeture position plus faible (${weakest.symbol})`,
        );
      } catch (e) {
        this.logger.error(`[P4.1] Close-weakest failed on ${weakest.symbol}: ${String(e).slice(0, 100)}`);
        return 'ok';  // échec propre → on laisse le cycle continuer normalement
      }

      await this.decisionLog.append({
        portfolioId,
        kind: 'risk_limit_breached',
        summary: `[P4.1] Close-weakest déclenché : drawdown ${drawdownPct.toFixed(2)}% > ${weakestDD.toFixed(2)}% — ${weakest.symbol} fermée, ouvertures bloquées ce cycle`,
        rationale: 'Portfolio Drawdown Guard P4.1 — trim position plus faible pour stopper l\'hémorragie avant kill-switch.',
        payload: {
          drawdown_pct: drawdownPct,
          threshold_pct: weakestDD,
          closed_symbol: weakest.symbol,
          closed_notional_usd: readNotional(weakest),
        },
        triggeredBy: 'risk_monitor',
      });

      return 'weakest_closed_block_opens';
    }

    return 'ok';
  }

  /**
   * PR #369 — Met à jour peak_pre_exit (MFE) si le prix courant améliore le pic.
   * Long : pic = prix max atteint. Short : pic = prix min. Update conditionnel
   * SQL (`peak_pre_exit IS NULL OR <comparaison>`) → un seul aller-retour,
   * pas de read préalable. Fire-and-forget : toute erreur est avalée (le
   * tracking MFE ne doit jamais bloquer le cycle stop/target).
   */
  private async recordMfe(positionId: string, price: number, isLong: boolean): Promise<void> {
    if (!Number.isFinite(price) || price <= 0) return;
    try {
      const cmp = isLong ? `peak_pre_exit.lt.${price}` : `peak_pre_exit.gt.${price}`;
      await this.supabase
        .getClient()
        .from('lisa_positions')
        .update({ peak_pre_exit: price })
        .eq('id', positionId)
        .or(`peak_pre_exit.is.null,${cmp}`);
    } catch {
      // non bloquant — instrumentation best-effort
    }
  }

  private async checkStopTarget(pos: OpenPosition, isHyperActive: boolean = false): Promise<void> {
    if (!pos.stopLossPrice && !pos.takeProfitPrice) return;

    const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
    if (!quote) return;

    // 🛡️ GARDE-FOU CRITIQUE — bug du 26/04 (perte $2627 sur prix fallback) :
    // Si EODHD timeout/échoue ET pas de quote en cache Supabase, fetchLivePrice
    // retourne un fallback hardcoded primitif (LMT=100, GLD=310, SLV=31, ...).
    // Ces fallbacks NE DOIVENT JAMAIS déclencher un stop/target — sinon une
    // position légitime à $513 (LMT) est instantanément liquidée à $100 = -80%.
    // On skip ce cycle pour cette position ; au prochain tick (60s), si EODHD
    // est revenu, on reprend normalement.
    if (this.isFallbackSource(quote.source)) {
      this.logger.warn(
        `[FALLBACK_GUARD] ${pos.symbol}: source=${quote.source} price=${quote.price} — skip stop/target check (prix non fiable, cycle suivant)`,
      );
      return;
    }

    // 🛡️ ZERO-PRICE GUARD (incident SEE.LSE 14/05/2026, perte -$1574) :
    // un tick à prix <= 0 (ou NaN) provenant d'une source NON taggée fallback
    // contourne le sanity bound ci-dessous (gardé par `livePx.gt(0)`) et
    // déclenche un stop à 0 → fausse liquidation -100%. Tout prix non-positif
    // est traité comme non fiable : on attend le tick suivant (comme le fallback).
    const livePriceNum = Number(quote.price);
    if (!Number.isFinite(livePriceNum) || livePriceNum <= 0) {
      this.logger.warn(
        `[ZERO_PRICE_GUARD] ${pos.symbol}: live price=${quote.price} (source=${quote.source}) <= 0 ou NaN — skip stop/target (tick corrompu)`,
      );
      return;
    }

    // 🛡️ SANITY BOUND (incident 27/04, LMT closed at $100 from $513) :
    // refuse tout prix qui diverge > 30% de l'entry en un seul tick. Un
    // vrai mouvement >30% sur un asset liquide en 60s est virtuellement
    // impossible — c'est presque certainement un prix corrompu (cache
    // pollué, parser EODHD glitch, source non-fallback mais aberrante).
    // On skip ; le tick suivant aura un prix réaliste OU le sanity bound
    // continuera à protéger.
    const entryPx = new Decimal(pos.entryPrice);
    const livePx = new Decimal(quote.price);
    if (entryPx.gt(0) && livePx.gt(0)) {
      const deltaPct = livePx.minus(entryPx).div(entryPx).abs().mul(100).toNumber();
      if (deltaPct > 30) {
        this.logger.warn(
          `[SANITY_BOUND] ${pos.symbol}: prix=${quote.price} (source=${quote.source}) diverge ${deltaPct.toFixed(1)}% de l'entry=${pos.entryPrice} — skip (probable corruption)`,
        );
        await this.decisionLog.append({
          portfolioId: String((pos as unknown as Record<string, unknown>)['portfolio_id'] ?? ''),
          kind: 'autopilot_cycle_completed',
          summary: `[SANITY_BOUND] ${pos.symbol} prix ${quote.price} divergeait ${deltaPct.toFixed(1)}% de l'entry — close skippé`,
          rationale: `Anti faux-stop : ${quote.price} (source=${quote.source}) vs entry ${pos.entryPrice}. Un mouvement > 30 % en un tick sur un actif liquide est presque toujours une corruption de prix.`,
          payload: {
            symbol: pos.symbol,
            live_price: quote.price,
            live_source: quote.source,
            entry_price: pos.entryPrice,
            divergence_pct: deltaPct,
          },
          triggeredBy: 'mechanical_cron',
        }).catch(() => {/* non bloquant */});
        return;
      }
    }

    const currentPrice = livePx;
    const stopPrice = pos.stopLossPrice ? new Decimal(pos.stopLossPrice) : null;
    const tpPrice = pos.takeProfitPrice ? new Decimal(pos.takeProfitPrice) : null;

    // Bug #314 #M4 — helper centralisé : reconnaît long/long_call/long_put.
    // Avant : `=== 'long'` strict → options gérées comme SHORT → stop/target inversés.
    const isLong = isLongPosition(pos.direction);

    // PR #369 — Instrumentation MFE (Max Favorable Excursion). Enregistre le
    // pic de prix favorable atteint avant la sortie, dans peak_pre_exit (jusqu'à
    // présent jamais peuplé). Permet de mesurer a posteriori si les positions
    // qui finissent en SL avaient atteint un gain significatif avant de se
    // retourner → chiffre la valeur d'un exit réactif (lock partiel). Update
    // conditionnel fire-and-forget : n'écrit que si le prix améliore le pic
    // (long = plus haut, short = plus bas). Coût négligeable (~7 open × 1/60s).
    void this.recordMfe(pos.id, currentPrice.toNumber(), isLong);

    const hitStop = stopPrice && (isLong ? currentPrice.lte(stopPrice) : currentPrice.gte(stopPrice));
    const hitTarget = tpPrice && (isLong ? currentPrice.gte(tpPrice) : currentPrice.lte(tpPrice));

    if (hitStop) {
      // Bug #R1 + #R2 + #R6 — warmup factorisé via evaluateWarmup (helper
      // partagé dans ai-analyst). Subsume :
      //   - PR #319 : logique 15min/-3% inline (R1)
      //   - PR #320 : env vars GAINERS_SL_WARMUP_MIN/CATASTROPHIC_PCT + bornes (R2)
      // Bug #R6 ajoute le même appel dans risk-monitor.checkPositionLimits
      // (autre chemin SL qui contournait le warmup — 3 leaks asia_equity nuit 14→15/05).
      //
      // Périmètre strict : gate UNIQUEMENT le SL principal. hitTarget +
      // checkReactiveSignals (2e ligne défense) restent intacts.
      const entryTsRaw = (pos as unknown as Record<string, unknown>)['entry_timestamp'] as string | undefined;
      const warmup = evaluateWarmup(
        entryTsRaw,
        entryPx.toNumber(),
        livePx.toNumber(),
        isLong,
        { logger: this.logger },
      );

      if (!warmup.shouldHonorStop) {
        // Stop hunt probable : on ne ferme PAS, position réexaminée au prochain
        // tick (60s). Fall-through vers checkReactiveSignals (2e ligne défense).
        this.logger.log(
          formatWarmupLog(warmup, {
            symbol: pos.symbol,
            positionId: pos.id,
            service: 'mechanical-trading',
            slPrice: pos.stopLossPrice,
          }) + ' — SL principal ignoré (position fraîche, perte modérée)',
        );
      } else {
        const log = formatWarmupLog(warmup, {
          symbol: pos.symbol,
          positionId: pos.id,
          service: 'mechanical-trading',
          slPrice: pos.stopLossPrice,
        });
        if (warmup.reason === 'warmup_override_severe_loss') {
          this.logger.warn(log + ' — garde-fou catastrophique : SL honoré malgré warmup');
        } else {
          this.logger.log(log + ' — warmup terminé, SL classique appliqué');

          // QW#3 warmup asymétrique par classe (PR-3+PR-4) — couche optionnelle
          // au-dessus du warmup standard pour étendre la fenêtre 15→30 min sur
          // toutes les classes SAUF asia_equity (data 30j : asia=15min reste
          // optimal, étendre coûte -$19 de TP perdus).
          const entryTsStr = (pos as unknown as Record<string, unknown>)['entry_timestamp'] as string | undefined;
          if (entryTsStr) {
            const ageMin = (Date.now() - new Date(entryTsStr).getTime()) / 60_000;
            const realizedPnlPct = livePx.minus(entryPx).div(entryPx).toNumber();
            if (this.qw3Warmup.shouldBlockSlClose(pos.assetClass as string, ageMin, realizedPnlPct)) {
              this.logger.log(
                `[QW3_WARMUP_EXTENDED] ${pos.symbol} class=${pos.assetClass} age=${ageMin.toFixed(1)}min pnl_pct=${realizedPnlPct.toFixed(4)} — SL différé (extended warmup)`,
              );
              return;
            }
          }
        }
        await this.closePosition(pos.id, quote.price, 'closed_stop',
          `[MÉCANIQUE] Stop-loss atteint ${pos.symbol} @ ${currentPrice.toFixed(4)} (stop=${pos.stopLossPrice})`);
        return;
      }
    }
    if (hitTarget) {
      // ─── Trailing take-profit (anti « sell winners too early », Shefrin-Statman) ─
      // Au lieu de fermer sec dès que le TP est touché (qui cappe les gagnants),
      // on LAISSE COURIR au-delà du TP et on ne sort que sur un repli de `giveback`%
      // depuis le PIC atteint (peak_pre_exit / MFE). Une fois le TP franchi, le
      // prix de sortie est toujours ≥ TP − giveback → la position ne peut plus
      // revenir en perte (elle sort sur un gain verrouillé, ou continue de monter).
      //
      // Ne touche PAS stop_loss_price → (a) le plancher dur reste le backstop
      // catastrophe, (b) la sortie reste labellisée closed_target (≠ closed_stop)
      // donc les stats Kelly/win-rate ne sont pas corrompues.
      //
      // Fonctionne SANS indicateurs techniques (RSI/MACD/ATR) → compatible avec
      // les marchés où EODHD intraday est indispo (Corée/Chine via TwelveData).
      // Opt-in : GAINERS_TRAILING_TP_ENABLED (default off → close TP classique).
      const trailingTpEnabled = (process.env.GAINERS_TRAILING_TP_ENABLED ?? 'false').toLowerCase() === 'true';
      // Scope gainers-only : ne pas altérer le TP fixe des positions Lisa swing.
      // Lookup (caché 60s) effectué uniquement ici → quand le TP est franchi ET
      // le flag actif, donc rarement.
      const trailingTpPortfolioId = String((pos as unknown as Record<string, unknown>)['portfolio_id'] ?? '');
      if (trailingTpEnabled && await this.isGainersStrategy(trailingTpPortfolioId)) {
        const giveback = Math.max(0.2, Math.min(10, Number(process.env.GAINERS_TRAILING_TP_GIVEBACK_PCT ?? '1.5')));
        // Pic = max(MFE persistée, prix courant) — recordMfe ci-dessus a déjà
        // poussé le pic en DB mais l'objet `pos` en mémoire date du début de cycle.
        const rawPeak = Number((pos as unknown as Record<string, unknown>)['peak_pre_exit']);
        const peakPx = Number.isFinite(rawPeak) && rawPeak > 0
          ? Decimal.max(new Decimal(rawPeak), currentPrice)
          : currentPrice;
        const pullbackTrigger = isLong
          ? peakPx.mul(1 - giveback / 100)
          : peakPx.mul(1 + giveback / 100);
        const pulledBack = isLong
          ? currentPrice.lte(pullbackTrigger)
          : currentPrice.gte(pullbackTrigger);
        if (pulledBack) {
          await this.closePosition(pos.id, quote.price, 'closed_target',
            `[MÉCANIQUE] Trailing-TP ${pos.symbol} @ ${currentPrice.toFixed(4)} : repli ${giveback}% depuis pic ${peakPx.toFixed(4)} (gain verrouillé, let-winners-run)`);
          return;
        }
        this.logger.log(
          `[TRAILING_TP] ${pos.symbol} laisse courir au-delà du TP : prix ${currentPrice.toFixed(4)} (pic ${peakPx.toFixed(4)}, sortie si repli ≥ ${giveback}%)`,
        );
        return;
      }
      await this.closePosition(pos.id, quote.price, 'closed_target',
        `[MÉCANIQUE] Take-profit atteint ${pos.symbol} @ ${currentPrice.toFixed(4)} (target=${pos.takeProfitPrice})`);
      return;
    }

    // AUCUN stop/target atteint → checker les signaux réactifs (indicateurs
    // techniques) pour potentiellement clôturer plus tôt OU trailer le stop.
    await this.checkReactiveSignals(pos, currentPrice, isHyperActive);
  }

  /**
   * Lit le take-profit absolu configurable depuis daily_harvest_config si
   * mode DAILY_HARVEST actif. Sinon retourne le default selon profile.
   */
  private async getTakeProfitAbsolutePct(portfolioId: string, isHyperActive: boolean): Promise<number> {
    try {
      const { data: cfg } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('capital_discipline_mode, daily_harvest_config')
        .eq('portfolio_id', portfolioId)
        .maybeSingle();

      if (cfg?.capital_discipline_mode === 'DAILY_HARVEST') {
        const dh = cfg.daily_harvest_config as Record<string, unknown> | null;
        const customTp = dh?.takeProfitAbsolutePct;
        if (typeof customTp === 'number' && customTp > 0 && customTp < 50) {
          return customTp;
        }
      }
    } catch { /* fall through to default */ }
    return isHyperActive ? 2.5 : 4;
  }

  // Cache court (60s) du strategy_mode par portfolio — évite un lookup DB par
  // position par tick. Utilisé pour scoper le trailing-TP aux portfolios gainers.
  private gainersStrategyCache = new Map<string, { isGainers: boolean; asOf: number }>();

  /**
   * true si le portfolio est en mode gainers. Sert à scoper le trailing-TP :
   * on ne modifie le comportement du TP que pour les positions du scanner
   * gainers, pas pour d'éventuelles positions Lisa swing (TP fixe voulu là).
   * Fail-safe : en cas d'échec DB → false (= comportement TP classique).
   */
  private async isGainersStrategy(portfolioId: string): Promise<boolean> {
    if (!portfolioId) return false;
    const cached = this.gainersStrategyCache.get(portfolioId);
    if (cached && Date.now() - cached.asOf < 60_000) return cached.isGainers;
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('strategy_mode')
        .eq('portfolio_id', portfolioId)
        .maybeSingle();
      const isGainers = data?.strategy_mode === 'gainers';
      this.gainersStrategyCache.set(portfolioId, { isGainers, asOf: Date.now() });
      return isGainers;
    } catch {
      return false;
    }
  }

  private async getMinNetProfitGate(portfolioId: string, notional: Decimal): Promise<Decimal> {
    const fallback = Decimal.max(new Decimal(2), notional.mul(0.005));
    try {
      const { data: cfg } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('strategy_mode, gainers_min_net_profit_usd')
        .eq('portfolio_id', portfolioId)
        .maybeSingle();

      if (cfg?.strategy_mode !== 'gainers') return fallback;
      const ui = cfg.gainers_min_net_profit_usd;
      if (typeof ui === 'number' && Number.isFinite(ui) && ui >= 0) {
        return new Decimal(ui);
      }
    } catch { /* fall through to default */ }
    return fallback;
  }

  /**
   * Détecte si une quote a été retournée via le fallback hardcoded
   * (au lieu d'une vraie source live). Toute source commençant par "fallback"
   * doit être traitée comme NON FIABLE — on skip les actions destructives.
   * Cf. checkStopTarget pour le rationale (incident 26/04).
   */
  private isFallbackSource(source: string | undefined): boolean {
    if (!source) return true; // pas de source = suspect
    return source.startsWith('fallback');
  }

  /**
   * Close réactif sur news contraires fraîches — décide indépendamment de Lisa.
   *
   * Critères STRICTS (3 garde-fous anti faux-positifs) :
   *  - Position long uniquement (la news bearish menace les longs)
   *  - News tag explicite sur le ticker tenu (`💼SYMBOL`) — pas de match
   *    par macro/secteur (trop bruyant)
   *  - Sentiment ≤ -0.6 ET news age < 30 min ET position open ≥ 5 min
   *
   * Position open ≥ 5 min évite la fermeture immédiate sur news déjà connue
   * au moment de l'ouverture (Lisa l'a déjà priced-in).
   *
   * Ce mécanisme complète le wake-up Lisa (qui peut prendre 5-20 min de
   * latence avant que Lisa émette un closeRecommendation explicite). Ici
   * on ferme dans la minute si les critères stricts matchent.
   */
  private async checkNewsShockClose(openPositions: OpenPosition[]): Promise<void> {
    const longs = openPositions.filter((p) => p.direction === 'long');
    if (longs.length === 0) return;

    const SENTIMENT_THRESHOLD = -0.6;
    const NEWS_MAX_AGE_MS = 30 * 60 * 1000;
    const POSITION_MIN_AGE_MS = 5 * 60 * 1000;
    const now = Date.now();

    for (const pos of longs) {
      const entryTs = (pos as unknown as Record<string, unknown>)['entry_timestamp'];
      const ageMs = entryTs ? now - new Date(String(entryTs)).getTime() : 0;
      if (ageMs < POSITION_MIN_AGE_MS) continue; // position trop fraîche

      let news: Awaited<ReturnType<EodhdEnrichmentService['fetchRecentNews']>>;
      try {
        news = await this.enrichment.fetchRecentNews([pos.symbol], 10);
      } catch { continue; }

      const heldUpper = pos.symbol.toUpperCase();
      for (const n of news) {
        if (n.sentiment == null || n.sentiment > SENTIMENT_THRESHOLD) continue;
        const ts = n.date ? new Date(n.date).getTime() : 0;
        if (now - ts > NEWS_MAX_AGE_MS) continue;
        const articleSymbols = (n.symbols ?? []).map((s) => s.toUpperCase());
        if (!articleSymbols.includes(heldUpper)) continue;

        // Récupère le prix live pour close à mid-market — fallback = skip
        const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
        if (!quote || this.isFallbackSource(quote.source)) {
          this.logger.warn(`[news-shock-close] ${pos.symbol} prix non fiable, close annulé`);
          break;
        }

        const ageMin = Math.round((now - ts) / 60_000);
        const reason = `News shock ${pos.symbol} sentiment=${n.sentiment.toFixed(2)} (${ageMin}min) : "${(n.title ?? '').slice(0, 80)}"`;
        await this.closePosition(pos.id, quote.price, 'closed_invalidated', `[MÉCANIQUE] ${reason}`);
        this.logger.log(`[news-shock-close] Closed ${pos.symbol} on news shock: ${reason}`);
        break; // une seule news suffit, on passe à la position suivante
      }
    }
  }

  /**
   * Agent réactif : à chaque cycle 1 min, analyse les indicateurs techniques
   * courants pour décider d'actions proactives SANS attendre Lisa :
   *
   *  a) Close anticipé sur signal de reversal :
   *     - LONG + RSI14 > 80 ET P&L > +1% → take profit (overbought exit)
   *     - SHORT + RSI14 < 20 ET P&L > +1% → take profit
   *     - LONG + MACD_hist bearish cross (passe + → -) ET P&L > 0 → exit momentum
   *     - SHORT + MACD_hist bullish cross (passe - → +) ET P&L > 0 → exit momentum
   *     - LONG + close < BB_lower (BB_%B < 0) sur un asset non-contrarian → exit
   *
   *  b) Trailing stop : ratchet le stop quand le P&L latent dépasse des paliers
   *     - P&L > +1.5% → stop monté à breakeven (entry price)
   *     - P&L > +3% → stop monté à +0.5% du entry
   *     - P&L > +5% → stop trailing à -1× ATR14 du prix courant
   *
   * Règle absolue : le trailing ne peut QUE resserrer le stop (jamais le
   * relâcher). Et ne jamais trailer un stop qui résulterait en P&L négatif.
   */
  private async checkReactiveSignals(pos: OpenPosition, currentPrice: Decimal, isHyperActive: boolean = false): Promise<void> {
    // PR #292 — Toggle env pour désactiver les exits réactifs RSI/MACD.
    //
    // Bug observé prod 08/05/2026 (analyse Kelly empirique sur 65 trades) :
    //   - R-ratio = 1.067 (vs 2.22 théorique TP 2% / SL 0.9%)
    //   - avg_win = $11.04 (vs $18 attendu si TP plein)
    //   - 24% des "stops" à -0.1% à -0.7% = early exits réactifs prématurés
    //   - Kelly = -4.32% (négatif → expectancy négative)
    //
    // Cause : exits réactifs ferment des trades à pnl +0.5-0.7% (bien avant
    // TP plein 2%) sur signal RSI > 70 + MACD bearish. Symétriquement, ils
    // coupent des stops avant que le SL absolu ne déclenche, transformant
    // certains trades en "fake stops" précoces.
    //
    // Fix toggle (env-only, zero migration) : ENABLE_REACTIVE_EXITS=false
    // → laisser TP/SL absolu fonctionner sans interférence. Re-mesurer
    // Kelly dans 5-7 jours. Si R-ratio remonte vers 2.0+, le bug est confirmé
    // et on peut décider de retirer définitivement la logique réactive.
    if (process.env.ENABLE_REACTIVE_EXITS === 'false') {
      return;
    }

    const entryPx = new Decimal(pos.entryPrice);
    if (entryPx.lte(0)) return;

    // Bug #314 #M4 — helper centralisé : reconnaît long/long_call/long_put.
    const isLong = isLongPosition(pos.direction);
    const pnlPct = isLong
      ? currentPrice.minus(entryPx).div(entryPx).mul(100).toNumber()
      : entryPx.minus(currentPrice).div(entryPx).mul(100).toNumber();

    // Pas de signal réactif si position fraîche — évite les close sur bougie
    // de formation pendant l'ouverture. En hyper_active la fenêtre est
    // réduite (90s vs 120s) pour réagir plus vite sur les vrais retournements.
    const minAgeMs = isHyperActive ? 90_000 : 120_000;
    const ageMs = Date.now() - new Date((pos as unknown as Record<string, unknown>)['entry_timestamp'] as string || Date.now()).getTime();
    if (ageMs < minAgeMs) return;

    // Seuils ANTICIPATIFS en hyper_active : déclenchement plus tôt pour
    // sécuriser les gains et couper les retournements avant qu'ils ne
    // s'installent. Trade-off : risque de sortie prématurée sur bruit
    // normal, mais avec stop-loss 1% Kamikaze, le risque downside reste
    // borné. L'anticipation prime sur la maximisation du gain.
    const RSI_OVERBOUGHT = isHyperActive ? 70 : 80;
    const RSI_OVERSOLD = isHyperActive ? 30 : 20;
    const TRAILING_BREAKEVEN_PNL = isHyperActive ? 0.8 : 1.5;
    const TRAILING_LOCK_PNL = isHyperActive ? 1.5 : 3;
    const TRAILING_ATR_PNL = isHyperActive ? 3 : 5;
    // 🛡️ Patch D — Take-profit absolu : garantit la matérialisation des
    // gains. Configurable par user via daily_harvest_config.takeProfitAbsolutePct
    // si mode DAILY_HARVEST actif. Sinon : 2.5% hyper / 4% standard.
    const portfolioIdFromPos = String((pos as unknown as Record<string, unknown>)['portfolio_id'] ?? '');
    const TAKE_PROFIT_ABSOLUTE_PCT = portfolioIdFromPos
      ? await this.getTakeProfitAbsolutePct(portfolioIdFromPos, isHyperActive)
      : (isHyperActive ? 2.5 : 4);

    // Récupère les indicateurs techniques (cache 5 min, donc appels réels ~12/h)
    const eodhdTicker = (this.lisa as unknown as { toEodhdTicker(s: string): string }).toEodhdTicker(pos.symbol);
    let ind: import('./eodhd-technical.service').TechnicalIndicators | null = null;
    try {
      ind = await this.technical.getIndicators(eodhdTicker, currentPrice.toNumber());
    } catch { /* indicators unavailable — skip reactive, keep baseline stops */ }

    if (!ind) {
      // 🛡️ Patch D : take-profit absolu fonctionne même sans indicateurs
      // (pas de dépendance EODHD technical). Vérification minimale.
      if (pnlPct >= TAKE_PROFIT_ABSOLUTE_PCT) {
        await this.closePosition(pos.id, currentPrice.toString(), 'closed_target',
          `[MÉCANIQUE] Take-profit absolu ${pos.symbol} @ ${currentPrice.toFixed(4)} : P&L=+${pnlPct.toFixed(2)}% ≥ ${TAKE_PROFIT_ABSOLUTE_PCT}% (matérialisation gain)`);
      }
      return;
    }

    // 🛡️ Patch D — Take-profit absolu prioritaire (avant trailing/reactive).
    // Si le P&L atteint le seuil absolu, on ferme tout immédiatement pour
    // garantir la matérialisation du gain. Évite les retournements qui
    // ramènent un winner à breakeven puis en perte.
    if (pnlPct >= TAKE_PROFIT_ABSOLUTE_PCT) {
      await this.closePosition(pos.id, currentPrice.toString(), 'closed_target',
        `[MÉCANIQUE] Take-profit absolu ${pos.symbol} @ ${currentPrice.toFixed(4)} : P&L=+${pnlPct.toFixed(2)}% ≥ ${TAKE_PROFIT_ABSOLUTE_PCT}% (matérialisation gain)`);
      return;
    }

    // ─── PR #256 — Reactive SL Early-Cut ──────────────────────────────────────
    //
    // Symétrique au Reactive TP : ferme une position en perte AVANT le SL
    // formel quand RSI + MACD confirment la continuation baissière.
    //
    // Réduit avg_loss (-1% → -0.5% en moyenne), améliore l'expectancy.
    // Toggle-able via env `GAINERS_REACTIVE_SL_ENABLED` (default true).
    //
    // Triple condition + age min pour éviter whipsaw sur du bruit Asia normal :
    //   - LONG : pnl ≤ -0.5% + RSI14 < 30 (oversold confirmé) + MACD_hist < 0
    //   - SHORT : pnl ≤ -0.5% + RSI14 > 70 + MACD_hist > 0
    //   - age ≥ 3 min (vs 90-120s pour reactive TP — plus conservateur côté loss)
    const reactiveSlEnabled = (process.env.GAINERS_REACTIVE_SL_ENABLED ?? 'true').toLowerCase() === 'true';
    const REACTIVE_SL_MIN_AGE_MS = 180_000; // 3 min
    if (
      reactiveSlEnabled &&
      ageMs >= REACTIVE_SL_MIN_AGE_MS &&
      pnlPct <= -0.5 &&
      ind.rsi14 != null &&
      ind.macdHist != null
    ) {
      let reactiveSlReason: string | null = null;
      if (isLong && ind.rsi14 < 30 && ind.macdHist < 0 && Math.abs(ind.macdHist) > 0.01) {
        reactiveSlReason = `RSI14=${ind.rsi14.toFixed(1)} < 30 (oversold) + MACD_hist=${ind.macdHist.toFixed(3)} bearish + P&L=${pnlPct.toFixed(2)}% → Reactive SL early-cut LONG`;
      } else if (!isLong && ind.rsi14 > 70 && ind.macdHist > 0 && Math.abs(ind.macdHist) > 0.01) {
        reactiveSlReason = `RSI14=${ind.rsi14.toFixed(1)} > 70 (overbought) + MACD_hist=+${ind.macdHist.toFixed(3)} bullish + P&L=${pnlPct.toFixed(2)}% → Reactive SL early-cut SHORT`;
      }
      if (reactiveSlReason) {
        await this.closePosition(pos.id, currentPrice.toString(), 'closed_stop',
          `[MÉCANIQUE] Reactive SL early-cut ${pos.symbol} @ ${currentPrice.toFixed(4)} : ${reactiveSlReason}`);
        return;
      }
    }

    // ─── a) Close anticipé sur signal de reversal ───────────────────────────
    let reactiveCloseReason: string | null = null;

    // RSI extreme + P&L positif → lock in profits.
    // Seuils plus serrés en hyper_active (RSI 70 vs 80) pour anticiper
    // les retournements avant qu'ils ne mangent les gains acquis.
    const minPnlForReactive = isHyperActive ? 0.5 : 1;
    if (pnlPct > minPnlForReactive) {
      if (isLong && ind.rsi14 != null && ind.rsi14 > RSI_OVERBOUGHT) {
        reactiveCloseReason = `RSI14=${ind.rsi14.toFixed(1)} > ${RSI_OVERBOUGHT} (overbought) + P&L=+${pnlPct.toFixed(2)}% → take profit`;
      } else if (!isLong && ind.rsi14 != null && ind.rsi14 < RSI_OVERSOLD) {
        reactiveCloseReason = `RSI14=${ind.rsi14.toFixed(1)} < ${RSI_OVERSOLD} (oversold) + P&L=+${pnlPct.toFixed(2)}% → take profit short`;
      }
    }

    // MACD cross contre-direction + P&L positif → exit momentum
    // P19x (29/04/2026) — Bump floor `pnlPct > 0` → `pnlPct >= MIN_REACTIVE_PNL_PCT`.
    // Bug observé : `pnlPct > 0` faisait fermer des trades à +0.005% gross.
    // Combiné aux fees ~0.20% par side (P19u-bis), le net était systématiquement
    // négatif → 8/10 "TP hits" en fait des pertes. Floor 0.5% garantit que le
    // reactive exit n'opère que quand on couvre les frictions round-trip + un
    // peu de marge. Aligné avec `minPnlForReactive` du RSI exit (0.5/1).
    const MIN_REACTIVE_PNL_PCT = isHyperActive ? 0.5 : 1.0;
    if (!reactiveCloseReason && pnlPct >= MIN_REACTIVE_PNL_PCT && ind.macdHist != null) {
      if (isLong && ind.macdHist < 0 && Math.abs(ind.macdHist) > 0.01) {
        reactiveCloseReason = `MACD_hist=${ind.macdHist.toFixed(3)} bearish sur LONG + P&L=+${pnlPct.toFixed(2)}% → exit momentum`;
      } else if (!isLong && ind.macdHist > 0 && Math.abs(ind.macdHist) > 0.01) {
        reactiveCloseReason = `MACD_hist=+${ind.macdHist.toFixed(3)} bullish sur SHORT + P&L=+${pnlPct.toFixed(2)}% → exit momentum`;
      }
    }

    if (reactiveCloseReason) {
      await this.closePosition(pos.id, currentPrice.toString(), 'closed_target',
        `[MÉCANIQUE] Exit réactif ${pos.symbol} @ ${currentPrice.toFixed(4)} : ${reactiveCloseReason}`);
      return;
    }

    // ─── b) Trailing stop ──────────────────────────────────────────────────
    // Seuils plus reactifs en hyper_active pour sécuriser les gains plus tôt.
    if (pnlPct <= TRAILING_BREAKEVEN_PNL) return; // pas encore assez de marge

    let newStopPct: number | null = null;
    if (pnlPct >= TRAILING_ATR_PNL && ind.atr14Pct != null && ind.atr14Pct > 0) {
      // Trail à -1× ATR du prix actuel
      newStopPct = ind.atr14Pct;
    } else if (pnlPct >= TRAILING_LOCK_PNL) {
      // Stop à +0.5% du entry
      newStopPct = -0.5;
    } else if (pnlPct >= TRAILING_BREAKEVEN_PNL) {
      // Stop à breakeven (0% vs entry)
      newStopPct = 0;
    }

    if (newStopPct === null) return;

    // Calcul du nouveau prix de stop. newStopPct est :
    //  - distance en % DU PRIX ACTUEL si pnlPct >= TRAILING_ATR_PNL (trailing ATR)
    //  - distance en % DU ENTRY si TRAILING_BREAKEVEN <= pnlPct < TRAILING_ATR (breakeven / lock)
    let newStopPrice: Decimal;
    let stopLabel: string;
    if (pnlPct >= TRAILING_ATR_PNL) {
      newStopPrice = isLong
        ? currentPrice.mul(1 - newStopPct / 100)
        : currentPrice.mul(1 + newStopPct / 100);
      stopLabel = `trailing ATR (-${newStopPct.toFixed(2)}% vs prix)`;
    } else {
      newStopPrice = isLong
        ? entryPx.mul(1 + newStopPct / 100)
        : entryPx.mul(1 - newStopPct / 100);
      stopLabel = newStopPct === 0 ? 'breakeven' : `lock +${newStopPct}% vs entry`;
    }

    // Règle absolue : le nouveau stop ne peut QUE resserrer (jamais relâcher)
    const currentStop = pos.stopLossPrice ? new Decimal(pos.stopLossPrice) : null;
    if (currentStop) {
      const tightens = isLong ? newStopPrice.gt(currentStop) : newStopPrice.lt(currentStop);
      if (!tightens) return; // stop actuel déjà plus strict
    }

    // Persist le nouveau stop
    const { error } = await this.supabase.getClient()
      .from('lisa_positions')
      .update({ stop_loss_price: newStopPrice.toFixed(6) })
      .eq('id', pos.id);

    if (error) {
      this.logger.warn(`trailing stop update failed ${pos.symbol}: ${error.message}`);
      return;
    }

    this.logger.log(
      `[MÉCANIQUE] Trailing stop ${pos.symbol} → ${newStopPrice.toFixed(4)} (${stopLabel}, P&L=+${pnlPct.toFixed(2)}%)`,
    );
  }

  /**
   * Évalue les autonomyRules attachées à chaque position ouverte.
   * Phase 2 — réactivité H24 entre cycles Lisa.
   *
   * Métriques live supportées :
   *  - vix                  : niveau VIX (RealtimePrice 'VIX')
   *  - price                : prix live du symbole
   *  - funding_annual_pct   : funding rate annualisé (Binance perp, crypto only)
   *  - pnl_pct              : P&L latent en %
   *
   * Actions supportées V1 :
   *  - close                : ferme la position (rationale='closed_invalidated')
   *  - tighten_stop         : déplace le stop à breakeven (entry price)
   *  - scale_down_50pct / take_profit : trace le trigger, action V2
   *
   * Trace dans lisa_decision_log kind='autonomous_rule_triggered'.
   */
  private async evaluateAutonomyRules(portfolioId: string, positions: OpenPosition[]): Promise<void> {
    const positionsWithRules = positions.filter((p) =>
      Array.isArray(p.autonomy_rules) && p.autonomy_rules.length > 0,
    );
    if (positionsWithRules.length === 0) return;

    // Pré-fetch VIX une fois pour tous les checks (évite N appels)
    const vixQuote = await this.lisa.getLivePrice('VIX').catch(() => null);
    // 🛡️ Bug #M Part 3 (#m1) — null si source fallback : un VIX corrompu
    // fausserait les règles autonomy basées sur vix. Pattern aligné sur
    // material-change-detector.service.ts:224.
    const vixLevel = vixQuote && !this.isFallbackSource(vixQuote.source)
      ? Number(vixQuote.price)
      : null;

    for (const pos of positionsWithRules) {
      for (const rule of pos.autonomy_rules ?? []) {
        try {
          const liveValue = await this.fetchMetricForRule(rule.metric, pos, vixLevel);
          if (liveValue === null) continue;
          if (!this.compareWithOp(liveValue, rule.op, rule.value)) continue;

          // Trigger : règle déclenchée. On log AVANT d'exécuter pour traçabilité.
          await this.decisionLog.append({
            portfolioId,
            kind: 'autonomous_rule_triggered',
            summary: `[AUTONOMY] ${pos.symbol} rule ${rule.metric}${rule.op}${rule.value} → ${rule.action} (live=${liveValue.toFixed(4)})`,
            rationale: rule.reason,
            payload: {
              positionId: pos.id,
              symbol: pos.symbol,
              metric: rule.metric,
              op: rule.op,
              threshold: rule.value,
              liveValue,
              action: rule.action,
              reason: rule.reason,
            },
            triggeredBy: 'mechanical_cron',
          });

          // Exécution de l'action
          if (rule.action === 'close' || rule.action === 'take_profit') {
            const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
            // 🛡️ Bug #M Part 3 (#C4) — skip si quote fallback corrompu : ne pas
            // fermer sur un prix sentinel '0'. La règle sera ré-évaluée au
            // prochain cycle quand un prix fiable sera disponible.
            if (quote && !this.isFallbackSource(quote.source)) {
              await this.closePosition(
                pos.id,
                quote.price,
                'closed_invalidated',
                `AutonomyRule: ${rule.reason}`.slice(0, 500),
              );
              break; // position fermée, plus la peine d'évaluer ses autres règles
            } else {
              this.logger.warn(
                `[FALLBACK_GUARD] AutonomyRule close ${pos.symbol} skip — source=${quote?.source ?? 'no_quote'}`,
              );
            }
          } else if (rule.action === 'tighten_stop') {
            // Déplace le stop à breakeven (entry price)
            await this.supabase.getClient()
              .from('lisa_positions')
              .update({ stop_loss_price: pos.entryPrice })
              .eq('id', pos.id)
              .eq('status', 'open');
            this.logger.log(`[AUTONOMY] ${pos.symbol} stop → breakeven (${pos.entryPrice})`);
          }
          // scale_down_50pct : V2 (paperBroker doesn't support partial close yet)
        } catch (e) {
          this.logger.warn(`AutonomyRule eval failed for ${pos.symbol}: ${String(e).slice(0, 120)}`);
        }
      }
    }
  }

  /** Récupère la valeur live d'une métrique selon le contexte de la position. */
  private async fetchMetricForRule(
    metric: AutonomyRuleDb['metric'],
    pos: OpenPosition,
    vixCached: number | null,
  ): Promise<number | null> {
    if (metric === 'vix') return vixCached;
    if (metric === 'price') {
      const q = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      // 🛡️ Bug #M Part 3 (#m2) — null si source fallback : un prix corrompu
      // déclencherait faussement les règles autonomy 'price'.
      if (!q || this.isFallbackSource(q.source)) return null;
      return Number(q.price);
    }
    if (metric === 'pnl_pct') {
      const q = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!q) return null;
      // 🛡️ Bug #M Part 3 (#m2) — null si source fallback : un pnl_pct calculé
      // sur prix corrompu déclencherait faussement les règles autonomy.
      if (this.isFallbackSource(q.source)) return null;
      const entry = Number(pos.entryPrice);
      const live = Number(q.price);
      const isLong = pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put';
      return isLong ? ((live - entry) / entry) * 100 : ((entry - live) / entry) * 100;
    }
    if (metric === 'funding_annual_pct') {
      // Crypto only : convertit symbol → format Binance perp (BTCUSDT)
      // Defensive `?.` : si le mapper a raté un load site, on log + skip
      // au lieu de crasher le cycle entier (incident 27/04 BTC crash).
      if (!pos.assetClass) {
        this.logger.warn(`[AUTONOMY] funding_annual_pct skip ${pos.symbol}: assetClass undefined (mapper missed?)`);
        return null;
      }
      if (!pos.assetClass.toLowerCase().includes('crypto')) return null;
      const binSym = `${pos.symbol.toUpperCase()}USDT`;
      const stats = await this.binance.getFutureStats(binSym).catch(() => null);
      return stats ? stats.fundingAnnualizedPct : null;
    }
    return null;
  }

  private compareWithOp(live: number, op: AutonomyRuleDb['op'], threshold: number): boolean {
    switch (op) {
      case 'gt':  return live >  threshold;
      case 'gte': return live >= threshold;
      case 'lt':  return live <  threshold;
      case 'lte': return live <= threshold;
    }
  }

  private async closePosition(
    positionId: string,
    livePrice: string,
    reason: 'closed_stop' | 'closed_target' | 'closed_invalidated',
    rationale: string,
    exitReasonOverride?: string,
  ): Promise<void> {
    const { data: pos } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('id', positionId)
      .eq('status', 'open')
      .maybeSingle();

    if (!pos) return;

    const exitPrice = new Decimal(livePrice);
    const entryPrice = new Decimal(pos.entry_price as string);
    const notional = new Decimal(pos.entry_notional_usd as string);
    // Bug #314 #M4 — helper centralisé : reconnaît long/long_call/long_put.
    const isLong = isLongPosition(pos.direction as string);
    const qty = new Decimal(pos.quantity as string);
    const assetClass = (pos.asset_class as string | undefined) ?? undefined;

    const rawPnl = isLong
      ? exitPrice.minus(entryPrice).mul(qty)
      : entryPrice.minus(exitPrice).mul(qty);

    // P19x (29/04/2026) — Realistic IBKR Pro fee model + closed_invalidated refund.
    //
    // Avant P19x : `feeBps + slippageBps = 20bps` × notional côté exit, soit
    // ~$5 sur $2500 — 50× IBKR Pro réel. Sur tiny moves (TP @ +0.005% via MACD
    // reactive close), ce fee mangeait tout le gross PnL et faisait apparaître
    // -$4.81 sur un "TP hit". P19u avait fixé paper-broker.service.ts mais
    // PAS ce code path mechanical-trading.
    //
    // Fix :
    //   - exitCost = computeRealisticFee + 5bps slippage (paper sim conservatif)
    //   - closed_invalidated → refund both sides, treat as "no trade happened"
    let exitCost: Decimal;
    let entryFeeRefund: Decimal;
    if (reason === 'closed_invalidated') {
      exitCost = new Decimal(0);
      const entryCostStored = pos.estimated_entry_cost_usd as string | null;
      entryFeeRefund = entryCostStored ? new Decimal(entryCostStored) : new Decimal(0);
    } else {
      const feeIbkr = computeRealisticFee(qty, exitPrice, assetClass);
      const slippageBps = 5;
      const slippageCost = notional.mul(slippageBps).div(10000);
      exitCost = feeIbkr.plus(slippageCost);
      entryFeeRefund = new Decimal(0);
    }
    const realizedPnl = rawPnl.minus(exitCost).plus(entryFeeRefund);

    // P19x.1 (29/04/2026) — MIN_NET_PROFIT_USD guard avant `closed_target`.
    //
    // Bug observé en prod ce soir : 10 trades fermés "TP hit", win rate 0%,
    // P&L cumulé -$36.53. Cause : les exits réactifs (MACD bearish à pnl
    // ≥ 0.5%, P19x déjà mergé) + take-profit absolu (P&L ≥ 2.5-4%) peuvent
    // matérialiser un gain BRUT minimal sur trades à petit notional, qui
    // devient NÉGATIF après fees IBKR ($0.35 min × 2 sides = $0.70).
    //
    // Garde-fou : un closed_target ne doit JAMAIS résulter en net PnL négatif.
    // Si net < MIN = max(2$, 0.5% × notional), on REFUSE le close et la
    // position reste ouverte. Le prochain cycle re-évaluera (price peut
    // bouger plus, ou le trailing/stop la fermera proprement).
    //
    // Pourquoi seulement closed_target : closed_stop matérialise une perte
    // par design (protection drawdown) ; closed_invalidated refund les fees.
    if (reason === 'closed_target') {
      // PR #279 (07/05/2026) — Honorer `gainers_min_net_profit_usd` (UI section 6)
      // en mode gainers. Avant : gate hardcoded `max($2, 0.5% × notional)` =
      // $5 pour notional $1000, ce qui bloquait indéfiniment des TP réactifs
      // RSI à +0.5% (net ~$4.10). La valeur UI était silencieusement ignorée.
      // Fallback hardcoded préservé pour le flow LLM (strategy_mode != gainers).
      const minNetProfit = await this.getMinNetProfitGate(
        pos.portfolio_id as string,
        notional,
      );
      if (realizedPnl.lt(minNetProfit)) {
        this.logger.warn(
          `[MÉCANIQUE] Skip closed_target ${pos.symbol}: net=$${realizedPnl.toFixed(2)} < min=$${minNetProfit.toFixed(2)} ` +
          `(notional=$${notional.toFixed(0)}, gross=$${rawPnl.toFixed(2)}, fees=$${exitCost.toFixed(2)}). Position kept open.`,
        );
        // Audit decision_log pour tracer ce que sinon serait silencieux côté UI
        await this.decisionLog.append({
          portfolioId: pos.portfolio_id as string,
          kind: 'mechanical_close_skipped_min_profit',
          summary: `[MÉCANIQUE] Refus closed_target ${pos.symbol}: net=$${realizedPnl.toFixed(2)} < min=$${minNetProfit.toFixed(2)} → garde ouvert`,
          rationale: `Net PnL ${realizedPnl.toFixed(2)} USD inférieur au seuil min ${minNetProfit.toFixed(2)} USD (gross ${rawPnl.toFixed(2)} - fees ${exitCost.toFixed(2)}). Position kept open pour éviter de matérialiser une perte sur fake-TP.`,
          payload: {
            symbol: pos.symbol,
            entry_price: pos.entry_price,
            attempted_exit_price: exitPrice.toFixed(4),
            attempted_reason: rationale,
            gross_pnl_usd: rawPnl.toFixed(2),
            exit_cost_usd: exitCost.toFixed(2),
            net_pnl_usd: realizedPnl.toFixed(2),
            min_net_profit_usd: minNetProfit.toFixed(2),
            notional_usd: notional.toFixed(2),
          },
          triggeredBy: 'mechanical_cron',
        }).catch(() => { /* non-bloquant */ });
        return; // ⚠️ Position reste ouverte, pas d'UPDATE DB
      }
    }

    // P19x.1 — Log structuré obligatoire à chaque close effectif (req user).
    // Permet grep Fly logs pour audit : entry, exit, qty, fees, gross, net.
    this.logger.log(
      `[MÉCANIQUE_CLOSE] ${pos.symbol} status=${reason} ` +
      `entry=${entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)} qty=${qty.toFixed(4)} ` +
      `gross=$${rawPnl.toFixed(2)} fees_out=$${exitCost.toFixed(2)} ` +
      `net=$${realizedPnl.toFixed(2)} notional=$${notional.toFixed(2)} ` +
      `entry_cost=$${pos.estimated_entry_cost_usd ?? '?'}`,
    );
    const pnlPct = realizedPnl.div(notional).mul(100).toNumber();

    // R5 sanity hotfix (PR-3+PR-4) — refuse les fermetures avec exit_price
    // aberrant qui auraient bypassé les autres garde-fous (incident SEE.LSE
    // 14 mai : exit_price 0.0000 → pnl_pct -99.948 %).
    const sanity = await this.sanityR5.validateExit({
      entryPrice: entryPrice.toNumber(),
      exitPrice: exitPrice.toNumber(),
      realizedPnlPct: pnlPct,
      positionId,
      symbol: pos.symbol as string,
      assetClass: (pos.asset_class as string) ?? 'unknown',
    });
    if (!sanity.ok) {
      this.logger.error(
        `[R5_SANITY_BLOCK] ${pos.symbol} positionId=${positionId} raison=${sanity.raison} ${sanity.detail ?? ''} — position kept open`,
      );
      return; // ⚠️ Position reste ouverte
    }

    const now = new Date().toISOString();
    // Bug #314 #M1 — UPDATE atomique double-clause. Le SELECT initial (haut de
    // closePosition) vérifie status='open', mais sans .eq('status','open') sur
    // l'UPDATE un autre acteur (paper-broker, kill-switch user) pouvait fermer
    // la position entre SELECT et UPDATE → double comptage P&L + audit pollué.
    // Pattern canonique : paper-broker.service.ts:611-622.
    const { data: updated } = await this.supabase.getClient()
      .from('lisa_positions')
      .update({
        status: reason,
        exit_price: exitPrice.toFixed(10),
        exit_timestamp: now,
        exit_reason: exitReasonOverride ?? reason,
        realized_pnl_usd: realizedPnl.toFixed(2),
        realized_pnl_pct: pnlPct,
        updated_at: now,
      })
      .eq('id', positionId)
      .eq('status', 'open')
      .select('*');

    // 0 rows touchées = position déjà fermée par un autre acteur entre le
    // SELECT et l'UPDATE → retour silencieux pour ne pas double-compter.
    if (!updated || updated.length === 0) {
      this.logger.warn(
        `[MÉCANIQUE] closePosition ${positionId} race detected — already closed by another actor, skipping double-close`,
      );
      return;
    }

    // Phase 5 — fire-and-forget : capture l'outcome contextualisé pour
    // l'apprentissage continu Lisa. Ne bloque jamais le close.
    this.tradeOutcomeRecorder
      .recordOutcome(positionId, exitPrice.toFixed(10), reason)
      .catch((e) => this.logger.debug(`outcome record failed: ${String(e).slice(0, 100)}`));

    // DAILY_HARVEST Phase 2 — fire-and-forget : update session metrics +
    // sweep PER_TRADE si applicable + state machine. Inerte si le portfolio
    // n'est PAS en mode DAILY_HARVEST. Ne bloque jamais le close.
    this.dailyProfitGovernor
      .onTradeClosed(
        pos.portfolio_id as string,
        positionId,
        pos.symbol as string,
        realizedPnl.toNumber(),
        reason,
      )
      .catch((e) => this.logger.error(
        `[DAILY_HARVEST_HOOK] failed for ${pos.symbol} pnl=${realizedPnl.toFixed(2)}: ${String(e).slice(0, 200)}`,
      ));

    // BOT LAB Phase 4 — boucle feedback patterns adoptés.
    // Pour chaque pattern adopté actif sur ce portfolio, check si ce trade
    // matche les conditions, et si oui increment triggered_count + pnl.
    // Fire-and-forget — ne JAMAIS bloquer le close.
    this.recordPatternFeedback(
      pos.portfolio_id as string,
      pos.asset_class as string,
      pos.direction as string,
      realizedPnl.toNumber(),
    ).catch((e) => this.logger.debug(`pattern feedback failed: ${String(e).slice(0, 100)}`));

    await this.decisionLog.append({
      portfolioId: pos.portfolio_id as string,
      kind: reason === 'closed_target' ? 'mechanical_close_target' : 'mechanical_close_stop',
      summary: rationale,
      rationale,
      payload: {
        positionId,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entry_price,
        exitPrice: livePrice,
        realizedPnlUsd: realizedPnl.toFixed(2),
        realizedPnlPct: pnlPct.toFixed(2),
        source: 'mechanical',
      },
      triggeredBy: 'mechanical_cron',
    }).catch(() => { /* non-blocking */ });

    this.logger.log(`[MÉCANIQUE] ${(pos.portfolio_id as string).slice(0, 8)} — CLOSE ${pos.direction} ${pos.symbol} @ ${exitPrice.toFixed(4)} · PnL ${realizedPnl.toFixed(2)} USD (${pnlPct.toFixed(2)}%)`);
  }

  /**
   * QW#45 — Force-close publique appelée par cron quick-wins/qw-45-force-close-us-large.
   *
   * Réutilise toute la chaîne de closePosition (fees IBKR + sanity R5 + race
   * detection + outcome recorder) en injectant un exit_reason custom. Si live
   * price indisponible, fallback source détectée, ou prix <= 0 : SKIP la
   * position (log warn, pas de fermeture aveugle).
   *
   * Sécurité : la guard MIN_NET_PROFIT_USD de closePosition s'applique aussi
   * ici. Si le net PnL prévu est négatif sous seuil, la position est gardée
   * ouverte et re-évaluée au prochain cycle (comportement voulu : ne jamais
   * matérialiser une perte sur un fake-TP, même en force-close).
   */
  async forceClosePosition(positionId: string, exitReasonOverride: string): Promise<void> {
    const { data: pos, error } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, status')
      .eq('id', positionId)
      .eq('status', 'open')
      .maybeSingle();

    if (error) {
      this.logger.warn(`[QW#45_FORCE_CLOSE] select failed for ${positionId}: ${error.message}`);
      return;
    }
    if (!pos) {
      this.logger.debug(`[QW#45_FORCE_CLOSE] ${positionId} already closed or not found — skip`);
      return;
    }

    const symbol = pos.symbol as string;
    const quote = await this.lisa.getLivePrice(symbol).catch(() => null);

    if (!quote || Number(quote.price) <= 0) {
      this.logger.warn(
        `[QW#45_FORCE_CLOSE] ${symbol} positionId=${positionId} — livePrice null or <=0 (${quote?.price}), skip force-close`,
      );
      return;
    }
    if (this.isFallbackSource(quote.source)) {
      this.logger.warn(
        `[QW#45_FORCE_CLOSE] ${symbol} positionId=${positionId} — fallback source=${quote.source}, skip force-close (prix non fiable)`,
      );
      return;
    }

    await this.closePosition(
      positionId,
      quote.price,
      'closed_target',
      `[QW#45] ${exitReasonOverride}`,
      exitReasonOverride,
    );
  }

  /**
   * Calcule et persiste le résumé du cycle mécanique depuis la génération de
   * la directive. Transmis à Lisa avant sa prochaine proposition pour qu'elle
   * intègre : stops touchés, P&L, cluster de régime, exposition, macro (VIX/DXY).
   */
  /**
   * Écrit un cycle summary "défensif" quand le mécanique tourne mais ne
   * peut pas ouvrir de position (directive expirée, HORS_TRAJECTOIRE, etc.).
   * Garantit que l'UI "Agent mécanique" affiche un timestamp à jour
   * (sinon le dernier summary peut dater de plusieurs heures et donner
   * une fausse impression de service stoppé).
   */
  private async writeDefensiveCycleSummary(
    portfolioId: string,
    activePositions: OpenPosition[],
  ): Promise<void> {
    const client = this.supabase.getClient();
    // Le select('*') retourne des colonnes snake_case Postgres, pas la
    // version camelCase typée dans OpenPosition. On accède via le nom DB.
    const readNotional = (p: OpenPosition) =>
      Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
    const exposureUsd = activePositions.reduce((s, p) => s + readNotional(p), 0);
    // Tente de lire le capital depuis la dernière config session
    const { data: snap } = await client
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd, cash_usd')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    const totalValue = Number(snap?.total_value_usd ?? 10000);
    const cashUsd = Number(snap?.cash_usd ?? 0);
    const exposurePct = totalValue > 0 ? (exposureUsd / totalValue) * 100 : 0;

    await client.from('lisa_mechanical_cycle_summary').insert({
      portfolio_id: portfolioId,
      cycle_at: new Date().toISOString(),
      directive_id: null,
      opens_count: 0,
      closes_stop_count: 0,
      closes_target_count: 0,
      closes_invalidated_count: 0,
      net_pnl_since_proposal_usd: '0',
      gross_wins_usd: '0',
      gross_losses_usd: '0',
      win_rate_pct: 0,
      avg_hold_minutes: 0,
      largest_win_pct: 0,
      largest_loss_pct: 0,
      stops_cluster_flag: false,
      exposure_pct: exposurePct,
      cash_usd: cashUsd.toFixed(2),
      open_positions_count: activePositions.length,
      drawdown_since_directive_pct: 0,
      directive_age_minutes: 0,
    });
  }

  private async writeCycleSummary(
    portfolioId: string,
    directive: MechanicalDirective,
    capitalUsd: Decimal,
  ): Promise<void> {
    const client = this.supabase.getClient();
    const sinceDirective = directive.generatedAt.toISOString();

    // Positions fermées depuis la directive (toutes sources)
    const { data: closedSince } = await client
      .from('lisa_positions')
      .select('status, realized_pnl_usd, realized_pnl_pct, entry_timestamp, exit_timestamp')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .gte('exit_timestamp', sinceDirective)
      .order('exit_timestamp', { ascending: true });

    const closed = closedSince ?? [];
    const closesStop = closed.filter((p) => p.status === 'closed_stop');
    const closesTarget = closed.filter((p) => p.status === 'closed_target');
    const closesInvalidated = closed.filter((p) => p.status === 'closed_invalidated');

    // Ouvertures mécaniques depuis la directive
    const { data: opensSince } = await client
      .from('lisa_positions')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('source', 'mechanical')
      .gte('entry_timestamp', sinceDirective);
    const opensCount = (opensSince ?? []).length;

    // P&L
    const wins = closed.filter((p) => Number(p.realized_pnl_usd ?? 0) > 0);
    const losses = closed.filter((p) => Number(p.realized_pnl_usd ?? 0) < 0);
    const netPnl = closed.reduce((sum, p) => sum + Number(p.realized_pnl_usd ?? 0), 0);
    const grossWins = wins.reduce((sum, p) => sum + Number(p.realized_pnl_usd ?? 0), 0);
    const grossLosses = losses.reduce((sum, p) => sum + Number(p.realized_pnl_usd ?? 0), 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : null;

    // Durée moyenne de hold
    const holdsMin = closed
      .filter((p) => p.entry_timestamp && p.exit_timestamp)
      .map((p) =>
        (new Date(p.exit_timestamp as string).getTime() - new Date(p.entry_timestamp as string).getTime()) / 60000,
      );
    const avgHoldMinutes = holdsMin.length > 0 ? holdsMin.reduce((a, b) => a + b, 0) / holdsMin.length : null;

    // Outliers
    const largestWinPct = wins.length > 0 ? Math.max(...wins.map((p) => Number(p.realized_pnl_pct ?? 0))) : null;
    const largestLossPct = losses.length > 0 ? Math.min(...losses.map((p) => Number(p.realized_pnl_pct ?? 0))) : null;

    // Cluster de stops : ≥3 dans ≤10 min → signal de rupture de régime
    let stopsClusterFlag = false;
    let stopsClusterWindowMinutes: number | null = null;
    if (closesStop.length >= 3) {
      for (let i = 0; i <= closesStop.length - 3; i++) {
        const t0 = new Date(closesStop[i].exit_timestamp as string).getTime();
        const t2 = new Date(closesStop[i + 2].exit_timestamp as string).getTime();
        const winMin = (t2 - t0) / 60000;
        if (winMin <= 10) {
          stopsClusterFlag = true;
          stopsClusterWindowMinutes = Math.round(winMin);
          break;
        }
      }
    }

    // Positions ouvertes actuelles + exposition
    const { data: openPos } = await client
      .from('lisa_positions')
      .select('entry_notional_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const openCount = (openPos ?? []).length;
    const totalExposure = (openPos ?? []).reduce((sum, p) => sum + Number(p.entry_notional_usd ?? 0), 0);
    const exposurePct = capitalUsd.gt(0) ? (totalExposure / capitalUsd.toNumber()) * 100 : null;

    // Cash depuis dernier snapshot
    const { data: snap } = await client
      .from('lisa_portfolio_snapshots')
      .select('cash_usd')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    const cashUsd = snap?.cash_usd != null ? Number(snap.cash_usd) : null;

    // Drawdown depuis génération directive (peak-to-trough)
    const { data: snapsSince } = await client
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', sinceDirective)
      .order('timestamp', { ascending: true });
    let drawdownSinceDirectivePct: number | null = null;
    if (snapsSince && snapsSince.length >= 2) {
      let peak = Number(snapsSince[0].total_value_usd);
      let maxDD = 0;
      for (const s of snapsSince) {
        const v = Number(s.total_value_usd);
        if (v > peak) peak = v;
        if (peak > 0) {
          const dd = ((peak - v) / peak) * 100;
          if (dd > maxDD) maxDD = dd;
        }
      }
      drawdownSinceDirectivePct = maxDD;
    }

    // Macro cross-validé (VIX + DXY) avec 2 oracles indépendants.
    // Briefing Lisa lit `vix_level` / `dxy_level` — toute valeur stockée
    // doit avoir passé : sanity bounds + cross-validation. Hors-plage ou
    // divergence > 30% entre oracles → null (Lisa raisonne sans la donnée).
    const [vixQuote, dxyQuote, vixOracle2, dxyOracle2] = await Promise.all([
      this.lisa.getLivePrice('VIX').catch(() => null),
      this.lisa.getLivePrice('DXY').catch(() => null),
      this.lisa.fetchMacroIndicator('VIX').catch(() => null),
      this.lisa.fetchMacroIndicator('DXY').catch(() => null),
    ]);

    const validateMacro = (
      raw: number | null,
      oracle2: number | null,
      bounds: [number, number],
      label: string,
    ): number | null => {
      if (raw == null || !Number.isFinite(raw) || raw < bounds[0] || raw > bounds[1]) {
        if (raw != null) this.logger.warn(`[mechanical-trading] ${label}=${raw} hors plage ${bounds[0]}-${bounds[1]}, stocké null`);
        return null;
      }
      if (oracle2 != null) {
        const divPct = Math.abs((raw - oracle2) / oracle2) * 100;
        if (divPct > 30) {
          this.logger.warn(`[mechanical-trading] ${label} divergence live=${raw} vs oracle2=${oracle2} (${divPct.toFixed(0)}%) — stocké null`);
          return null;
        }
      }
      return raw;
    };

    const vixLevelSafe = validateMacro(
      vixQuote ? Number(vixQuote.price) : null,
      vixOracle2 ? vixOracle2.value : null,
      [5, 90],
      'VIX',
    );
    const dxyLevelSafe = validateMacro(
      dxyQuote ? Number(dxyQuote.price) : null,
      dxyOracle2 ? dxyOracle2.value : null,
      [70, 130],
      'DXY',
    );

    const directiveAgeMinutes = Math.round((Date.now() - directive.generatedAt.getTime()) / 60000);

    await client.from('lisa_mechanical_cycle_summary').insert({
      portfolio_id: portfolioId,
      cycle_at: new Date().toISOString(),
      directive_id: directive.id,
      opens_count: opensCount,
      closes_stop_count: closesStop.length,
      closes_target_count: closesTarget.length,
      closes_invalidated_count: closesInvalidated.length,
      net_pnl_since_proposal_usd: netPnl.toFixed(4),
      gross_wins_usd: grossWins.toFixed(4),
      gross_losses_usd: grossLosses.toFixed(4),
      win_rate_pct: winRate != null ? winRate.toFixed(2) : null,
      avg_hold_minutes: avgHoldMinutes != null ? avgHoldMinutes.toFixed(2) : null,
      largest_win_pct: largestWinPct != null ? largestWinPct.toFixed(4) : null,
      largest_loss_pct: largestLossPct != null ? largestLossPct.toFixed(4) : null,
      stops_cluster_flag: stopsClusterFlag,
      stops_cluster_window_minutes: stopsClusterWindowMinutes,
      exposure_pct: exposurePct != null ? exposurePct.toFixed(2) : null,
      cash_usd: cashUsd != null ? cashUsd.toFixed(2) : null,
      open_positions_count: openCount,
      drawdown_since_directive_pct: drawdownSinceDirectivePct != null ? drawdownSinceDirectivePct.toFixed(4) : null,
      vix_level: vixLevelSafe != null ? vixLevelSafe.toFixed(4) : null,
      dxy_level: dxyLevelSafe != null ? dxyLevelSafe.toFixed(4) : null,
      directive_age_minutes: directiveAgeMinutes,
    }).then(({ error }) => {
      if (error) this.logger.warn(`cycle summary insert failed: ${error.message}`);
    });
  }

  private async loadDirective(portfolioId: string): Promise<MechanicalDirective | null> {
    const { data } = await this.supabase.getClient()
      .from('lisa_mechanical_directives')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      id: data.id as string,
      portfolioId: data.portfolio_id as string,
      marketMomentum: (data.market_momentum as MechanicalDirective['marketMomentum']) ?? 'neutral',
      trajectoryStatus: (data.trajectory_status as MechanicalDirective['trajectoryStatus']) ?? 'DANS_LE_PLAN',
      activeThemes: (data.active_themes as string[]) ?? [],
      favoredAssetClasses: (data.favored_asset_classes as string[]) ?? [],
      avoidedAssetClasses: (data.avoided_asset_classes as string[]) ?? [],
      targetSymbols: (data.target_symbols as TargetSymbol[]) ?? [],
      closeConditions: (data.close_conditions as CloseCondition[]) ?? [],
      riskPosture: (data.risk_posture as MechanicalDirective['riskPosture']) ?? 'normal',
      tacticalOverrides: (data.tactical_overrides as TacticalOverrides | null) ?? {},
      generatedAt: new Date(data.generated_at as string),
      validUntil: new Date(data.valid_until as string),
    };
  }

  /**
   * Compte le nombre de cycles consécutifs (depuis le plus récent) ayant
   * opens_count = 0. Utilisé pour détecter une paralysie défensive.
   */
  private async countConsecutiveZeroOpenCycles(portfolioId: string): Promise<number> {
    const { data } = await this.supabase.getClient()
      .from('lisa_mechanical_cycle_summary')
      .select('opens_count')
      .eq('portfolio_id', portfolioId)
      .order('cycle_at', { ascending: false })
      .limit(20);

    if (!data || data.length === 0) return 0;

    let count = 0;
    for (const row of data) {
      if ((row.opens_count as number) === 0) count++;
      else break;
    }
    return count;
  }

  /**
   * Relâche progressivement les overrides défensifs après N cycles inactifs,
   * pour éviter qu'un wake-up ponctuel paralyse le système indéfiniment.
   *
   * Seuils (en cycles, 1 cycle = 1 min) :
   *   ≥ 5  → relax léger  : pauseOpens retiré si EN_RETARD, minConviction → 7, stops → 0.90
   *   ≥ 10 → relax moyen  : minConviction → 6, stops → 0.95
   *   ≥ 15 → reset complet : tous les overrides défensifs retirés
   *
   * En HORS_TRAJECTOIRE : on conserve la posture défensive globalement,
   * mais on évite le verrouillage perpétuel. Après 30 cycles inactifs
   * (drawdown stabilisé ou simple absence d'opportunité), on retire
   * UNIQUEMENT pauseOpens pour permettre à Lisa de re-proposer
   * timidement — minConvictionOverride et tightenStopsMultiplier restent
   * actifs pour limiter le risque résiduel.
   */
  private async relaxDefensiveOverrides(
    overrides: TacticalOverrides,
    consecutiveZeroCycles: number,
    trajectoryStatus: string,
    portfolioId: string,
  ): Promise<TacticalOverrides> {
    if (consecutiveZeroCycles < 5) return overrides;

    // HORS_TRAJECTOIRE — relaxation MINIMALE après 30 cycles, pas avant
    if (trajectoryStatus === 'HORS_TRAJECTOIRE') {
      if (consecutiveZeroCycles < 30) return overrides;
      if (overrides.pauseOpens !== true) return overrides;

      const relaxedHt: TacticalOverrides = { ...overrides };
      delete relaxedHt.pauseOpens;
      delete relaxedHt.pauseOpensReason;

      this.logger.log(
        `[OVERRIDE RESET HORS_TRAJECTOIRE] ${portfolioId.slice(0, 8)} — pauseOpens retiré apres ${consecutiveZeroCycles} cycles, autres overrides conservés`,
      );
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: `[OVERRIDE RESET HORS_TRAJECTOIRE] Verrou pauseOpens libéré après ${consecutiveZeroCycles} cycles inactifs (autres overrides défensifs conservés)`,
        rationale:
          'Évite la paralysie perpétuelle quand la trajectoire reste HORS_TRAJECTOIRE longtemps : on permet à Lisa de re-proposer timidement, mais minConvictionOverride et tightenStopsMultiplier restent actifs.',
        payload: {
          consecutive_zero_cycles: consecutiveZeroCycles,
          original_overrides: overrides,
          relaxed_overrides: relaxedHt,
          trajectory_status: trajectoryStatus,
          mode: 'hors_trajectoire_minimal_relax',
        },
        triggeredBy: 'mechanical_cron',
      });
      return relaxedHt;
    }

    const hasDefensiveOverrides =
      overrides.pauseOpens === true ||
      (overrides.minConvictionOverride != null && overrides.minConvictionOverride >= 7) ||
      (overrides.tightenStopsMultiplier != null && overrides.tightenStopsMultiplier < 0.95);

    if (!hasDefensiveOverrides) return overrides;

    const relaxed: TacticalOverrides = { ...overrides };

    if (consecutiveZeroCycles >= 15) {
      delete relaxed.pauseOpens;
      delete relaxed.pauseOpensReason;
      delete relaxed.minConvictionOverride;
      delete relaxed.tightenStopsMultiplier;
    } else if (consecutiveZeroCycles >= 10) {
      delete relaxed.pauseOpens;
      delete relaxed.pauseOpensReason;
      if (relaxed.minConvictionOverride != null && relaxed.minConvictionOverride > 6) {
        relaxed.minConvictionOverride = 6;
      }
      if (relaxed.tightenStopsMultiplier != null && relaxed.tightenStopsMultiplier < 0.95) {
        relaxed.tightenStopsMultiplier = 0.95;
      }
    } else {
      // 5–9 cycles
      if (relaxed.pauseOpens === true && trajectoryStatus === 'EN_RETARD') {
        delete relaxed.pauseOpens;
        delete relaxed.pauseOpensReason;
      }
      if (relaxed.minConvictionOverride != null && relaxed.minConvictionOverride > 7) {
        relaxed.minConvictionOverride = 7;
      }
      if (relaxed.tightenStopsMultiplier != null && relaxed.tightenStopsMultiplier < 0.90) {
        relaxed.tightenStopsMultiplier = 0.90;
      }
    }

    this.logger.log(
      `[OVERRIDE RESET] ${portfolioId.slice(0, 8)} — ${consecutiveZeroCycles} cycles inactifs` +
      ` → minConv=${relaxed.minConvictionOverride ?? 'off'}` +
      ` stops=${relaxed.tightenStopsMultiplier ?? 1.0}` +
      ` pauseOpens=${relaxed.pauseOpens ?? false}`,
    );

    await this.decisionLog.append({
      portfolioId,
      kind: 'autopilot_cycle_completed',
      summary: `[OVERRIDE RESET] Relâchement overrides défensifs après ${consecutiveZeroCycles} cycles inactifs (trajectoire=${trajectoryStatus})`,
      rationale:
        consecutiveZeroCycles >= 15
          ? 'Reset complet : wake-up défensif résorbé, aucune action depuis 15+ cycles.'
          : consecutiveZeroCycles >= 10
            ? 'Relax moyen : minConviction→6, stops→0.95, pauseOpens retiré.'
            : 'Relax léger : minConviction→7, stops→0.90, pauseOpens retiré si EN_RETARD.',
      payload: {
        consecutive_zero_cycles: consecutiveZeroCycles,
        original_overrides: overrides,
        relaxed_overrides: relaxed,
        trajectory_status: trajectoryStatus,
      },
      triggeredBy: 'mechanical_cron',
    });

    return relaxed;
  }
}
