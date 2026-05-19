import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#8 — Boost sizing après un SL sur le même symbole.
 *
 * Idée : après un SL, si le scanner ré-émet un signal sur le même symbole
 * dans une fenêtre courte (~30 min), la probabilité de retournement est
 * statistiquement plus haute (mean-reversion court terme observée sur 14j
 * baseline). On boost le sizing pour capturer le rebond.
 *
 * Conservateur : multiplier 1.5× (pas 2× — Kelly ne supporte pas le full
 * doublement sur un signal sans confirmation orthogonale).
 *
 * Config :
 *  - QW_8_WINDOW_MIN       : fenêtre en minutes (default 30)
 *  - QW_8_MULTIPLIER       : multiplier (default 1.5)
 *  - QW_8_TARGET_CLASSES   : CSV (default 'us_equity_large,us_equity_small_mid,eu_equity')
 *
 * Implémentation : lookup Supabase `lisa_positions` même symbol /
 * portfolio, status='closed_stop', exit_timestamp >= NOW() - window.
 * Si match → decision='modify' avec multiplier.
 *
 * Fail-open : si Supabase pas prêt → pass (1.0× neutre).
 */
@Injectable()
export class Qw8BoostPostSlService {
  private readonly logger = new Logger(Qw8BoostPostSlService.name);
  private readonly windowMinutes: number;
  private readonly multiplier: number;
  private readonly targetClasses: Set<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const rawWindow = this.config.get<string>('QW_8_WINDOW_MIN') ?? '30';
    const parsedWindow = Number.parseInt(rawWindow, 10);
    this.windowMinutes = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 30;

    const rawMult = this.config.get<string>('QW_8_MULTIPLIER') ?? '1.5';
    const parsedMult = Number.parseFloat(rawMult);
    this.multiplier =
      Number.isFinite(parsedMult) && parsedMult >= 1.0 && parsedMult <= 3.0 ? parsedMult : 1.5;

    const classesRaw =
      this.config.get<string>('QW_8_TARGET_CLASSES') ??
      'us_equity_large,us_equity_small_mid,eu_equity';
    this.targetClasses = new Set(
      classesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  async check(signal: QwSignal): Promise<QwTrace> {
    if (!this.targetClasses.has(signal.assetClass)) {
      return { qwId: 'QW_8', decision: 'pass', reason: 'class_not_eligible' };
    }
    if (!signal.portfolioId) {
      return { qwId: 'QW_8', decision: 'pass', reason: 'no_portfolio_id' };
    }
    if (!this.supabase.isReady()) {
      return { qwId: 'QW_8', decision: 'pass', reason: 'supabase_not_ready' };
    }

    const cutoffIso = new Date(Date.now() - this.windowMinutes * 60_000).toISOString();

    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id, exit_timestamp')
        .eq('portfolio_id', signal.portfolioId)
        .eq('symbol', signal.symbol)
        .eq('status', 'closed_stop')
        .gte('exit_timestamp', cutoffIso)
        .order('exit_timestamp', { ascending: false })
        .limit(1);

      if (error) {
        this.logger.warn(`QW_8 query failed for ${signal.symbol}: ${error.message}`);
        return { qwId: 'QW_8', decision: 'pass', reason: 'db_error_fail_open' };
      }

      if (!data || data.length === 0) {
        return { qwId: 'QW_8', decision: 'pass', reason: 'no_recent_sl' };
      }

      const lastSlAt = data[0].exit_timestamp as string;
      this.decisionLogger.log({
        qwId: 'QW_8',
        symbol: signal.symbol,
        assetClass: signal.assetClass,
        decision: 'modify',
        reason: 'boost_post_sl',
        wouldHavePassedWithoutFlag: true,
        details: {
          windowMin: this.windowMinutes,
          multiplier: this.multiplier,
          lastSlAt,
          cutoffIso,
        },
      });

      return {
        qwId: 'QW_8',
        decision: 'modify',
        reason: 'boost_post_sl',
        multiplier: this.multiplier,
        details: { windowMin: this.windowMinutes, lastSlAt },
      };
    } catch (err) {
      this.logger.warn(`QW_8 exception for ${signal.symbol}: ${(err as Error).message}`);
      return { qwId: 'QW_8', decision: 'pass', reason: 'exception_fail_open' };
    }
  }
}
