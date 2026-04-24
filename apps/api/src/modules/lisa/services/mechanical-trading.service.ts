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
}

interface SessionConfig {
  portfolio_id: string;
  autopilot_enabled: boolean;
  kill_switch_active: boolean;
  capital_usd: string;
  risk_constraints: Record<string, unknown>;
  autopilot_market_hours_only?: boolean;
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
    for (const pos of currentPositions) {
      await this.checkStopTarget(pos);
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
    const overrides = directive.tacticalOverrides ?? {};

    // Lisa a explicitement demandé une pause → aucune ouverture ce cycle
    if (overrides.pauseOpens === true) {
      this.logger.log(
        `[MÉCANIQUE] ${portfolioId.slice(0, 8)} — pauseOpens=true (reason=${overrides.pauseOpensReason ?? 'unspecified'}) — skip ouvertures`,
      );
      return;
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

    // Override : fermer la plus basse conviction si exposition > seuil
    if (overrides.closeLowestConvictionIfExposureAbovePct != null && activePositions.length > 0) {
      // Note: le runtime Supabase renvoie snake_case, on accède via bracket (l'interface OpenPosition est partielle)
      const readNotional = (p: OpenPosition) =>
        Number((p as unknown as Record<string, unknown>)['entry_notional_usd'] ?? 0);
      const totalExposure = activePositions.reduce((s, p) => s + readNotional(p), 0);
      const exposurePct = capitalUsd.gt(0) ? (totalExposure / capitalUsd.toNumber()) * 100 : 0;
      if (exposurePct > overrides.closeLowestConvictionIfExposureAbovePct) {
        // On identifie la position avec le plus petit notional comme proxy de "plus basse conviction"
        // (pas de colonne conviction sur lisa_positions ; notional reflète déjà le sizing par conviction)
        const weakest = [...activePositions].sort(
          (a, b) => readNotional(a) - readNotional(b),
        )[0];
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

    // Override Lisa : maxNewOpensOverride ne peut que RÉDUIRE, jamais relâcher
    const openCap = overrides.maxNewOpensOverride != null
      ? Math.min(openCapFromTrajectory, overrides.maxNewOpensOverride)
      : openCapFromTrajectory;

    // Override Lisa : conviction minimum (surcharge le seuil EN_AVANCE)
    const minConvictionFromTrajectory = directive.trajectoryStatus === 'EN_AVANCE' ? 7 : 0;
    const minConviction = overrides.minConvictionOverride != null
      ? Math.max(minConvictionFromTrajectory, overrides.minConvictionOverride)
      : minConvictionFromTrajectory;

    // Override Lisa : stops serrés (multiplier < 1 = stops plus proches du prix d'entrée)
    const stopsMult = typeof overrides.tightenStopsMultiplier === 'number'
      ? overrides.tightenStopsMultiplier
      : 1.0;

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
      const maxNotional = capitalUsd.mul(maxPositionPct).div(100).mul(sizingMultiplier);
      const notional = Decimal.min(maxNotional, cashUsd.mul(0.9));
      if (notional.lt(10)) continue;

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
      const fallbackStopPct = target.stopLossPct ?? 2;
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

      // Coût simulé : 10 bps (mécanique, pas de négociation fine)
      const costBps = 10;
      const estimatedCost = notional.mul(costBps).div(10000);
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

  private async checkStopTarget(pos: OpenPosition): Promise<void> {
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
    await this.checkReactiveSignals(pos, currentPrice);
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
  private async checkReactiveSignals(pos: OpenPosition, currentPrice: Decimal): Promise<void> {
    const entryPx = new Decimal(pos.entryPrice);
    if (entryPx.lte(0)) return;

    const isLong = pos.direction === 'long';
    const pnlPct = isLong
      ? currentPrice.minus(entryPx).div(entryPx).mul(100).toNumber()
      : entryPx.minus(currentPrice).div(entryPx).mul(100).toNumber();

    // Pas de signal réactif si position fraîche (< 2 min) — évite les close
    // sur bougie de formation pendant l'ouverture
    const ageMs = Date.now() - new Date((pos as unknown as Record<string, unknown>)['entry_timestamp'] as string || Date.now()).getTime();
    if (ageMs < 2 * 60_000) return;

    // Récupère les indicateurs techniques (cache 5 min, donc appels réels ~12/h)
    const eodhdTicker = (this.lisa as unknown as { toEodhdTicker(s: string): string }).toEodhdTicker(pos.symbol);
    let ind: import('./eodhd-technical.service').TechnicalIndicators | null = null;
    try {
      ind = await this.technical.getIndicators(eodhdTicker, currentPrice.toNumber());
    } catch { /* indicators unavailable — skip reactive, keep baseline stops */ }

    if (!ind) return;

    // ─── a) Close anticipé sur signal de reversal ───────────────────────────
    let reactiveCloseReason: string | null = null;

    // RSI extreme + P&L positif → lock in profits
    if (pnlPct > 1) {
      if (isLong && ind.rsi14 != null && ind.rsi14 > 80) {
        reactiveCloseReason = `RSI14=${ind.rsi14.toFixed(1)} > 80 (overbought) + P&L=+${pnlPct.toFixed(2)}% → take profit`;
      } else if (!isLong && ind.rsi14 != null && ind.rsi14 < 20) {
        reactiveCloseReason = `RSI14=${ind.rsi14.toFixed(1)} < 20 (oversold) + P&L=+${pnlPct.toFixed(2)}% → take profit short`;
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
    if (pnlPct <= 1.5) return; // pas encore assez de marge

    let newStopPct: number | null = null;
    if (pnlPct >= 5 && ind.atr14Pct != null && ind.atr14Pct > 0) {
      // Trail à -1× ATR du prix actuel
      newStopPct = ind.atr14Pct;
    } else if (pnlPct >= 3) {
      // Stop à +0.5% du entry
      newStopPct = -0.5;
    } else if (pnlPct >= 1.5) {
      // Stop à breakeven (0% vs entry)
      newStopPct = 0;
    }

    if (newStopPct === null) return;

    // Calcul du nouveau prix de stop. newStopPct est :
    //  - distance en % DU PRIX ACTUEL si pnlPct >= 5 (trailing ATR)
    //  - distance en % DU ENTRY si 1.5 <= pnlPct < 5 (breakeven / lock)
    let newStopPrice: Decimal;
    let stopLabel: string;
    if (pnlPct >= 5) {
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

    const costBps = 10;
    const exitCost = notional.mul(costBps).div(10000);
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

    // Macro en cache EODHD ($0 de coût supplémentaire)
    const [vixQuote, dxyQuote] = await Promise.all([
      this.lisa.getLivePrice('VIX').catch(() => null),
      this.lisa.getLivePrice('DXY').catch(() => null),
    ]);

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
      vix_level: vixQuote ? Number(vixQuote.price).toFixed(4) : null,
      dxy_level: dxyQuote ? Number(dxyQuote.price).toFixed(4) : null,
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
}
