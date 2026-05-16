import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#1 — Skip d'ouverture par classe sur fenêtre horaire UTC.
 *
 * Règle D (CLAUDE.md PR-1) : us_equity_large 14-16h UTC = skip absolu,
 * même le vendredi. eu_equity 8h UTC = skip SAUF le vendredi (8h15
 * vendredi reste autorisé — sizing boost à venir en PR-4).
 */

interface SessionRule {
  assetClass: string;
  skipHoursUtc: number[];
  fridayException?: 'eu_friday_pass';
}

const SESSION_RULES: SessionRule[] = [
  { assetClass: 'us_equity_large', skipHoursUtc: [14, 15] },
  { assetClass: 'us_equity_small_mid', skipHoursUtc: [17] },
  { assetClass: 'eu_equity', skipHoursUtc: [8], fridayException: 'eu_friday_pass' },
  { assetClass: 'asia_equity', skipHoursUtc: [1, 2] },
];

@Injectable()
export class Qw1SessionFilterService {
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    this.enabled = (this.config.get<string>('QW_1_SESSION_FILTER') ?? 'true') === 'true';
  }

  check(signal: QwSignal): QwTrace {
    if (!this.enabled) {
      return { qwId: 'QW_1', decision: 'pass', reason: 'flag_disabled' };
    }

    const date = new Date(signal.timestamp);
    if (Number.isNaN(date.getTime())) {
      return { qwId: 'QW_1', decision: 'pass', reason: 'invalid_timestamp' };
    }

    const hourUtc = date.getUTCHours();
    const dowUtc = date.getUTCDay();
    const rule = SESSION_RULES.find((r) => r.assetClass === signal.assetClass);

    if (!rule) {
      return { qwId: 'QW_1', decision: 'pass', reason: 'no_rule_for_class' };
    }

    if (!rule.skipHoursUtc.includes(hourUtc)) {
      return { qwId: 'QW_1', decision: 'pass', reason: 'outside_skip_window' };
    }

    if (rule.fridayException === 'eu_friday_pass' && dowUtc === 5) {
      return { qwId: 'QW_1', decision: 'pass', reason: 'eu_friday_exception' };
    }

    const reason = `session_skip_${rule.assetClass}_h${hourUtc}_utc`;
    this.decisionLogger.log({
      qwId: 'QW_1',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason,
      wouldHavePassedWithoutFlag: true,
      details: { hourUtc, dowUtc, skipHoursUtc: rule.skipHoursUtc },
    });

    return { qwId: 'QW_1', decision: 'block', reason };
  }
}
