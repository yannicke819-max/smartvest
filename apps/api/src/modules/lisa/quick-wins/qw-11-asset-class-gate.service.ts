import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#11 — Pause générique d'une asset class entière.
 *
 * Default : us_equity_small_mid (Kelly -39.7%, PnL -$12.25/j sur baseline 4j).
 * Override : env PAUSED_ASSET_CLASSES=class1,class2,...
 *
 * Rollback : retirer la classe de la CSV, hot-reload non requis (les rows
 * créés en pause expirent au prochain restart du service).
 */
@Injectable()
export class Qw11AssetClassGateService {
  private readonly pausedClasses: Set<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = this.config.get<string>('PAUSED_ASSET_CLASSES') ?? 'us_equity_small_mid';
    this.pausedClasses = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  check(signal: QwSignal): QwTrace {
    if (this.pausedClasses.size === 0) {
      return { qwId: 'QW_11', decision: 'pass', reason: 'no_paused_classes' };
    }

    if (!this.pausedClasses.has(signal.assetClass)) {
      return { qwId: 'QW_11', decision: 'pass', reason: 'class_not_paused' };
    }

    this.decisionLogger.log({
      qwId: 'QW_11',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'class_paused',
      wouldHavePassedWithoutFlag: true,
      details: { pausedClasses: Array.from(this.pausedClasses) },
    });

    return { qwId: 'QW_11', decision: 'block', reason: 'class_paused' };
  }
}
