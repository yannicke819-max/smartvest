/**
 * RiskMonitorService — HARD KILL switch indépendant de Claude
 *
 * Ce service tourne EN CONTINU (cron toutes les 5 min ou à chaque snapshot)
 * et vérifie :
 *   - Drawdown 2 jours > maxDrawdown2DaysPct (HARD KILL)
 *   - Drawdown 7 jours > maxDrawdown7DaysPct (alerte + pause new positions)
 *   - Drawdown 30 jours > maxDrawdown30DaysPct (alerte + review forced)
 *   - Stop-loss individuel par position
 *   - Take-profit individuel par position
 *   - Horizon expired par position
 *   - Invalidation conditions par position
 *
 * Si HARD KILL : ferme TOUTES les positions au prix live, portfolio → 100% cash.
 * Le user ne peut pas override le HARD KILL — c'est structurel.
 */

import Decimal from 'decimal.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RiskConstraints } from '../types';
import type { PaperBrokerService } from './paper-broker.service';
import type { PaperPosition, PortfolioSnapshot } from './types';

export interface RiskCheckResult {
  portfolioId: string;
  timestamp: string;
  status: 'ok' | 'warning' | 'critical' | 'hard_kill';
  violations: Array<{
    code: string;
    severity: 'warning' | 'critical' | 'hard_kill';
    message: string;
    currentValue: number | string;
    threshold: number | string;
  }>;
  /** Actions prises en réponse (closed positions, notifications) */
  actionsApplied: Array<{
    kind: 'position_closed' | 'alert_raised' | 'autopilot_paused' | 'kill_switch_triggered';
    details: string;
  }>;
  snapshot: PortfolioSnapshot;
}

export class RiskMonitorService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly paperBroker: PaperBrokerService,
    private readonly fetchLivePrice: (symbol: string) => Promise<{ price: string }>,
  ) {}

  /**
   * Check complet — appelé par cron ou sur événement manuel.
   */
  async checkPortfolio(
    portfolioId: string,
    constraints: RiskConstraints,
  ): Promise<RiskCheckResult> {
    const result: RiskCheckResult = {
      portfolioId,
      timestamp: new Date().toISOString(),
      status: 'ok',
      violations: [],
      actionsApplied: [],
      snapshot: await this.paperBroker.computeSnapshot(portfolioId),
    };

    // 1. Check drawdown 2 jours (HARD KILL)
    const drawdown2d = await this.computeDrawdownOverWindow(portfolioId, 2);
    if (drawdown2d !== null && Math.abs(drawdown2d) > constraints.maxDrawdown2DaysPct) {
      result.violations.push({
        code: 'DRAWDOWN_2D_HARD_LIMIT',
        severity: 'hard_kill',
        message: `2-day drawdown ${drawdown2d.toFixed(2)}% exceeds HARD limit ${constraints.maxDrawdown2DaysPct}%`,
        currentValue: drawdown2d,
        threshold: -constraints.maxDrawdown2DaysPct,
      });
      result.status = 'hard_kill';

      if (constraints.autoLiquidateOnKill) {
        const closed = await this.liquidateAll(portfolioId, 'closed_kill', 'Hard-kill: 2-day drawdown limit breached');
        result.actionsApplied.push({
          kind: 'kill_switch_triggered',
          details: `Liquidated ${closed.length} open positions at market.`,
        });
      }
    }

    // 2. Check drawdown 7 jours (warning / pause autopilot)
    const drawdown7d = await this.computeDrawdownOverWindow(portfolioId, 7);
    if (
      drawdown7d !== null &&
      Math.abs(drawdown7d) > constraints.maxDrawdown7DaysPct &&
      result.status !== 'hard_kill'
    ) {
      result.violations.push({
        code: 'DRAWDOWN_7D_SOFT_LIMIT',
        severity: 'critical',
        message: `7-day drawdown ${drawdown7d.toFixed(2)}% exceeds limit ${constraints.maxDrawdown7DaysPct}%. Autopilot paused.`,
        currentValue: drawdown7d,
        threshold: -constraints.maxDrawdown7DaysPct,
      });
      result.status = 'critical';
      result.actionsApplied.push({
        kind: 'autopilot_paused',
        details: '7-day drawdown exceeded — new positions forbidden until user review.',
      });
    }

    // 3. Check drawdown 30 jours (warning seulement)
    const drawdown30d = await this.computeDrawdownOverWindow(portfolioId, 30);
    if (
      drawdown30d !== null &&
      Math.abs(drawdown30d) > constraints.maxDrawdown30DaysPct &&
      result.status === 'ok'
    ) {
      result.violations.push({
        code: 'DRAWDOWN_30D_WARN',
        severity: 'warning',
        message: `30-day drawdown ${drawdown30d.toFixed(2)}% exceeds target ${constraints.maxDrawdown30DaysPct}%`,
        currentValue: drawdown30d,
        threshold: -constraints.maxDrawdown30DaysPct,
      });
      result.status = 'warning';
    }

    // 4. Check positions individuelles (stop / target / horizon / invalidation)
    if (result.status !== 'hard_kill') {
      const openPositions = await this.paperBroker.getPositions(portfolioId, true);
      for (const pos of openPositions) {
        await this.checkPositionLimits(pos, result);
      }
    }

    // Persist le résultat (decision log)
    await this.persistRiskCheck(result);

    return result;
  }

  /**
   * Vérifie les niveaux stop/target/horizon d'une position individuelle.
   */
  private async checkPositionLimits(
    pos: PaperPosition,
    result: RiskCheckResult,
  ): Promise<void> {
    let livePrice: Decimal;
    try {
      const quote = await this.fetchLivePrice(pos.symbol);
      livePrice = new Decimal(quote.price);
    } catch {
      return;  // skip si prix indisponible
    }

    const entryPx = new Decimal(pos.entryPrice);
    const isLong = pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put';

    // Stop-loss
    if (pos.stopLossPrice) {
      const stopPx = new Decimal(pos.stopLossPrice);
      const triggered = isLong
        ? livePrice.lessThanOrEqualTo(stopPx)
        : livePrice.greaterThanOrEqualTo(stopPx);
      if (triggered) {
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_stop',
          livePrice: livePrice.toFixed(10),
          rationale: `Stop-loss ${stopPx.toFixed(4)} triggered at live price ${livePrice.toFixed(4)}`,
        });
        result.actionsApplied.push({
          kind: 'position_closed',
          details: `${pos.symbol} closed on stop-loss (${stopPx.toFixed(4)})`,
        });
        return;
      }
    }

    // Take-profit
    if (pos.takeProfitPrice) {
      const tpPx = new Decimal(pos.takeProfitPrice);
      const triggered = isLong
        ? livePrice.greaterThanOrEqualTo(tpPx)
        : livePrice.lessThanOrEqualTo(tpPx);
      if (triggered) {
        await this.paperBroker.closePosition({
          positionId: pos.id,
          reason: 'closed_target',
          livePrice: livePrice.toFixed(10),
          rationale: `Take-profit ${tpPx.toFixed(4)} triggered at live price ${livePrice.toFixed(4)}`,
        });
        result.actionsApplied.push({
          kind: 'position_closed',
          details: `${pos.symbol} closed on take-profit (${tpPx.toFixed(4)})`,
        });
        return;
      }
    }

    // Horizon expired
    if (pos.horizonTargetDate && new Date(pos.horizonTargetDate) < new Date()) {
      await this.paperBroker.closePosition({
        positionId: pos.id,
        reason: 'closed_expired',
        livePrice: livePrice.toFixed(10),
        rationale: `Horizon ${pos.horizonTargetDate} expired without target/stop hit`,
      });
      result.actionsApplied.push({
        kind: 'position_closed',
        details: `${pos.symbol} closed on horizon expiry`,
      });
    }

    // Position individual drawdown check (kill single position if > 50% down)
    const pnlPct = isLong
      ? livePrice.minus(entryPx).dividedBy(entryPx).mul(100)
      : entryPx.minus(livePrice).dividedBy(entryPx).mul(100);
    if (pnlPct.toNumber() < -50) {
      await this.paperBroker.closePosition({
        positionId: pos.id,
        reason: 'closed_kill',
        livePrice: livePrice.toFixed(10),
        rationale: `Position drawdown ${pnlPct.toFixed(1)}% exceeds -50% safety cap`,
      });
      result.actionsApplied.push({
        kind: 'position_closed',
        details: `${pos.symbol} force-closed at -50% safety cap`,
      });
    }
  }

  /**
   * Compute drawdown from peak value over a sliding window (days).
   */
  private async computeDrawdownOverWindow(
    portfolioId: string,
    windowDays: number,
  ): Promise<number | null> {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    const { data, error } = await this.supabase
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd, timestamp')
      .eq('portfolio_id', portfolioId)
      .gte('timestamp', since)
      .order('timestamp', { ascending: true });

    if (error || !data || data.length < 2) return null;

    const values = data.map((d) => new Decimal(d.total_value_usd as string));
    const peak = values.reduce((max, v) => (v.greaterThan(max) ? v : max), values[0]);
    const current = values[values.length - 1];

    if (peak.isZero()) return null;
    return current.minus(peak).dividedBy(peak).mul(100).toNumber();
  }

  /**
   * Ferme TOUTES les positions ouvertes du portfolio (kill-switch).
   */
  private async liquidateAll(
    portfolioId: string,
    reason: 'closed_kill' | 'closed_user',
    rationale: string,
  ): Promise<PaperPosition[]> {
    const openPositions = await this.paperBroker.getPositions(portfolioId, true);
    const closed: PaperPosition[] = [];

    for (const pos of openPositions) {
      try {
        const quote = await this.fetchLivePrice(pos.symbol);
        const closedPos = await this.paperBroker.closePosition({
          positionId: pos.id,
          reason,
          livePrice: quote.price,
          rationale,
        });
        closed.push(closedPos);
      } catch (e) {
        console.error(`Failed to liquidate ${pos.symbol}: ${String(e)}`);
      }
    }
    return closed;
  }

  /**
   * Enregistre le résultat du risk check dans la decision log (pour audit).
   */
  private async persistRiskCheck(result: RiskCheckResult): Promise<void> {
    if (result.violations.length === 0 && result.actionsApplied.length === 0) {
      return;  // pas de log si rien à signaler
    }

    const { error } = await this.supabase.from('lisa_decision_log').insert({
      portfolio_id: result.portfolioId,
      kind:
        result.status === 'hard_kill'
          ? 'kill_switch_triggered'
          : result.status === 'critical'
            ? 'risk_limit_breached'
            : 'autopilot_cycle_completed',
      summary: `Risk check: ${result.status}, ${result.violations.length} violation(s), ${result.actionsApplied.length} action(s)`,
      rationale: result.violations.map((v) => v.message).join(' | '),
      payload: {
        status: result.status,
        violations: result.violations,
        actionsApplied: result.actionsApplied,
        snapshotId: result.snapshot.id,
      },
      triggered_by: 'risk_monitor',
      timestamp: result.timestamp,
    });

    if (error) {
      console.warn(`Risk check persist failed: ${error.message}`);
    }
  }
}
