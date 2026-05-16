import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR-3+PR-4 — Circuit breaker quotidien -$400.
 *
 * Calibration 30j : 2 déclenchements (14 mai -$2191, 15 mai -$502). 28 autres
 * jours OK → seuil acceptable, faux positifs très rares.
 *
 * Comportement :
 *   - isActive(portfolioId) : SELECT lisa_circuit_breaker_state WHERE resolved_at IS NULL
 *   - checkAndTrigger : compute pnl_jour Europe/Paris ; si < threshold → INSERT state
 *   - autoResetIfNewDay : UPDATE resolved_at quand le trigger date d'avant aujourd'hui Paris
 *
 * Intégration cascade : AVANT QW#46. Si actif → BLOCK toute nouvelle entrée.
 * Les positions déjà ouvertes ne sont PAS impactées (close paths inchangés).
 *
 * Auto-reset : cron @Cron('5 0 * * *', Europe/Paris) + check au boot via
 * autoResetIfNewDay (best-effort, ne lève jamais).
 */
@Injectable()
export class LisaCircuitBreakerService {
  private readonly logger = new Logger(LisaCircuitBreakerService.name);
  private readonly enabled: boolean;
  private readonly thresholdUsd: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('QW_CIRCUIT_BREAKER_ENABLED') ?? 'true') === 'true';
    const raw = this.config.get<string>('QW_CIRCUIT_BREAKER_THRESHOLD_USD') ?? '-400';
    const parsed = Number.parseFloat(raw);
    this.thresholdUsd = Number.isFinite(parsed) ? parsed : -400;
  }

  isFeatureEnabled(): boolean {
    return this.enabled;
  }

  async isActive(portfolioId: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (!this.supabase.isReady()) return false;
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_circuit_breaker_state')
        .select('id')
        .eq('portfolio_id', portfolioId)
        .is('resolved_at', null)
        .limit(1);
      if (error) {
        this.logger.warn(`circuit-breaker isActive query failed: ${error.message}`);
        return false;
      }
      return (data ?? []).length > 0;
    } catch (err) {
      this.logger.warn(`circuit-breaker isActive exception: ${(err as Error).message}`);
      return false;
    }
  }

  async checkAndTrigger(portfolioId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const pnlJour = await this.getPnlSinceMidnightParis(portfolioId);
    if (pnlJour === null) return false;
    if (pnlJour >= this.thresholdUsd) return false;

    if (await this.isActive(portfolioId)) {
      // Déjà déclenché aujourd'hui, no-op
      return true;
    }

    if (!this.supabase.isReady()) return false;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('lisa_circuit_breaker_state')
        .insert({
          portfolio_id: portfolioId,
          reason: 'daily_drawdown_400',
          pnl_at_trigger: pnlJour,
        });
      if (error) {
        this.logger.warn(`circuit-breaker insert failed: ${error.message}`);
        return false;
      }
      this.logger.warn(
        `[CIRCUIT_BREAKER] TRIGGERED portfolio=${portfolioId} pnl_jour=${pnlJour.toFixed(2)} threshold=${this.thresholdUsd}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(`circuit-breaker trigger exception: ${(err as Error).message}`);
      return false;
    }
  }

  async autoResetIfNewDay(portfolioId: string): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    const todayStartUtc = this.getParisDayStartIso(new Date().toISOString());
    if (todayStartUtc === null) return;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('lisa_circuit_breaker_state')
        .update({ resolved_at: new Date().toISOString(), resolved_by: 'auto_next_day' })
        .eq('portfolio_id', portfolioId)
        .is('resolved_at', null)
        .lt('triggered_at', todayStartUtc);
      if (error) {
        this.logger.warn(`circuit-breaker autoReset failed: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(`circuit-breaker autoReset exception: ${(err as Error).message}`);
    }
  }

  @Cron('5 0 * * *', { timeZone: 'Europe/Paris' })
  async cronResetAllOldTriggers(): Promise<void> {
    if (!this.enabled) return;
    if (!this.supabase.isReady()) return;
    const todayStartUtc = this.getParisDayStartIso(new Date().toISOString());
    if (todayStartUtc === null) return;
    try {
      const { error, count } = await this.supabase
        .getClient()
        .from('lisa_circuit_breaker_state')
        .update(
          { resolved_at: new Date().toISOString(), resolved_by: 'auto_next_day' },
          { count: 'exact' },
        )
        .is('resolved_at', null)
        .lt('triggered_at', todayStartUtc);
      if (error) {
        this.logger.warn(`circuit-breaker cron-reset failed: ${error.message}`);
        return;
      }
      this.logger.log(`circuit-breaker cron-reset : ${count ?? 0} state(s) cleared`);
    } catch (err) {
      this.logger.warn(`circuit-breaker cron-reset exception: ${(err as Error).message}`);
    }
  }

  /** P&L réalisé en USD depuis minuit Paris pour ce portfolio (somme realized_pnl_usd). */
  async getPnlSinceMidnightParis(portfolioId: string): Promise<number | null> {
    if (!this.supabase.isReady()) return null;
    const startIso = this.getParisDayStartIso(new Date().toISOString());
    if (startIso === null) return null;
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('realized_pnl_usd, status, exit_timestamp, updated_at')
        .eq('portfolio_id', portfolioId)
        .in('status', ['closed_target', 'closed_stop', 'closed_invalidated', 'closed_manual'])
        .gte('updated_at', startIso)
        .limit(2000);
      if (error) {
        this.logger.warn(`circuit-breaker pnl query failed: ${error.message}`);
        return null;
      }
      let sum = 0;
      for (const row of data ?? []) {
        const v = Number((row as { realized_pnl_usd: number | null }).realized_pnl_usd);
        if (Number.isFinite(v)) sum += v;
      }
      return sum;
    } catch (err) {
      this.logger.warn(`circuit-breaker pnl exception: ${(err as Error).message}`);
      return null;
    }
  }

  /** Début du jour Paris (DST-safe) en ISO UTC. */
  getParisDayStartIso(timestamp: string): string | null {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const parisDateStr = date.toLocaleString('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const localMidnight = new Date(`${parisDateStr}T00:00:00`);
    const utcEquivalent = new Date(
      localMidnight.toLocaleString('en-US', { timeZone: 'Europe/Paris' }),
    );
    const offsetMs = localMidnight.getTime() - utcEquivalent.getTime();
    return new Date(localMidnight.getTime() + offsetMs).toISOString();
  }
}
