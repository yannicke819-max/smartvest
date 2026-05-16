import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#47 — Skip .LSE pending audit post-R5.
 *
 * Data 30j : .LSE 25 positions, WR 44 %, PnL -$1503, sl_avg -12.92 %
 * (concentré sur 1 outlier SEE.LSE -$1574 = bug R5 — exit_price 0).
 *
 * À réévaluer 5j post-hotfix R5 : si l'outlier ne se répète pas,
 * le gain réel attribué à QW#47 chute < $50/j et on relâche le filtre.
 *
 * Env var : QW47_LSE_SKIP_ENABLED (default true).
 */
@Injectable()
export class Qw47LseSkipService {
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    this.enabled = (this.config.get<string>('QW47_LSE_SKIP_ENABLED') ?? 'true') === 'true';
  }

  check(signal: QwSignal): QwTrace {
    if (!this.enabled) {
      return { qwId: 'QW_47', decision: 'pass', reason: 'flag_disabled' };
    }
    if (!signal.symbol.toUpperCase().endsWith('.LSE')) {
      return { qwId: 'QW_47', decision: 'pass', reason: 'not_lse_suffix' };
    }

    this.decisionLogger.log({
      qwId: 'QW_47',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'lse_blacklisted_pending_audit',
      wouldHavePassedWithoutFlag: true,
      details: { suffix: '.LSE' },
    });
    return { qwId: 'QW_47', decision: 'block', reason: 'lse_blacklisted_pending_audit' };
  }
}
