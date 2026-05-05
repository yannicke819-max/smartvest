/**
 * PR #243 — GainersAdaptiveSelectivityService.
 *
 * Cron 5 min : ajuste dynamiquement les seuils du scanner Gainers selon
 * trajectory_status calculé sur 7 jours glissants.
 *
 * Spec utilisateur (05/05/2026 14:30 UTC) :
 *   - DANS_LE_PLAN  (80%-110% cible) : restore user values + adaptive_active=false
 *   - EN_AVANCE     (>110% cible)    : NO-OP (préserve le cap user)
 *   - EN_RETARD     (<80% cible)     : assouplit
 *       persistence_score   −0.05 (floor 0.50)
 *       path_efficiency     −0.05 (floor 0.30)
 *       max_per_cycle       +1    (ceiling 10)
 *       cooldown_minutes    ÷2    (floor 5)
 *   - HORS_TRAJECTOIRE (réalisé négatif) : autopilot_enabled=false + alarm
 *
 * Snapshot pattern : à la transition vers EN_RETARD, on snapshot les valeurs
 * user actuelles dans `gainers_adaptive_snapshot_*` AVANT d'assouplir. Au
 * retour DANS_LE_PLAN, on restore depuis snapshot.
 *
 * Garde-fous :
 *   - Opt-in : `gainers_adaptive_enabled = true` requis
 *   - Brackets ADR-005 : floors/ceilings non négociables
 *   - Cap mouvement par cycle : −0.05 / +1 / ÷2 (linéaire, pas cumulatif
 *     sans reset car user a explicitement demandé "pas de reset 00:00 UTC")
 *   - Fonction pure `computeAdjustment()` exposée pour tests
 *
 * Réutilise la logique trajectory_status de LisaService (110%/80% seuils
 * existants, alignés avec mode INVESTMENT/HARVEST).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { GainersInsightsService } from '../insights/gainers-insights.service';

const FLOOR_PERSISTENCE = 0.50;
const FLOOR_PATH_EFF = 0.30;
const CEILING_MAX_PER_CYCLE = 10;
const FLOOR_COOLDOWN_MIN = 5;
const ADJUSTMENT_PERSISTENCE_DELTA = 0.05;
const ADJUSTMENT_PATH_EFF_DELTA = 0.05;
const ADJUSTMENT_MAX_PER_CYCLE_DELTA = 1;
const COOLDOWN_DIVISOR = 2;

type TrajectoryStatus = 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE';

export interface AdaptiveContext {
  // Config user actuelle (effective ou snapshot selon adaptive_active)
  current_persistence: number;
  current_path_eff: number;
  current_max_per_cycle: number;
  current_cooldown: number;
  // Snapshot user values (si adaptive_active=true, sinon null)
  snapshot_persistence: number | null;
  snapshot_path_eff: number | null;
  snapshot_max_per_cycle: number | null;
  snapshot_cooldown: number | null;
  adaptive_active: boolean;
}

export interface AdaptiveDecision {
  action: 'no_op' | 'adjust' | 'restore' | 'kill_switch';
  reason: string;
  // Nouveaux values à écrire (null = ne pas modifier)
  next_persistence?: number;
  next_path_eff?: number;
  next_max_per_cycle?: number;
  next_cooldown?: number;
  next_adaptive_active?: boolean;
  next_autopilot_enabled?: boolean;
  // Snapshot à écrire si transition vers EN_RETARD
  next_snapshot_persistence?: number | null;
  next_snapshot_path_eff?: number | null;
  next_snapshot_max_per_cycle?: number | null;
  next_snapshot_cooldown?: number | null;
}

interface PortfolioConfig {
  portfolio_id: string;
  user_id: string;
  gainers_min_persistence_score: number | null;
  gainers_min_path_efficiency: number | null;
  gainers_max_per_cycle: number | null;
  gainers_cooldown_minutes: number | null;
  gainers_adaptive_active: boolean | null;
  gainers_adaptive_snapshot_persistence: number | null;
  gainers_adaptive_snapshot_path_eff: number | null;
  gainers_adaptive_snapshot_max_per_cycle: number | null;
  gainers_adaptive_snapshot_cooldown: number | null;
  gainers_trajectory_status: string | null;
  return_target_daily_pct: number | null;
  return_target_monthly_pct: number | null;
  return_target_annual_pct: number | null;
  capital_usd: string | number | null;
}

@Injectable()
export class GainersAdaptiveSelectivityService {
  private readonly logger = new Logger(GainersAdaptiveSelectivityService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly insights: GainersInsightsService,
  ) {}

  /** Cron 5 min strict UTC. */
  @Cron('*/5 * * * *', { timeZone: 'UTC' })
  async runAdaptiveCycle(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[adaptive] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runInner(): Promise<void> {
    const portfolios = await this.loadEnabledPortfolios();
    if (portfolios.length === 0) {
      this.logger.debug('[adaptive] no portfolio with gainers_adaptive_enabled=true');
      return;
    }

    let applied = 0;
    let skipped = 0;

    for (const cfg of portfolios) {
      try {
        const status = await this.computeStatus(cfg);
        if (!status) {
          skipped++;
          continue;
        }

        const ctx: AdaptiveContext = this.buildContext(cfg);
        const decision = this.computeAdjustment(status, ctx);

        if (decision.action !== 'no_op') {
          await this.applyDecision(cfg, status, decision);
          applied++;
        } else {
          // Update only the trajectory_status fields (visibility UI)
          await this.updateStatusOnly(cfg.portfolio_id, status);
          skipped++;
        }
      } catch (e) {
        this.logger.warn(
          `[adaptive] portfolio ${cfg.portfolio_id.slice(0, 8)}: ${String(e).slice(0, 100)}`,
        );
      }
    }

    this.logger.log(`[adaptive] cycle complete: applied=${applied} skipped=${skipped} portfolios=${portfolios.length}`);
  }

  /**
   * Pure logic — exposée pour tests. Décide quoi faire selon le status courant
   * et le contexte (snapshot/active state).
   *
   * Règles :
   *   - EN_AVANCE                  → no_op (preserve cap user)
   *   - DANS_LE_PLAN + active      → restore user values from snapshot
   *   - DANS_LE_PLAN + not active  → no_op
   *   - EN_RETARD                  → adjust (snapshot d'abord si first transition)
   *   - HORS_TRAJECTOIRE           → kill_switch (autopilot=false)
   */
  computeAdjustment(status: TrajectoryStatus, ctx: AdaptiveContext): AdaptiveDecision {
    if (status === 'EN_AVANCE') {
      return { action: 'no_op', reason: 'EN_AVANCE — preserve user cap (no-op)' };
    }

    if (status === 'HORS_TRAJECTOIRE') {
      return {
        action: 'kill_switch',
        reason: 'HORS_TRAJECTOIRE — autopilot disabled, alarm UI',
        next_autopilot_enabled: false,
        // Restore snapshot si on était EN_RETARD avant
        ...(ctx.adaptive_active ? this.buildRestorePartial(ctx) : {}),
        next_adaptive_active: false,
      };
    }

    if (status === 'DANS_LE_PLAN') {
      if (!ctx.adaptive_active) {
        return { action: 'no_op', reason: 'DANS_LE_PLAN + not active — preserve user' };
      }
      // Restore from snapshot
      return {
        action: 'restore',
        reason: 'DANS_LE_PLAN return — restore user snapshot',
        ...this.buildRestorePartial(ctx),
        next_adaptive_active: false,
      };
    }

    // status === 'EN_RETARD'
    const isFirstTransition = !ctx.adaptive_active;

    // Compute new values with brackets
    const nextPersistence = Math.max(
      FLOOR_PERSISTENCE,
      ctx.current_persistence - ADJUSTMENT_PERSISTENCE_DELTA,
    );
    const nextPathEff = Math.max(
      FLOOR_PATH_EFF,
      ctx.current_path_eff - ADJUSTMENT_PATH_EFF_DELTA,
    );
    const nextMaxPerCycle = Math.min(
      CEILING_MAX_PER_CYCLE,
      ctx.current_max_per_cycle + ADJUSTMENT_MAX_PER_CYCLE_DELTA,
    );
    const nextCooldown = Math.max(
      FLOOR_COOLDOWN_MIN,
      Math.floor(ctx.current_cooldown / COOLDOWN_DIVISOR),
    );

    // Skip if all values already at floor (further adjustments useless)
    const allAtFloor =
      nextPersistence === ctx.current_persistence
      && nextPathEff === ctx.current_path_eff
      && nextMaxPerCycle === ctx.current_max_per_cycle
      && nextCooldown === ctx.current_cooldown;

    if (allAtFloor) {
      return {
        action: 'no_op',
        reason: 'EN_RETARD but all gates at floor — cannot adjust further',
      };
    }

    return {
      action: 'adjust',
      reason: `EN_RETARD ${isFirstTransition ? 'first transition' : 'continued'} — assouplit gates`,
      next_persistence: nextPersistence,
      next_path_eff: nextPathEff,
      next_max_per_cycle: nextMaxPerCycle,
      next_cooldown: nextCooldown,
      next_adaptive_active: true,
      // Snapshot only on first transition (preserve original user values)
      ...(isFirstTransition
        ? {
            next_snapshot_persistence: ctx.current_persistence,
            next_snapshot_path_eff: ctx.current_path_eff,
            next_snapshot_max_per_cycle: ctx.current_max_per_cycle,
            next_snapshot_cooldown: ctx.current_cooldown,
          }
        : {}),
    };
  }

  private buildRestorePartial(ctx: AdaptiveContext): Partial<AdaptiveDecision> {
    return {
      next_persistence: ctx.snapshot_persistence ?? ctx.current_persistence,
      next_path_eff: ctx.snapshot_path_eff ?? ctx.current_path_eff,
      next_max_per_cycle: ctx.snapshot_max_per_cycle ?? ctx.current_max_per_cycle,
      next_cooldown: ctx.snapshot_cooldown ?? ctx.current_cooldown,
      next_snapshot_persistence: null,
      next_snapshot_path_eff: null,
      next_snapshot_max_per_cycle: null,
      next_snapshot_cooldown: null,
    };
  }

  private buildContext(cfg: PortfolioConfig): AdaptiveContext {
    return {
      current_persistence: Number(cfg.gainers_min_persistence_score ?? 0.67),
      current_path_eff: Number(cfg.gainers_min_path_efficiency ?? 0.5),
      current_max_per_cycle: Number(cfg.gainers_max_per_cycle ?? 3),
      current_cooldown: Number(cfg.gainers_cooldown_minutes ?? 30),
      snapshot_persistence: cfg.gainers_adaptive_snapshot_persistence != null
        ? Number(cfg.gainers_adaptive_snapshot_persistence) : null,
      snapshot_path_eff: cfg.gainers_adaptive_snapshot_path_eff != null
        ? Number(cfg.gainers_adaptive_snapshot_path_eff) : null,
      snapshot_max_per_cycle: cfg.gainers_adaptive_snapshot_max_per_cycle,
      snapshot_cooldown: cfg.gainers_adaptive_snapshot_cooldown,
      adaptive_active: cfg.gainers_adaptive_active === true,
    };
  }

  /**
   * Compute trajectory_status — réplique de LisaService.computeTrajectoryStatus
   * pour ne pas créer de dépendance circulaire. Seuils : 80% / 110%.
   */
  private async computeStatus(cfg: PortfolioConfig): Promise<TrajectoryStatus | null> {
    // Target per day
    let targetPerDay: number | null = null;
    if (cfg.return_target_daily_pct != null) {
      targetPerDay = Number(cfg.return_target_daily_pct);
    } else if (cfg.return_target_monthly_pct != null) {
      targetPerDay = Number(cfg.return_target_monthly_pct) / 30;
    } else if (cfg.return_target_annual_pct != null) {
      targetPerDay = Number(cfg.return_target_annual_pct) / 365;
    }
    if (targetPerDay === null) {
      this.logger.debug(`[adaptive] ${cfg.portfolio_id.slice(0, 8)}: no return target set, skip`);
      return null;
    }

    // Realised 7d : sum closed trades pnl_usd / capital × 100
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data: closedTrades, error } = await this.supabase
      .getClient()
      .from('paper_trades')
      .select('pnl_usd')
      .eq('portfolio_id', cfg.portfolio_id)
      .eq('strategy', 'top_gainers_v1')
      .eq('status', 'closed')
      .gte('closed_at', sevenDaysAgo);
    if (error) {
      this.logger.warn(`[adaptive] fetch trades failed: ${error.message}`);
      return null;
    }
    const pnlSum = (closedTrades ?? []).reduce(
      (acc, row) => acc + (parseFloat(String(row.pnl_usd ?? '0')) || 0),
      0,
    );
    const capital = Number(cfg.capital_usd ?? 10000);
    if (capital <= 0) return null;
    const realisedPct = (pnlSum / capital) * 100;

    const targetExtrapolated = targetPerDay * 7;

    // Persiste pour UI
    await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update({
        gainers_realised_7d_pct: Number(realisedPct.toFixed(4)),
        gainers_target_7d_pct: Number(targetExtrapolated.toFixed(4)),
      })
      .eq('portfolio_id', cfg.portfolio_id);

    // Apply thresholds (aligned avec LisaService)
    if (realisedPct < -0.5) return 'HORS_TRAJECTOIRE';
    if (realisedPct >= targetExtrapolated * 1.1) return 'EN_AVANCE';
    if (realisedPct >= targetExtrapolated * 0.8) return 'DANS_LE_PLAN';
    return 'EN_RETARD';
  }

  private async loadEnabledPortfolios(): Promise<PortfolioConfig[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select(
        'portfolio_id, user_id, capital_usd, ' +
        'gainers_min_persistence_score, gainers_min_path_efficiency, ' +
        'gainers_max_per_cycle, gainers_cooldown_minutes, ' +
        'gainers_adaptive_active, gainers_adaptive_snapshot_persistence, ' +
        'gainers_adaptive_snapshot_path_eff, gainers_adaptive_snapshot_max_per_cycle, ' +
        'gainers_adaptive_snapshot_cooldown, gainers_trajectory_status, ' +
        'return_target_daily_pct, return_target_monthly_pct, return_target_annual_pct',
      )
      .eq('strategy_mode', 'gainers')
      .eq('gainers_adaptive_enabled', true);
    if (error) {
      this.logger.warn(`[adaptive] loadEnabledPortfolios: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as PortfolioConfig[];
  }

  private async applyDecision(
    cfg: PortfolioConfig,
    status: TrajectoryStatus,
    decision: AdaptiveDecision,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      gainers_trajectory_status: status,
      gainers_trajectory_status_at: new Date().toISOString(),
    };

    if (decision.next_persistence != null) update.gainers_min_persistence_score = decision.next_persistence;
    if (decision.next_path_eff != null) update.gainers_min_path_efficiency = decision.next_path_eff;
    if (decision.next_max_per_cycle != null) update.gainers_max_per_cycle = decision.next_max_per_cycle;
    if (decision.next_cooldown != null) update.gainers_cooldown_minutes = decision.next_cooldown;
    if (decision.next_adaptive_active != null) update.gainers_adaptive_active = decision.next_adaptive_active;
    if (decision.next_autopilot_enabled != null) update.autopilot_enabled = decision.next_autopilot_enabled;
    if ('next_snapshot_persistence' in decision) update.gainers_adaptive_snapshot_persistence = decision.next_snapshot_persistence;
    if ('next_snapshot_path_eff' in decision) update.gainers_adaptive_snapshot_path_eff = decision.next_snapshot_path_eff;
    if ('next_snapshot_max_per_cycle' in decision) update.gainers_adaptive_snapshot_max_per_cycle = decision.next_snapshot_max_per_cycle;
    if ('next_snapshot_cooldown' in decision) update.gainers_adaptive_snapshot_cooldown = decision.next_snapshot_cooldown;

    const { error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update(update)
      .eq('portfolio_id', cfg.portfolio_id);
    if (error) {
      this.logger.warn(`[adaptive] update failed: ${error.message}`);
      return;
    }

    // Map action → kind for decision_log
    const kindMap: Record<AdaptiveDecision['action'], string> = {
      no_op: 'adaptive_status_changed',
      adjust: 'adaptive_adjustment_applied',
      restore: 'adaptive_restore_applied',
      kill_switch: 'adaptive_kill_switch_triggered',
    };

    // Audit + insight
    await this.insights.logInsight({
      type: 'threshold_proposal',
      source: 'auto_threshold_tuner',
      severity: status === 'HORS_TRAJECTOIRE' ? 'critical' : 'medium',
      summary: `Adaptive ${decision.action}: ${status} — ${decision.reason}`,
      payload: {
        portfolio_id: cfg.portfolio_id,
        status,
        action: decision.action,
        decision,
        kind_logged: kindMap[decision.action],
      },
    }).catch(() => null);

    this.logger.log(
      `[adaptive] ${cfg.portfolio_id.slice(0, 8)} ${status} → ${decision.action}: ${decision.reason}`,
    );
  }

  private async updateStatusOnly(portfolioId: string, status: TrajectoryStatus): Promise<void> {
    await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update({
        gainers_trajectory_status: status,
        gainers_trajectory_status_at: new Date().toISOString(),
      })
      .eq('portfolio_id', portfolioId);
  }
}
