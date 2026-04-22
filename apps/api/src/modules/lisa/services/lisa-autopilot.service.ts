import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';

/**
 * LisaAutopilotService — Cron scheduler for portfolios with autopilot enabled.
 *
 * Tourne toutes les 5 minutes (configurable). Pour chaque portfolio simu
 * avec autopilot_enabled = true :
 *  1. Vérifie kill_switch_active → skip si true
 *  2. Vérifie cycle_minutes écoulé depuis le dernier cycle
 *  3. Run risk check (snapshot + drawdown + stops/targets/horizons)
 *  4. Si OK → génère nouvelle proposition (si profile warrant it)
 *  5. Log decision entry `autopilot_cycle_completed`
 *
 * RESPECT HARD LIMITS :
 *  - Si drawdown 2j > -10% → kill switch auto + skip
 *  - Si drawdown 7j > limit → pause nouvelles positions (warning)
 */
@Injectable()
export class LisaAutopilotService {
  private readonly logger = new Logger(LisaAutopilotService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
  ) {}

  /** Tourne toutes les 5 minutes. Les portfolios configurés pour plus
   *  d'intervalle sont skippés au check cycle_minutes. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'lisa-autopilot' })
  async runAutopilotCycle() {
    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id, profile, autopilot_cycle_minutes, kill_switch_active, updated_at')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error) {
      this.logger.error(`Autopilot cycle: failed to fetch configs: ${error.message}`);
      return;
    }

    if (!configs || configs.length === 0) return;

    this.logger.log(`Autopilot cycle: ${configs.length} portfolio(s) in autopilot mode`);

    for (const cfg of configs) {
      try {
        await this.runPortfolioCycle(
          cfg.user_id as string,
          cfg.portfolio_id as string,
          (cfg.autopilot_cycle_minutes as number) ?? 60,
        );
      } catch (e) {
        this.logger.error(
          `Autopilot cycle failed for portfolio ${String(cfg.portfolio_id)}: ${String(e)}`,
        );
      }
    }
  }

  private async runPortfolioCycle(
    userId: string,
    portfolioId: string,
    cycleMinutes: number,
  ): Promise<void> {
    // 1. Check when was last autopilot cycle (from decision log)
    const { data: lastCycle } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('timestamp')
      .eq('portfolio_id', portfolioId)
      .eq('kind', 'autopilot_cycle_completed')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastCycle) {
      const elapsedMs = Date.now() - new Date(lastCycle.timestamp as string).getTime();
      const requiredMs = cycleMinutes * 60_000;
      if (elapsedMs < requiredMs) return; // skip : not yet due
    }

    // 2. Log cycle start
    await this.supabase.getClient().from('lisa_decision_log').insert({
      portfolio_id: portfolioId,
      kind: 'autopilot_cycle_started',
      summary: 'Autopilot cycle started',
      rationale: `Interval ${cycleMinutes}min elapsed since last cycle`,
      payload: {},
      triggered_by: 'autopilot_cron',
      hash_chain_current: Math.random().toString(36).slice(2, 18),
    });

    // 3. Run risk check (hard kill if drawdown breached, close stops/targets)
    const riskResult = await this.lisa.runRiskCheck(userId, portfolioId).catch((e) => {
      this.logger.error(`Risk check failed: ${String(e)}`);
      return null;
    });

    if (!riskResult) return;

    // 4. If HARD KILL triggered, stop — already handled by risk monitor
    if (riskResult.status === 'hard_kill') {
      this.logger.warn(`Portfolio ${portfolioId}: HARD KILL triggered — skipping proposal generation`);
      return;
    }

    // 5. If critical drawdown, pause new proposals (user review forced)
    if (riskResult.status === 'critical') {
      this.logger.warn(`Portfolio ${portfolioId}: critical drawdown — pausing new proposals`);
      await this.supabase.getClient().from('lisa_decision_log').insert({
        portfolio_id: portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed (new proposals paused — critical drawdown)',
        rationale: riskResult.violations.map((v) => v.message).join(' | '),
        payload: { riskStatus: riskResult.status },
        triggered_by: 'autopilot_cron',
        hash_chain_current: Math.random().toString(36).slice(2, 18),
      });
      return;
    }

    // 6. OK path : generate new proposal (auto-proposed, user still approves
    //    or the mandate autonomy handles it — to evolve in P4.12)
    try {
      const proposal = await this.lisa.generateProposal(
        userId,
        portfolioId,
        'Autopilot cycle — scan pour opportunities intraday multi-asset',
      );

      await this.supabase.getClient().from('lisa_decision_log').insert({
        portfolio_id: portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: `Cycle completed: proposal generated (${proposal.theses.length} theses)`,
        rationale: proposal.regimeSummary,
        payload: {
          proposalId: proposal.id,
          regime: proposal.detectedRegime,
          thesesCount: proposal.theses.length,
          riskStatus: riskResult.status,
        },
        triggered_by: 'autopilot_cron',
        hash_chain_current: Math.random().toString(36).slice(2, 18),
      });
    } catch (e) {
      this.logger.error(`Proposal generation in autopilot failed: ${String(e)}`);
      await this.supabase.getClient().from('lisa_decision_log').insert({
        portfolio_id: portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed with error',
        rationale: String(e),
        payload: {},
        triggered_by: 'autopilot_cron',
        hash_chain_current: Math.random().toString(36).slice(2, 18),
      });
    }
  }
}
