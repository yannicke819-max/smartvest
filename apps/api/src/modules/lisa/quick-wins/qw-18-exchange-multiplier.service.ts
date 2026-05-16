import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#18 — Asia exchange multiplier + .KQ score gate.
 *
 * .SHE × 1.5 sizing boost (Shanghai/Shenzhen sont les plus persistents).
 * .KQ × 0.7 sizing cut, ET skip si score < QW_18_KQ_SCORE_MIN (Règle B).
 *
 * S'applique uniquement à asset_class = 'asia_equity'.
 */

interface ExchangeRule {
  suffix: string;
  multiplier: number;
  scoreMinForTrade: number | null;
}

@Injectable()
export class Qw18ExchangeMultiplierService {
  private readonly rules: ExchangeRule[];
  private readonly kqScoreMin: number;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    this.kqScoreMin = Number.parseFloat(this.config.get<string>('QW_18_KQ_SCORE_MIN') ?? '1.2');

    const raw = this.config.get<string>('QW_18_EXCHANGE_MULT') ?? '.SHE:1.5,.KQ:0.7';
    this.rules = raw
      .split(',')
      .map((pair) => {
        const [suffix, multStr] = pair.split(':').map((s) => s.trim());
        const mult = Number.parseFloat(multStr);
        if (!suffix || !Number.isFinite(mult)) return null;
        return {
          suffix,
          multiplier: mult,
          scoreMinForTrade: suffix === '.KQ' ? this.kqScoreMin : null,
        } satisfies ExchangeRule;
      })
      .filter((r): r is ExchangeRule => r !== null);
  }

  check(signal: QwSignal): QwTrace {
    if (signal.assetClass !== 'asia_equity') {
      return { qwId: 'QW_18', decision: 'pass', reason: 'not_asia_class' };
    }

    const symbolUpper = signal.symbol.toUpperCase();
    const rule = this.rules.find((r) => symbolUpper.endsWith(r.suffix.toUpperCase()));
    if (!rule) {
      return { qwId: 'QW_18', decision: 'pass', reason: 'no_rule_for_suffix' };
    }

    if (rule.scoreMinForTrade !== null) {
      const score = signal.score ?? null;
      if (score === null || score < rule.scoreMinForTrade) {
        this.decisionLogger.log({
          qwId: 'QW_18',
          symbol: signal.symbol,
          assetClass: signal.assetClass,
          decision: 'block',
          reason: 'kq_score_below_min',
          wouldHavePassedWithoutFlag: true,
          details: { score, kqScoreMin: rule.scoreMinForTrade, suffix: rule.suffix },
        });
        return { qwId: 'QW_18', decision: 'block', reason: 'kq_score_below_min' };
      }
    }

    const reason = `exchange_mult_${rule.suffix}_x${rule.multiplier}`;
    this.decisionLogger.log({
      qwId: 'QW_18',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'modify',
      reason,
      wouldHavePassedWithoutFlag: true,
      details: { suffix: rule.suffix, multiplier: rule.multiplier, score: signal.score ?? null },
    });

    return {
      qwId: 'QW_18',
      decision: 'modify',
      reason,
      multiplier: rule.multiplier,
      exchange: rule.suffix,
    };
  }
}
