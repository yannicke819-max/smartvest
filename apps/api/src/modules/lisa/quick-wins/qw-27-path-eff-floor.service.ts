import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#27 — Path efficiency floor par classe.
 *
 * Data 14j gains nets si floor :
 *   eu_equity        : 0.60 → +$1506
 *   us_equity_large  : 0.60 → +$152
 *   us_equity_small_mid : 0.60 → +$129
 *   crypto_major     : 0.60 → +$22
 *   asia_equity      : 0.30 (filtré naturellement à seuil bas)
 *
 * Si signal.pathEff absent → pass (caller mechanical-trading n'a pas la métrique
 * pour l'instant, intentionnel : no-op silencieux dans ce contexte).
 */

const ENV_BY_CLASS: Record<string, string> = {
  asia_equity: 'QW27_PATH_EFF_FLOOR_ASIA',
  eu_equity: 'QW27_PATH_EFF_FLOOR_EU',
  us_equity_large: 'QW27_PATH_EFF_FLOOR_US_LARGE',
  us_equity_small_mid: 'QW27_PATH_EFF_FLOOR_US_SM',
  crypto_major: 'QW27_PATH_EFF_FLOOR_CRYPTO',
};

const DEFAULT_BY_CLASS: Record<string, number> = {
  asia_equity: 0.3,
  eu_equity: 0.6,
  us_equity_large: 0.6,
  us_equity_small_mid: 0.6,
  crypto_major: 0.6,
};

@Injectable()
export class Qw27PathEffFloorService {
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
      return { qwId: 'QW_27', decision: 'pass', reason: 'no_floor_for_class' };
    }
    if (signal.pathEff == null || !Number.isFinite(signal.pathEff)) {
      return { qwId: 'QW_27', decision: 'pass', reason: 'path_eff_unknown' };
    }
    if (signal.pathEff >= floor) {
      return { qwId: 'QW_27', decision: 'pass', reason: `path_eff_above_floor_${floor}` };
    }

    this.decisionLogger.log({
      qwId: 'QW_27',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'path_eff_below_floor',
      wouldHavePassedWithoutFlag: true,
      details: { pathEff: signal.pathEff, floor },
    });
    return { qwId: 'QW_27', decision: 'block', reason: 'path_eff_below_floor' };
  }
}
