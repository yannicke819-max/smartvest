import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';

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
    private readonly decisionLog: DecisionLogService,
  ) {}

  /** Tick toutes les 60 secondes. Chaque portfolio a son propre cycle_minutes
   *  (min 1 min) qui détermine s'il est dû — permet aux users en hyper-trading
   *  de tourner toutes les 1-2 min alors que les longs-termistes restent à 60. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'lisa-autopilot' })
  async runAutopilotCycle() {
    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id, profile, autopilot_cycle_minutes, autopilot_auto_approve, autopilot_expires_at, kill_switch_active, updated_at')
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
        // Auto-expire le mode auto_approve si deadline dépassée
        const autoApprove = cfg.autopilot_auto_approve === true;
        const expiresAt = cfg.autopilot_expires_at as string | null;
        const expired = autoApprove && !!expiresAt && new Date(expiresAt).getTime() <= Date.now();
        if (expired) {
          this.logger.log(`Portfolio ${String(cfg.portfolio_id)}: auto_approve EXPIRÉ — désactivation`);
          await this.supabase.getClient()
            .from('lisa_session_configs')
            .update({ autopilot_auto_approve: false, autopilot_expires_at: null })
            .eq('portfolio_id', cfg.portfolio_id as string);
          await this.decisionLog.append({
            portfolioId: cfg.portfolio_id as string,
            kind: 'autopilot_auto_approve_expired',
            summary: 'Mode auto-approve expiré — désactivation automatique',
            rationale: `Deadline ${expiresAt} dépassée`,
            payload: {},
            triggeredBy: 'autopilot_cron',
          }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
        }

        await this.runPortfolioCycle(
          cfg.user_id as string,
          cfg.portfolio_id as string,
          (cfg.autopilot_cycle_minutes as number) ?? 60,
          autoApprove && !expired,
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
    autoApprove: boolean = false,
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
    await this.decisionLog.append({
      portfolioId,
      kind: 'autopilot_cycle_started',
      summary: 'Autopilot cycle started',
      rationale: `Interval ${cycleMinutes}min elapsed since last cycle`,
      payload: {},
      triggeredBy: 'autopilot_cron',
    }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));

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
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed (new proposals paused — critical drawdown)',
        rationale: riskResult.violations.map((v) => v.message).join(' | '),
        payload: { riskStatus: riskResult.status },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
      return;
    }

    // 6. OK path : generate new proposal + optionally auto-approve (simulation only)
    try {
      const proposal = await this.lisa.generateProposal(
        userId,
        portfolioId,
        autoApprove
          ? 'Autopilot agressif (simulation) — scan EV+ multi-asset, turnover élevé, coupure sèche des positions défavorables'
          : 'Autopilot cycle — scan pour opportunities intraday multi-asset',
      );

      let autoApproveResult: { openedPositions: number } | null = null;
      if (autoApprove && proposal.theses.length > 0) {
        // Safety net : un dernier check que le portfolio est bien is_simulation
        // (le LisaService a déjà vérifié mais on ne laisse rien passer).
        const { data: portfolio } = await this.supabase.getClient()
          .from('portfolios')
          .select('is_simulation')
          .eq('id', portfolioId)
          .maybeSingle();

        if (portfolio?.is_simulation !== true) {
          this.logger.error(`Portfolio ${portfolioId} n'est PAS is_simulation — auto_approve REFUSÉ`);
        } else {
          try {
            const result = await this.lisa.approveProposal(userId, proposal.id);
            autoApproveResult = { openedPositions: result.openedPositions.length };
            this.logger.log(`Autopilot auto-approved proposal ${proposal.id}: ${result.openedPositions.length} position(s) opened`);
          } catch (e) {
            this.logger.error(`Auto-approve failed for ${proposal.id}: ${String(e)}`);
          }
        }
      }

      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: autoApproveResult
          ? `Cycle completed: ${proposal.theses.length} theses, ${autoApproveResult.openedPositions} positions auto-ouvertes`
          : `Cycle completed: proposal generated (${proposal.theses.length} theses)`,
        rationale: proposal.regimeSummary,
        payload: {
          proposalId: proposal.id,
          regime: proposal.detectedRegime,
          thesesCount: proposal.theses.length,
          riskStatus: riskResult.status,
          autoApproved: autoApproveResult !== null,
          openedPositions: autoApproveResult?.openedPositions ?? 0,
        },
        triggeredBy: 'autopilot_cron',
      }).catch((e) => this.logger.warn(`log append failed: ${String(e)}`));
    } catch (e) {
      this.logger.error(`Proposal generation in autopilot failed: ${String(e)}`);
      await this.decisionLog.append({
        portfolioId,
        kind: 'autopilot_cycle_completed',
        summary: 'Cycle completed with error',
        rationale: String(e).slice(0, 2000),
        payload: {},
        triggeredBy: 'autopilot_cron',
      }).catch((err) => this.logger.warn(`log append failed: ${String(err)}`));
    }
  }

  /**
   * Risk monitor rapide : tourne toutes les 60 secondes, INDÉPENDAMMENT du
   * cycle Claude (qui peut être à 5 ou 15 min). Vérifie stops / targets /
   * horizons sur toutes les positions ouvertes des portefeuilles en autopilot.
   *
   * Permet de fermer une perdante en moins d'1 min même si le prochain cycle
   * Claude n'est que dans 14 min. Critique pour la réactivité en mode sniper.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'lisa-fast-risk-monitor' })
  async runFastRiskMonitor() {
    const { data: configs, error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error || !configs || configs.length === 0) return;

    for (const cfg of configs) {
      try {
        await this.lisa.runRiskCheck(cfg.user_id as string, cfg.portfolio_id as string);
      } catch (e) {
        this.logger.debug(`fast risk monitor skipped for ${String(cfg.portfolio_id)}: ${String(e).slice(0, 80)}`);
      }
    }
  }
}
