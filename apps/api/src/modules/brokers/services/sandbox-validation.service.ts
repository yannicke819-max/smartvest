import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { LiveTradingWizardService } from './live-trading-wizard.service';

/**
 * PR Wizard.4 — Sandbox auto-validation cron.
 *
 * Surveille les wizards en status='sandbox_running' et auto-valide
 * passe/fail selon les critères Go/No-Go (cf. PRD IBKR).
 *
 * Critères Go (TOUS doivent passer) :
 *   1. Total trades (closed) ≥ 30 sur les 14 derniers jours
 *   2. Win rate ≥ 55% (TP / (TP+SL))
 *   3. Avg cost drift |actual - theoretical| / theoretical < 15%
 *   4. Avg slippage absolu < 30 bps
 *   5. Max drawdown < 5% du capital
 *   6. Aucun kill_switch_activated dans la fenêtre
 *
 * Si TOUS green → forceStep4Result(passed)
 * Si pas assez de trades → continue (next run)
 * Si critère fail → forceStep4Result(failed)
 *
 * Cron : daily 04:00 UTC (post-fermeture US, avant ouverture Asia).
 */

interface ValidationMetrics {
  total_trades: number;
  win_count: number;
  loss_count: number;
  win_rate_pct: number;
  avg_cost_drift_pct: number;
  avg_slippage_bps: number;
  max_drawdown_pct: number;
  kill_switch_count: number;
  go_no_go: 'GO' | 'NO_GO' | 'INSUFFICIENT_DATA';
  failing_criteria: string[];
}

@Injectable()
export class SandboxValidationService {
  private readonly logger = new Logger(SandboxValidationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly wizard: LiveTradingWizardService,
  ) {}

  @Cron('0 0 4 * * *', { name: 'sandbox-validation' })
  async runSandboxValidationCron(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[sandbox-validation] failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runInner(): Promise<void> {
    const { data: states } = await this.supabase
      .getClient()
      .from('live_trading_setup_state')
      .select('user_id, portfolio_id, current_step, status, autonomy_mandate_id')
      .eq('status', 'sandbox_running');

    if (!states || states.length === 0) return;

    this.logger.log(`[sandbox-validation] checking ${states.length} sandbox(s)`);

    for (const s of states) {
      await this.validateOne(
        s.user_id as string,
        s.portfolio_id as string,
      ).catch((e) => {
        this.logger.warn(
          `[sandbox-validation] portfolio ${s.portfolio_id.slice(0, 8)} failed: ${String(e).slice(0, 100)}`,
        );
      });
    }
  }

  /**
   * Calcule les métriques + decide passe/fail/wait.
   */
  async validateOne(userId: string, portfolioId: string): Promise<ValidationMetrics> {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();

    // Trades sur 14 derniers jours
    const { data: trades } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('status, realized_pnl_usd, realized_pnl_pct, estimated_entry_cost_usd, actual_entry_fees_usd, actual_exit_fees_usd, actual_entry_slippage_bps, actual_exit_slippage_bps, exit_timestamp')
      .eq('portfolio_id', portfolioId)
      .neq('status', 'open')
      .gte('exit_timestamp', since);

    const tpCount = (trades ?? []).filter((t) => t.status === 'closed_target').length;
    const slCount = (trades ?? []).filter((t) => t.status === 'closed_stop').length;
    const totalReal = tpCount + slCount;

    // Critère 1 : ≥ 30 trades
    if (totalReal < 30) {
      this.logger.debug(
        `[sandbox-validation] portfolio ${portfolioId.slice(0, 8)}: only ${totalReal} trades < 30, waiting`,
      );
      return {
        total_trades: totalReal,
        win_count: tpCount,
        loss_count: slCount,
        win_rate_pct: 0,
        avg_cost_drift_pct: 0,
        avg_slippage_bps: 0,
        max_drawdown_pct: 0,
        kill_switch_count: 0,
        go_no_go: 'INSUFFICIENT_DATA',
        failing_criteria: [`only ${totalReal} trades, need ≥ 30`],
      };
    }

    // Critère 2 : win rate ≥ 55%
    const winRate = (tpCount / totalReal) * 100;

    // Critère 3 : avg cost drift
    const tradesWithActualFees = (trades ?? []).filter(
      (t) => t.actual_entry_fees_usd != null && t.estimated_entry_cost_usd != null,
    );
    const avgCostDrift = tradesWithActualFees.length > 0
      ? avg(tradesWithActualFees.map((t) => {
          const actual = parseFloat(String(t.actual_entry_fees_usd ?? 0))
            + parseFloat(String(t.actual_exit_fees_usd ?? 0));
          const theoretical = parseFloat(String(t.estimated_entry_cost_usd ?? 0));
          return theoretical > 0 ? Math.abs((actual - theoretical) / theoretical) * 100 : 0;
        }))
      : 0;

    // Critère 4 : avg slippage absolu
    const slippages = (trades ?? [])
      .map((t) => Math.abs(Number(t.actual_entry_slippage_bps ?? 0)) + Math.abs(Number(t.actual_exit_slippage_bps ?? 0)))
      .filter((s) => s > 0);
    const avgSlippage = slippages.length > 0 ? avg(slippages) : 0;

    // Critère 5 : max drawdown (approx from realized_pnl_pct)
    const drawdowns = (trades ?? [])
      .map((t) => Math.abs(parseFloat(String(t.realized_pnl_pct ?? 0))))
      .filter((d) => d > 0);
    const maxDrawdown = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;

    // Critère 6 : kill_switch events
    const { count: ksCount } = await this.supabase
      .getClient()
      .from('lisa_decision_log')
      .select('*', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'kill_switch_activated')
      .gte('timestamp', since);

    const failing: string[] = [];
    if (winRate < 55) failing.push(`win_rate ${winRate.toFixed(1)}% < 55%`);
    if (avgCostDrift > 15) failing.push(`cost_drift ${avgCostDrift.toFixed(1)}% > 15%`);
    if (avgSlippage > 30) failing.push(`slippage ${avgSlippage.toFixed(0)}bps > 30`);
    if (maxDrawdown > 5) failing.push(`max_drawdown ${maxDrawdown.toFixed(1)}% > 5%`);
    if ((ksCount ?? 0) > 0) failing.push(`kill_switch fired ${ksCount} times`);

    const metrics: ValidationMetrics = {
      total_trades: totalReal,
      win_count: tpCount,
      loss_count: slCount,
      win_rate_pct: Math.round(winRate * 10) / 10,
      avg_cost_drift_pct: Math.round(avgCostDrift * 10) / 10,
      avg_slippage_bps: Math.round(avgSlippage),
      max_drawdown_pct: Math.round(maxDrawdown * 10) / 10,
      kill_switch_count: ksCount ?? 0,
      go_no_go: failing.length === 0 ? 'GO' : 'NO_GO',
      failing_criteria: failing,
    };

    this.logger.log(
      `[sandbox-validation] portfolio ${portfolioId.slice(0, 8)}: ` +
      `${metrics.go_no_go} (${totalReal} trades, ${winRate.toFixed(1)}% wr, ${avgCostDrift.toFixed(1)}% drift, ${failing.length} failing)`,
    );

    if (metrics.go_no_go === 'GO') {
      await this.wizard.forceStep4Result(userId, portfolioId, 'passed', metrics as unknown as Record<string, unknown>);
    } else {
      await this.wizard.forceStep4Result(userId, portfolioId, 'failed', metrics as unknown as Record<string, unknown>);
    }

    return metrics;
  }
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}
