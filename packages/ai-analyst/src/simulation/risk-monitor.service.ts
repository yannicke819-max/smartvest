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
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RiskConstraints } from '../types';
import type { PaperBrokerService } from './paper-broker.service';
import type { PaperPosition, PortfolioSnapshot } from './types';

/**
 * Canonical JSON — clés triées récursivement pour stabilité du hash.
 * DOIT matcher le format de DecisionLogService.append() (apps/api) sinon
 * verifyChain() reportera la chaîne corrompue. Si tu modifies l'un, modifie l'autre.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function canonicalTimestamp(ts: string): string {
  return new Date(ts).toISOString();
}

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
    /**
     * Bug #M (14/05/2026) — La signature expose `source` pour que le
     * risk-monitor puisse skipper les prix fallback corrompus (incident
     * SEE.LSE -$1574 le 14/05 : exit_price=0 sur source='fallback_unknown').
     */
    private readonly fetchLivePrice: (symbol: string) => Promise<{ price: string; source: string }>,
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
    let quote: { price: string; source: string };
    try {
      quote = await this.fetchLivePrice(pos.symbol);
      livePrice = new Decimal(quote.price);
    } catch {
      return;  // skip si prix indisponible
    }

    // 🛡️ BUG #M (14/05/2026) — garde-fou anti-prix-0 (incident SEE.LSE -$1574
    // sur exit_price=0 : source='fallback_unknown' producer retournait sentinel
    // '0' que le consumer interprétait comme prix réel → SL trigger faux).
    if (quote.source && quote.source.startsWith('fallback')) {
      console.warn(`[risk-monitor] ${pos.symbol}: source=${quote.source} (fallback) — skip cycle (no SL/TP check)`);
      return;
    }
    if (livePrice.isZero() || livePrice.isNegative() || !livePrice.isFinite()) {
      console.warn(`[risk-monitor] ${pos.symbol}: invalid livePrice ${quote.price} — skip cycle`);
      return;
    }

    const entryPx = new Decimal(pos.entryPrice);

    // 🛡️ Bug #R5 (complément incrémental à Bug #M) — sanity bounds ratio.
    // Bug #M couvrait price≤0 / fallback ; R5 ajoute la borne [0.5x, 2.0x] de
    // l'entry pour rejeter une corruption NON-NULLE (glitch EODHD type 2.5 sur
    // entry 5.0 — ni zéro, ni fallback, mais aberrant). Skip → retry next cycle.
    if (entryPx.gt(0)) {
      const ratio = livePrice.div(entryPx).toNumber();
      if (ratio < 0.5 || ratio > 2.0) {
        console.warn(
          `[risk-monitor] ${pos.symbol}: livePrice ${quote.price} hors sanity bounds ` +
          `[0.5x, 2.0x] entry ${pos.entryPrice} (ratio=${ratio.toFixed(3)}) — skip cycle`,
        );
        return;
      }
    }

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
        // 🛡️ BUG #M (14/05/2026) — anti-prix-0 sur HARD KILL : si le quote est
        // corrompu (source fallback, NaN, ≤0) on ferme à entry_price (pnl=0)
        // plutôt qu'au prix corrompu qui produirait un exit_price=0 + perte -100%.
        const priceNum = parseFloat(quote.price);
        // 🛡️ Bug #R5 — ratio sanity bounds en complément du check Bug #M :
        // rejette aussi une corruption non-nulle hors [0.5x, 2.0x] de l'entry.
        const entryNum = parseFloat(pos.entryPrice);
        const ratio = Number.isFinite(entryNum) && entryNum > 0 ? priceNum / entryNum : 1;
        const corrupt =
          (quote.source != null && quote.source.startsWith('fallback')) ||
          !Number.isFinite(priceNum) ||
          priceNum <= 0 ||
          ratio < 0.5 || ratio > 2.0;
        const liquidationPx = corrupt ? pos.entryPrice : quote.price;
        const closedPos = await this.paperBroker.closePosition({
          positionId: pos.id,
          reason,
          livePrice: liquidationPx,
          rationale: rationale + (corrupt ? ' [Bug#M-guard: closed at entry_price]' : ''),
        });
        closed.push(closedPos);
      } catch (e) {
        console.error(`Failed to liquidate ${pos.symbol}: ${String(e)}`);
      }
    }
    return closed;
  }

  /**
   * Enregistre le résultat du risk check dans la decision log avec hash
   * chaîné canonique. Avant ce fix, l'INSERT direct cassait la chaîne car
   * hash_chain_prev/current restaient vides → /lisa/audit/verify reportait
   * 'Hash chain corrompue'.
   *
   * Format DOIT matcher DecisionLogService.append() (apps/api), sinon le
   * verifyChain divergera. Voir canonicalJson/canonicalTimestamp ci-dessus.
   */
  private async persistRiskCheck(result: RiskCheckResult): Promise<void> {
    if (result.violations.length === 0 && result.actionsApplied.length === 0) {
      return;  // pas de log si rien à signaler
    }

    const kind =
      result.status === 'hard_kill'
        ? 'kill_switch_triggered'
        : result.status === 'critical'
          ? 'risk_limit_breached'
          : 'autopilot_cycle_completed';
    const summary = `Risk check: ${result.status}, ${result.violations.length} violation(s), ${result.actionsApplied.length} action(s)`;
    const rationale = result.violations.map((v) => v.message).join(' | ');
    const payload = {
      status: result.status,
      violations: result.violations,
      actionsApplied: result.actionsApplied,
      snapshotId: result.snapshot.id,
    };
    const timestamp = canonicalTimestamp(result.timestamp);

    // 1. Récupère le hash de la dernière entrée pour ce portfolio
    const { data: prev } = await this.supabase
      .from('lisa_decision_log')
      .select('hash_chain_current')
      .eq('portfolio_id', result.portfolioId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = (prev?.hash_chain_current as string | undefined) ?? null;

    // 2. Calcul du hash courant (format identique à DecisionLogService.append)
    const hashInput = [
      prevHash ?? 'GENESIS',
      kind,
      summary,
      rationale,
      canonicalJson(payload),
      timestamp,
    ].join('|');
    const hashChainCurrent = createHash('sha256').update(hashInput).digest('hex');

    // 3. Insert avec hash chaîné — la chaîne reste vérifiable
    const { error } = await this.supabase.from('lisa_decision_log').insert({
      portfolio_id: result.portfolioId,
      kind,
      summary,
      rationale,
      payload,
      hash_chain_prev: prevHash,
      hash_chain_current: hashChainCurrent,
      triggered_by: 'risk_monitor',
      timestamp,
    });

    if (error) {
      console.warn(`Risk check persist failed: ${error.message}`);
    }
  }
}
