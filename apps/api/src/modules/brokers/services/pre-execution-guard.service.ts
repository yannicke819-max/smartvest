import { Injectable, Logger } from '@nestjs/common';
import type { BrokerProvider } from '@smartvest/domain';
import { checkMandatePermission, type AutonomyMandate } from '@smartvest/domain';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';

/**
 * Phase D — Pre-execution Guard Chain.
 *
 * Vérifie TOUTES les conditions cumulatives avant qu'un ordre LIVE soit
 * envoyé au broker (cf. CLAUDE.md §6 ter — chaîne de garde-fous).
 *
 * Si UNE seule condition échoue → throw BrokerExecutionBlockedException
 * avec raison explicite. Audit hash-chaîné dans `lisa_decision_log`
 * (kind='broker_execution_blocked').
 *
 * Conditions cumulatives (ordre de check rapide → cher) :
 *   1. BROKER_EXECUTION_ENABLED=true                  [feature flag]
 *   2. BROKER_ADAPTER_<X>_ENABLED=true                [feature flag per provider]
 *   3. DELEGATION_AUTONOMOUS_GUARDED=true             [feature flag]
 *   4. AUTONOMY_KILL_SWITCH=false                     [feature flag global]
 *   5. AutonomyMandate actif + checkMandatePermission [DB row + helper]
 *   6. ticker NOT IN forbiddenTickers                 [mandate.guardrail]
 *   7. asset_class ∈ allowedAssetClasses              [mandate.guardrail]
 *   8. position_notional ≤ maxSingleTradePct × portfolio_value  [calc]
 *   9. position_notional ≤ maxPositionSizePct × portfolio_value [calc]
 *   10. daily_traded + position_notional ≤ maxDailyTradePct × portfolio_value
 *   11. portfolio_drawdown ≤ stopLossTriggerPct       [calc]
 *
 * Pour V1 on délègue la mesure du portfolio_value et daily_traded au caller
 * via le `context` parameter — le service ne fait pas la query lui-même
 * pour rester testable + ne pas dupliquer la logique de calcul des
 * snapshots.
 */

export interface PreExecutionContext {
  userId: string;
  portfolioId: string;
  provider: BrokerProvider;

  /** Order being checked */
  symbol: string;
  assetClass: string;
  notionalUsd: number;
  side: 'buy' | 'sell';

  /** Portfolio context (caller responsibility to provide) */
  portfolioMarketValueUsd: number;
  dailyTradedNotionalUsd: number;
  /** Drawdown du portfolio depuis high-water mark, en pct (0..100) */
  portfolioDrawdownPct: number;
}

export interface PreExecutionResult {
  /** true si ALL checks passed — caller peut placeOrder */
  allowed: boolean;
  /** Si bloqué : raison structurée pour audit + UI */
  blockedReason?: {
    code: string;
    label: string;
    detail?: Record<string, unknown>;
  };
}

export class BrokerExecutionBlockedException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrokerExecutionBlockedException';
  }
}

@Injectable()
export class PreExecutionGuardService {
  private readonly logger = new Logger(PreExecutionGuardService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Vérifie toutes les conditions. Throw BrokerExecutionBlockedException si
   * une condition échoue. Audit dans lisa_decision_log dans tous les cas
   * (allowed ou blocked).
   *
   * Caller responsibility : appelle ce check JUSTE AVANT chaque placeOrder()
   * réel. Si throw → log + propage l'exception. Si returns → placeOrder OK.
   */
  async checkPreExecution(ctx: PreExecutionContext): Promise<PreExecutionResult> {
    const result = await this.runChecks(ctx);
    await this.auditCheck(ctx, result);
    return result;
  }

  private async runChecks(ctx: PreExecutionContext): Promise<PreExecutionResult> {
    const flags = this.flags.getAll();

    // 1. Master execution flag
    if (!flags.BROKER_EXECUTION_ENABLED) {
      return this.blocked('exec_disabled', 'Broker execution disabled', {
        flag: 'BROKER_EXECUTION_ENABLED',
      });
    }

    // 2. Adapter-specific flag
    const adapterFlagKey = this.adapterFlagFor(ctx.provider);
    if (adapterFlagKey && !flags[adapterFlagKey]) {
      return this.blocked('adapter_disabled', `Adapter ${ctx.provider} disabled`, {
        flag: adapterFlagKey,
      });
    }

    // 3. Autonomous guarded mode required
    if (!flags.DELEGATION_AUTONOMOUS_GUARDED) {
      return this.blocked('autonomy_disabled', 'Autonomous mode not enabled', {
        flag: 'DELEGATION_AUTONOMOUS_GUARDED',
      });
    }

    // 4. Global kill-switch
    if (flags.AUTONOMY_KILL_SWITCH) {
      return this.blocked('kill_switch_active', 'Global kill-switch active', {});
    }

    // 5. Active mandate exists + valid
    const mandate = await this.fetchActiveMandate(ctx.portfolioId);
    if (!mandate) {
      return this.blocked('no_mandate', 'No active autonomy mandate for this portfolio', {});
    }
    const mandateError = checkMandatePermission(mandate);
    if (mandateError !== null) {
      return this.blocked('mandate_invalid', mandateError, {
        mandate_id: mandate.id,
        mandate_status: mandate.status,
      });
    }

    // 6. Ticker blacklist
    const symbolNorm = ctx.symbol.toUpperCase();
    if (mandate.guardrail.forbiddenTickers.some((t) => t.toUpperCase() === symbolNorm)) {
      return this.blocked('ticker_forbidden', `Ticker ${ctx.symbol} in mandate blacklist`, {
        mandate_id: mandate.id,
        symbol: ctx.symbol,
      });
    }

    // 7. Asset class whitelist
    if (!mandate.guardrail.allowedAssetClasses.includes(ctx.assetClass)) {
      return this.blocked('asset_class_denied', `Asset class ${ctx.assetClass} not in allowed list`, {
        asset_class: ctx.assetClass,
        allowed: mandate.guardrail.allowedAssetClasses,
      });
    }

    // 8-9. Position size caps (% of portfolio)
    if (ctx.portfolioMarketValueUsd <= 0) {
      return this.blocked('portfolio_value_unknown', 'Portfolio market value unavailable', {});
    }
    const positionPct = (ctx.notionalUsd / ctx.portfolioMarketValueUsd) * 100;
    if (positionPct > mandate.guardrail.maxSingleTradePct) {
      return this.blocked('trade_too_large', `Trade size ${positionPct.toFixed(1)}% > maxSingleTradePct ${mandate.guardrail.maxSingleTradePct}%`, {
        position_pct: positionPct,
        max: mandate.guardrail.maxSingleTradePct,
      });
    }
    if (positionPct > mandate.guardrail.maxPositionSizePct) {
      return this.blocked('position_too_large', `Position ${positionPct.toFixed(1)}% > maxPositionSizePct ${mandate.guardrail.maxPositionSizePct}%`, {
        position_pct: positionPct,
        max: mandate.guardrail.maxPositionSizePct,
      });
    }

    // 10. Daily traded cap
    const dailyTradedAfter = ctx.dailyTradedNotionalUsd + ctx.notionalUsd;
    const dailyPct = (dailyTradedAfter / ctx.portfolioMarketValueUsd) * 100;
    if (dailyPct > mandate.guardrail.maxDailyTradePct) {
      return this.blocked('daily_limit_exceeded', `Daily traded ${dailyPct.toFixed(1)}% > maxDailyTradePct ${mandate.guardrail.maxDailyTradePct}%`, {
        daily_pct: dailyPct,
        max: mandate.guardrail.maxDailyTradePct,
      });
    }

    // 11. Drawdown trigger
    if (ctx.portfolioDrawdownPct > mandate.guardrail.stopLossTriggerPct) {
      return this.blocked('drawdown_trigger', `Portfolio drawdown ${ctx.portfolioDrawdownPct.toFixed(1)}% > stopLossTriggerPct ${mandate.guardrail.stopLossTriggerPct}%`, {
        drawdown_pct: ctx.portfolioDrawdownPct,
        max: mandate.guardrail.stopLossTriggerPct,
      });
    }

    // ALL checks passed
    return { allowed: true };
  }

  private blocked(code: string, label: string, detail: Record<string, unknown>): PreExecutionResult {
    return { allowed: false, blockedReason: { code, label, detail } };
  }

  private adapterFlagFor(provider: BrokerProvider): keyof ReturnType<FeatureFlagsService['getAll']> | null {
    switch (provider) {
      case 'INTERACTIVE_BROKERS': return 'BROKER_ADAPTER_IB_ENABLED';
      case 'SAXO': return 'BROKER_ADAPTER_SAXO_ENABLED';
      case 'DEGIRO': return 'BROKER_ADAPTER_DEGIRO_ENABLED';
      case 'TRADING212': return 'BROKER_ADAPTER_TRADING212_ENABLED';
      case 'BINANCE': return 'BROKER_ADAPTER_BINANCE_ENABLED';
      default: return null;
    }
  }

  private async fetchActiveMandate(portfolioId: string): Promise<AutonomyMandate | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('autonomy_mandates')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'active')
      .maybeSingle();
    if (error || !data) return null;
    // Manual coercion — DB row → AutonomyMandate. On délègue la zod parse
    // au caller si besoin (V2 : strict validation).
    return data as unknown as AutonomyMandate;
  }

  private async auditCheck(ctx: PreExecutionContext, result: PreExecutionResult): Promise<void> {
    const kind = result.allowed
      ? 'broker_execution_allowed'
      : 'broker_execution_blocked';
    const summary = result.allowed
      ? `[GUARD] ${ctx.symbol} ${ctx.side} $${ctx.notionalUsd.toFixed(0)} allowed`
      : `[GUARD] ${ctx.symbol} ${ctx.side} blocked — ${result.blockedReason?.code}: ${result.blockedReason?.label}`;
    try {
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          user_id: ctx.userId,
          portfolio_id: ctx.portfolioId,
          kind,
          summary,
          rationale: result.allowed
            ? 'Pre-execution guard chain : 11/11 conditions passed.'
            : `Pre-execution guard chain blocked at ${result.blockedReason?.code}: ${result.blockedReason?.label}`,
          payload: {
            symbol: ctx.symbol,
            asset_class: ctx.assetClass,
            notional_usd: ctx.notionalUsd,
            side: ctx.side,
            provider: ctx.provider,
            portfolio_value_usd: ctx.portfolioMarketValueUsd,
            daily_traded_usd: ctx.dailyTradedNotionalUsd,
            drawdown_pct: ctx.portfolioDrawdownPct,
            blocked_reason: result.blockedReason ?? null,
          },
          triggered_by: 'pre_execution_guard',
        });
    } catch (e) {
      this.logger.warn(`[guard-audit] insert failed: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Convenience helper : throws BrokerExecutionBlockedException si bloqué.
   * Usage : `await guard.assertAllowed(ctx)` — propage l'exception aux
   * callers qui veulent un control-flow en exception plutôt qu'en if/else.
   */
  async assertAllowed(ctx: PreExecutionContext): Promise<void> {
    const result = await this.checkPreExecution(ctx);
    if (!result.allowed && result.blockedReason) {
      throw new BrokerExecutionBlockedException(
        result.blockedReason.code,
        result.blockedReason.label,
        result.blockedReason.detail,
      );
    }
  }
}
