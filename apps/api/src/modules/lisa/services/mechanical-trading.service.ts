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
import { DecisionLogService } from './decision-log.service';
import { LisaService } from './lisa.service';

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
  ) {}

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

    // Reload open positions after stop/target checks
    const { data: positionsForOpen } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    const activePositions: OpenPosition[] = positionsForOpen ?? [];

    const constraints = cfg.risk_constraints ?? {};
    const maxPositions = (constraints['maxOpenPositions'] as number) ?? 10;
    const maxPositionPct = (constraints['maxPositionSizePct'] as number) ?? 25;
    const capitalUsd = new Decimal(cfg.capital_usd || '10000');

    if (activePositions.length >= maxPositions) return;

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
    const openCap =
      directive.trajectoryStatus === 'EN_RETARD' ? 4 :
      directive.trajectoryStatus === 'EN_AVANCE' ? 1 : 2;

    let slotsUsed = 0;

    for (const target of directive.targetSymbols) {
      if (activePositions.length + slotsUsed >= maxPositions) break;
      if (slotsUsed >= openCap) break; // plafond trajectoire

      // En EN_AVANCE : n'ouvrir que sur haute conviction (≥ 7/10)
      if (directive.trajectoryStatus === 'EN_AVANCE' && target.convictionScore < 7) continue;

      // Skip si asset class évitée
      if (directive.avoidedAssetClasses.includes(target.assetClass)) continue;

      // Skip si position déjà ouverte sur ce symbole
      const alreadyOpen = activePositions.some(
        (p) => p.symbol.toUpperCase() === target.symbol.toUpperCase(),
      );
      if (alreadyOpen) continue;

      // Prix live
      const quote = await this.lisa.getLivePrice(target.symbol).catch(() => null);
      if (!quote || Number(quote.price) <= 0) continue;

      const price = new Decimal(quote.price);

      // Taille de position (trajectoire + momentum)
      const maxNotional = capitalUsd.mul(maxPositionPct).div(100).mul(sizingMultiplier);
      const notional = Decimal.min(maxNotional, cashUsd.mul(0.9));
      if (notional.lt(10)) continue;

      // Stop / target prices
      const stopPct = Math.max(target.stopLossPct ?? 2, 0.5);
      const tpPct = Math.max(target.takeProfitPct ?? 4, 0.5);

      const stopPrice = target.direction === 'long'
        ? price.mul(1 - stopPct / 100).toFixed(6)
        : price.mul(1 + stopPct / 100).toFixed(6);
      const takeProfitPrice = target.direction === 'long'
        ? price.mul(1 + tpPct / 100).toFixed(6)
        : price.mul(1 - tpPct / 100).toFixed(6);

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

      await this.decisionLog.append({
        portfolioId,
        kind: 'mechanical_open',
        summary: `[MÉCANIQUE] Ouverture ${target.direction.toUpperCase()} ${target.symbol} @ ${price.toFixed(4)} · notional $${notional.toFixed(0)} · stop ${stopPct}% · target ${tpPct}%`,
        rationale: `Directive Lisa: thèmes=[${directive.activeThemes.slice(0, 3).join(', ')}] trajectoire=${directive.trajectoryStatus} momentum=${directive.marketMomentum} conviction=${target.convictionScore}/10 sizing×${sizingMultiplier.toFixed(2)}`,
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
    } else if (hitTarget) {
      await this.closePosition(pos.id, quote.price, 'closed_target',
        `[MÉCANIQUE] Take-profit atteint ${pos.symbol} @ ${currentPrice.toFixed(4)} (target=${pos.takeProfitPrice})`);
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
      validUntil: new Date(data.valid_until as string),
    };
  }
}
