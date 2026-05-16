import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#9 — Score floor recalibré par classe.
 *
 * Data 14j accept_score_under_1 :
 *   - us_equity_large : 56 % accepts < 1.0  → seuil 0.80 (trop strict à 1.0)
 *   - crypto_major    : 88 % accepts < 1.0  → seuil 0.65 (catastrophe à 1.0)
 *   - asia / eu / us_sm : 9-27 % accepts < 1.0 → seuil 0.95
 */

const ENV_BY_CLASS: Record<string, string> = {
  asia_equity: 'QW9_SCORE_MIN_ASIA',
  eu_equity: 'QW9_SCORE_MIN_EU',
  us_equity_large: 'QW9_SCORE_MIN_US_LARGE',
  us_equity_small_mid: 'QW9_SCORE_MIN_US_SM',
  crypto_major: 'QW9_SCORE_MIN_CRYPTO',
};

const DEFAULT_BY_CLASS: Record<string, number> = {
  asia_equity: 0.95,
  eu_equity: 0.95,
  us_equity_large: 0.8,
  us_equity_small_mid: 0.95,
  crypto_major: 0.65,
};

@Injectable()
export class Qw9ScoreFloorService {
  private readonly thresholds = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    for (const [cls, envKey] of Object.entries(ENV_BY_CLASS)) {
      const raw = this.config.get<string>(envKey);
      const parsed = raw != null ? Number.parseFloat(raw) : NaN;
      const value = Number.isFinite(parsed) ? parsed : DEFAULT_BY_CLASS[cls];
      this.thresholds.set(cls, value);
    }
  }

  check(signal: QwSignal): QwTrace {
    const floor = this.thresholds.get(signal.assetClass);
    if (floor === undefined) {
      return { qwId: 'QW_9', decision: 'pass', reason: 'no_floor_for_class' };
    }
    if (signal.score == null || !Number.isFinite(signal.score)) {
      return { qwId: 'QW_9', decision: 'pass', reason: 'score_unknown' };
    }
    if (signal.score >= floor) {
      return { qwId: 'QW_9', decision: 'pass', reason: `score_above_floor_${floor}` };
    }

    this.decisionLogger.log({
      qwId: 'QW_9',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'score_below_floor',
      wouldHavePassedWithoutFlag: true,
      details: { score: signal.score, floor },
    });
    return { qwId: 'QW_9', decision: 'block', reason: 'score_below_floor' };
  }
}
