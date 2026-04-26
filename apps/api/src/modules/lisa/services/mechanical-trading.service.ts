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
  ) {}

  /**
   * Mappe un ticker "natif" (AAPL, BTC, EURUSD) vers un ticker EODHD
   * (AAPL.US). Pour les crypto/FX on retombe sur le ticker brut — EODHD
   * /eod supporte EURUSD.FOREX et BTC-USD.CC mais la corrélation fonctionne
   * mieux sur actions/ETF. Pour ce commit on se concentre sur equity/ETF.
   */
  private toEodhdForCorrelation(symbol: string, assetClass: string): string {
    const cls = assetClass.toLowerCase();
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
   * Formule :
   *   stopATR% = MULTIPLIER × ATR14% du prix actuel
   *   stopFinal% = clamp(stopATR%, FLOOR, CEILING)
   *   si ATR indispo → fallback sur stopPct "Lisa" (propagé)
   *
   * MULTIPLIER=1.5 → classique (distance "1.5 ATR" = 1σ sur horizon court).
   * FLOOR=1.0%     → évite stops trop serrés même sur actifs très calmes.
   * CEILING=5.0%   → limite l'exposition max par position.
   */
  private async deriveAtrStopPct(
    eodhdTicker: string,
    currentPrice: number,
    fallbackPct: number,
  ): Promise<{ stopPct: number; atr14Pct: number | null; source: 'atr' | 'fallback' }> {
    try {
      const ind = await this.technical.getIndicators(eodhdTicker, currentPrice);
      if (ind.atr14Pct != null && ind.atr14Pct > 0) {
        const raw = 1.5 * ind.atr14Pct;
        const clamped = Math.max(1.0, Math.min(5.0, raw));
        return { stopPct: clamped, atr14Pct: ind.atr14Pct, source: 'atr' };
      }
    } catch { /* fall through */ }
    return { stopPct: fallbackPct, atr14Pct: null, source: 'fallback' };
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
      if (cfg.autopilot_market_hours_only && !inMarketHours) continue;
      try {
        await this.processPortfolio(cfg);
      } catch (e) {
        this.logger.error(`Mechanical cycle failed for ${cfg.portfolio_id}: ${String(e)}`);
      }
    }
  }

  private async processPortfolio(cfg: SessionConfig): Promise<void> {
    const portfolioId = cfg.portfolio_id;

    // Load latest valid directive
    const directive = await this.loadDirective(portfolioId);

    // Load open positions
    const { data: positions } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const openPositions: OpenPosition[] = positions ?? [];

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
    await this.triggerAgentLisaSyncIfNeeded(cfg, openPositions)
      .catch((e) => this.logger.warn(`[P5.1] Agent sync eval failed: ${String(e).slice(0, 120)}`));

    // Step 1 — Explicit close requests from Lisa
    if (directive) {
      for (const cond of directive.closeConditions) {
        if (cond.urgency !== 'immediate') continue;
        const pos = openPositions.find((p) => p.id === cond.positionId);
        if (!pos) continue;
        const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
        if (!quote) continue;
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

    const currentPositions: OpenPosition[] = positionsAfterClose ?? [];

    // Step 2 — Stop-loss / take-profit checks (toutes positions, pas besoin de directive)
    const isHyperActiveProfile = cfg.profile === 'hyper_active';
    for (const pos of currentPositions) {
      await this.checkStopTarget(pos, isHyperActiveProfile);
    }

    // Si le guard a fermé la plus faible → on bloque les nouvelles ouvertures
    // mais on laisse les stops/targets tourner (déjà fait ci-dessus).
    if (guard === 'weakest_closed_block_opens') return;

    // Step 3 — Open new positions (seulement si directive valide + trajectoire permet)
    if (!directive || directive.validUntil <= new Date()) {
      if (directive) {
        this.logger.debug(`${portfolioId}: directive expirée — mode défensif uniquement`);
      }
      return;
    }

    // HORS_TRAJECTOIRE → préservation du capital, aucune ouverture
    if (directive.trajectoryStatus === 'HORS_TRAJECTOIRE') {
      this.logger.debug(`${portfolioId}: HORS_TRAJECTOIRE — ouvertures suspendues, protection capital`);
      return;
    }

    // === Overrides tactiques de Lisa (golden-trader) — s'appliquent AVANT le flow trajectoire ===
    const rawOverrides = directive.tacticalOverrides ?? {};

    // Auto-relax : si N cycles consécutifs ont ouvert 0 position ET que des
    // overrides défensifs sont actifs, on les relâche progressivement pour
    // éviter qu'un wake-up ponctuel paralyse le système indéfiniment.
    const consecutiveZeroOpens = await this.countConsecutiveZeroOpenCycles(portfolioId);
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

    const activePositions: OpenPosition[] = positionsForOpen ?? [];

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

    // P4.3 (2-way) — enforcement sur positions EXISTANTES : si une classe
    // dépasse déjà le cap, on ferme la position la moins convaincue
    // (conviction_score si disponible, fallback sur notional pour les
    // positions héritées sans score explicite).
    const readConviction = (p: OpenPosition): number | null => {
      const v = (p as unknown as Record<string, unknown>)['conviction_score'];
      const n = v == null ? null : Number(v);
      return n != null && Number.isFinite(n) ? n : null;
    };
    const capitalForClass = capitalUsd.toNumber();
    if (capitalForClass > 0) {
      for (const [cls, exposureUsd] of exposureByClass.entries()) {
        const classExposurePct = (exposureUsd / capitalForClass) * 100;
        if (classExposurePct <= maxAssetClassPct) continue;

        const candidates = activePositions.filter((p) => readAssetClass(p) === cls);
        if (candidates.length === 0) continue;

        // Tri : conviction_score ASC (plus basse conviction d'abord), puis
        // notional ASC en tie-breaker. Si conviction_score est null sur
        // toutes, le fallback est purement notional (rétrocompatibilité).
        const weakest = [...candidates].sort((a, b) => {
          const ca = readConviction(a);
          const cb = readConviction(b);
          if (ca != null && cb != null && ca !== cb) return ca - cb;
          if (ca != null && cb == null) return -1; // null = inconnu, on garde
          if (ca == null && cb != null) return 1;
          return readNotionalPos(a) - readNotionalPos(b);
        })[0];
        const quote = await this.lisa.getLivePrice(weakest.symbol).catch(() => null);
        if (!quote) continue;

        const weakestNotional = readNotionalPos(weakest);
        await this.closePosition(
          weakest.id,
          quote.price,
          'closed_invalidated',
          `[P4.3 2-way] Classe "${cls}" à ${classExposurePct.toFixed(1)}% > cap ${maxAssetClassPct}% — fermeture ${weakest.symbol} ($${weakestNotional.toFixed(0)}) pour revenir sous cap`,
        );

        await this.decisionLog.append({
          portfolioId,
          kind: 'risk_limit_breached',
          summary: `[P4.3 2-way] Cap asset class violé : ${cls} ${classExposurePct.toFixed(1)}% > ${maxAssetClassPct}% — fermeture ${weakest.symbol}`,
          rationale: `Enforcement post-agrégation : avant ce cycle, la classe "${cls}" cumulait ${exposureUsd.toFixed(0)}$ sur ${capitalForClass.toFixed(0)}$ de capital (${classExposurePct.toFixed(1)}%), au-dessus du seuil ${maxAssetClassPct}%. Fermeture de la position la plus petite (${weakest.symbol}, ${weakestNotional.toFixed(0)}$) pour ramener la classe sous le cap. Les prochaines ouvertures sur cette classe resteront bloquées tant que l'exposition n'est pas revenue sous le seuil.`,
          payload: {
            asset_class: cls,
            exposure_pct: Number(classExposurePct.toFixed(2)),
            cap_pct: maxAssetClassPct,
            closed_symbol: weakest.symbol,
            closed_notional_usd: weakestNotional,
          },
          triggeredBy: 'risk_monitor',
        });

        // Met à jour la map locale pour ne pas retraiter cette classe ce cycle
        exposureByClass.set(cls, exposureUsd - weakestNotional);
      }
    }

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
          if (quote) {
            await this.closePosition(
              weakest.id,
              quote.price,
              'closed_invalidated',
              `[MÉCANIQUE] Override Lisa: exposition ${exposurePct.toFixed(1)}% > seuil ${overrides.closeLowestConvictionIfExposureAbovePct}% — fermeture plus basse conviction`,
            );
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
    const openCap = effectiveMaxNewOpens != null
      ? Math.min(openCapFromTrajectory, effectiveMaxNewOpens)
      : openCapFromTrajectory;

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

    for (const target of directive.targetSymbols) {
      if (activePositions.length + slotsUsed >= maxPositions) break;
      if (slotsUsed >= openCap) break; // plafond trajectoire (éventuellement réduit par override)

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

      const price = new Decimal(quote.price);

      // Taille de position (trajectoire + momentum)
      // En hyper_active, effectiveMaxPositionPct cape à 25 % (cf. ci-dessus).
      const maxNotional = capitalUsd.mul(effectiveMaxPositionPct).div(100).mul(sizingMultiplier);
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
      const classKey = target.assetClass.toLowerCase();
      const currentClassExposure = exposureByClass.get(classKey) ?? 0;
      const projectedClassExposurePct = capitalUsd.gt(0)
        ? ((currentClassExposure + notional.toNumber()) / capitalUsd.toNumber()) * 100
        : 0;
      if (projectedClassExposurePct > maxAssetClassPct) {
        this.logger.debug(
          `[P4.3] Skip ${target.symbol} — exposition classe "${classKey}" projetée ${projectedClassExposurePct.toFixed(1)}% > cap ${maxAssetClassPct}%`,
        );
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
      const atrDerived = await this.deriveAtrStopPct(eodhdTicker, price.toNumber(), fallbackStopPct);
      const stopPct = Math.max(atrDerived.stopPct * stopsMult, 0.3);
      const tpPct = Math.max(target.takeProfitPct ?? Math.max(atrDerived.stopPct * 2, 4), 0.5);

      const stopPrice = target.direction === 'long'
        ? price.mul(1 - stopPct / 100).toFixed(6)
        : price.mul(1 + stopPct / 100).toFixed(6);
      const takeProfitPrice = target.direction === 'long'
        ? price.mul(1 + tpPct / 100).toFixed(6)
        : price.mul(1 - tpPct / 100).toFixed(6);

      this.logger.log(
        `[MÉCANIQUE] ${target.symbol} stop=${stopPct.toFixed(2)}% tp=${tpPct.toFixed(2)}% ` +
        `(source=${atrDerived.source}, ATR14=${atrDerived.atr14Pct?.toFixed(2) ?? 'n/a'}%, override×${stopsMult})`,
      );

      const horizonDays = target.horizonDays ?? 3;
      const horizonTargetDate = new Date(Date.now() + horizonDays * 86_400_000).toISOString();

      // Coûts simulés : fees broker (10 bps) + slippage estimé (10 bps).
      // Le slippage rend la sim plus réaliste vs un trade réel — sans lui
      // on surestime la perf de 10-30% selon la liquidité (cf RETEX
      // "Release It!" Nygard, et patterns Composer/QuantConnect).
      const feeBps = 10;
      const slippageBps = 10;
      const estimatedCost = notional.mul(feeBps + slippageBps).div(10000);
      const notionalNet = notional.minus(estimatedCost);
      const quantity = notionalNet.div(price);

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
          await this.closePosition(
            pos.id,
            quote.price,
            'closed_invalidated',
            `[P4.1 KILL-SWITCH] Drawdown intraday ${drawdownPct.toFixed(2)}% > ${killDD.toFixed(2)}% — fermeture auto`,
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

  private async checkStopTarget(pos: OpenPosition, isHyperActive: boolean = false): Promise<void> {
    if (!pos.stopLossPrice && !pos.takeProfitPrice) return;

    const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
    if (!quote) return;

    const currentPrice = new Decimal(quote.price);
    const stopPrice = pos.stopLossPrice ? new Decimal(pos.stopLossPrice) : null;
    const tpPrice = pos.takeProfitPrice ? new Decimal(pos.takeProfitPrice) : null;

    const isLong = pos.direction === 'long';
    const hitStop = stopPrice && (isLong ? currentPrice.lte(stopPrice) : currentPrice.gte(stopPrice));
    const hitTarget = tpPrice && (isLong ? currentPrice.gte(tpPrice) : currentPrice.lte(tpPrice));

    if (hitStop) {
      await this.closePosition(pos.id, quote.price, 'closed_stop',
        `[MÉCANIQUE] Stop-loss atteint ${pos.symbol} @ ${currentPrice.toFixed(4)} (stop=${pos.stopLossPrice})`);
      return;
    }
    if (hitTarget) {
      await this.closePosition(pos.id, quote.price, 'closed_target',
        `[MÉCANIQUE] Take-profit atteint ${pos.symbol} @ ${currentPrice.toFixed(4)} (target=${pos.takeProfitPrice})`);
      return;
    }

    // AUCUN stop/target atteint → checker les signaux réactifs (indicateurs
    // techniques) pour potentiellement clôturer plus tôt OU trailer le stop.
    await this.checkReactiveSignals(pos, currentPrice, isHyperActive);
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
    const entryPx = new Decimal(pos.entryPrice);
    if (entryPx.lte(0)) return;

    const isLong = pos.direction === 'long';
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

    // Récupère les indicateurs techniques (cache 5 min, donc appels réels ~12/h)
    const eodhdTicker = (this.lisa as unknown as { toEodhdTicker(s: string): string }).toEodhdTicker(pos.symbol);
    let ind: import('./eodhd-technical.service').TechnicalIndicators | null = null;
    try {
      ind = await this.technical.getIndicators(eodhdTicker, currentPrice.toNumber());
    } catch { /* indicators unavailable — skip reactive, keep baseline stops */ }

    if (!ind) return;

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
    if (!reactiveCloseReason && pnlPct > 0 && ind.macdHist != null) {
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
    const vixLevel = vixQuote ? Number(vixQuote.price) : null;

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
            if (quote) {
              await this.closePosition(
                pos.id,
                quote.price,
                'closed_invalidated',
                `AutonomyRule: ${rule.reason}`.slice(0, 500),
              );
              break; // position fermée, plus la peine d'évaluer ses autres règles
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
      return q ? Number(q.price) : null;
    }
    if (metric === 'pnl_pct') {
      const q = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
      if (!q) return null;
      const entry = Number(pos.entryPrice);
      const live = Number(q.price);
      const isLong = pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put';
      return isLong ? ((live - entry) / entry) * 100 : ((entry - live) / entry) * 100;
    }
    if (metric === 'funding_annual_pct') {
      // Crypto only : convertit symbol → format Binance perp (BTCUSDT)
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
    const isLong = (pos.direction as string) === 'long';
    const qty = new Decimal(pos.quantity as string);

    // Coûts symétriques à l'open : fees broker + slippage estimé.
    // Cohérence avec les hypothèses du backtest harness — rend la sim
    // plus pessimiste donc plus alignée avec le réel.
    const feeBps = 10;
    const slippageBps = 10;
    const exitCost = notional.mul(feeBps + slippageBps).div(10000);
    const rawPnl = isLong
      ? exitPrice.minus(entryPrice).mul(qty)
      : entryPrice.minus(exitPrice).mul(qty);
    const realizedPnl = rawPnl.minus(exitCost);
    const pnlPct = realizedPnl.div(notional).mul(100).toNumber();

    const now = new Date().toISOString();
    await this.supabase.getClient()
      .from('lisa_positions')
      .update({
        status: reason,
        exit_price: exitPrice.toFixed(10),
        exit_timestamp: now,
        exit_reason: reason,
        realized_pnl_usd: realizedPnl.toFixed(2),
        realized_pnl_pct: pnlPct,
        updated_at: now,
      })
      .eq('id', positionId);

    // Phase 5 — fire-and-forget : capture l'outcome contextualisé pour
    // l'apprentissage continu Lisa. Ne bloque jamais le close.
    this.tradeOutcomeRecorder
      .recordOutcome(positionId, exitPrice.toFixed(10), reason)
      .catch((e) => this.logger.debug(`outcome record failed: ${String(e).slice(0, 100)}`));

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
   * Calcule et persiste le résumé du cycle mécanique depuis la génération de
   * la directive. Transmis à Lisa avant sa prochaine proposition pour qu'elle
   * intègre : stops touchés, P&L, cluster de régime, exposition, macro (VIX/DXY).
   */
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
