import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#7 — Cooldown post-TP sur les classes US.
 *
 * Idée : après un TP sur us_equity_large ou us_equity_small_mid, le marché
 * revient souvent en mean-reversion → re-rentrer dans les ~60 min suivantes
 * sur le même symbole sous-performe. On bloque pendant la fenêtre cooldown.
 *
 * Config :
 *  - QW_7_COOLDOWN_MIN     : durée de la fenêtre en minutes (default 60)
 *  - QW_7_TARGET_CLASSES   : CSV des classes éligibles (default 'us_equity_large,us_equity_small_mid')
 *
 * Implémentation : lookup Supabase `lisa_positions` pour le portfolio courant,
 * symbol identique, status='closed_target', exit_timestamp >= NOW() - cooldown.
 * Si au moins 1 ligne → block.
 *
 * Fail-open : si Supabase pas prêt ou requête échoue → pass (on ne bloque
 * pas le trading sur une erreur infra).
 */
@Injectable()
export class Qw7CooldownPostTpUsService {
  private readonly logger = new Logger(Qw7CooldownPostTpUsService.name);
  private readonly cooldownMinutes: number;
  private readonly targetClasses: Set<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = this.config.get<string>('QW_7_COOLDOWN_MIN') ?? '60';
    const parsed = Number.parseInt(raw, 10);
    this.cooldownMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;

    const classesRaw =
      this.config.get<string>('QW_7_TARGET_CLASSES') ?? 'us_equity_large,us_equity_small_mid';
    this.targetClasses = new Set(
      classesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  async check(signal: QwSignal): Promise<QwTrace> {
    if (!this.targetClasses.has(signal.assetClass)) {
      return { qwId: 'QW_7', decision: 'pass', reason: 'class_not_eligible' };
    }
    if (!signal.portfolioId) {
      return { qwId: 'QW_7', decision: 'pass', reason: 'no_portfolio_id' };
    }
    if (!this.supabase.isReady()) {
      return { qwId: 'QW_7', decision: 'pass', reason: 'supabase_not_ready' };
    }

    const cutoffIso = new Date(Date.now() - this.cooldownMinutes * 60_000).toISOString();

    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id, exit_timestamp')
        .eq('portfolio_id', signal.portfolioId)
        .eq('symbol', signal.symbol)
        .eq('status', 'closed_target')
        .gte('exit_timestamp', cutoffIso)
        .limit(1);

      if (error) {
        this.logger.warn(`QW_7 query failed for ${signal.symbol}: ${error.message}`);
        return { qwId: 'QW_7', decision: 'pass', reason: 'db_error_fail_open' };
      }

      if (!data || data.length === 0) {
        return { qwId: 'QW_7', decision: 'pass', reason: 'no_recent_tp' };
      }

      const lastTpAt = data[0].exit_timestamp as string;
      this.decisionLogger.log({
        qwId: 'QW_7',
        symbol: signal.symbol,
        assetClass: signal.assetClass,
        decision: 'block',
        reason: 'cooldown_post_tp_active',
        wouldHavePassedWithoutFlag: true,
        details: { cooldownMin: this.cooldownMinutes, lastTpAt, cutoffIso },
      });

      return {
        qwId: 'QW_7',
        decision: 'block',
        reason: 'cooldown_post_tp_active',
        details: { cooldownMin: this.cooldownMinutes, lastTpAt },
      };
    } catch (err) {
      this.logger.warn(`QW_7 exception for ${signal.symbol}: ${(err as Error).message}`);
      return { qwId: 'QW_7', decision: 'pass', reason: 'exception_fail_open' };
    }
  }
}
