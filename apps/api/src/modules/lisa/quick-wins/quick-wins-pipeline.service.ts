import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Qw1SessionFilterService } from './qw-1-session-filter.service';
import { Qw6SymbolBlacklistService } from './qw-6-symbol-blacklist.service';
import { Qw11AssetClassGateService } from './qw-11-asset-class-gate.service';
import { Qw17RepeatSymbolCapService } from './qw-17-repeat-symbol-cap.service';
import { Qw18ExchangeMultiplierService } from './qw-18-exchange-multiplier.service';
import type { QwId, QwResult, QwSignal, QwTrace } from './types';

/**
 * Phase 5 N1 PR-1 — orchestrateur Quick Wins.
 *
 * Cascade ordre strict : QW#1 → QW#6 → QW#11 → QW#17 → QW#18.
 * Short-circuit dès qu'un QW renvoie 'block'.
 * Master flag QUICK_WINS_PIPELINE_ENABLED (default 'false' tant que la draft PR
 * n'est pas mergée). Mardi matin l'agent flip à true en même temps que le merge.
 */
@Injectable()
export class QuickWinsPipelineService {
  private readonly logger = new Logger(QuickWinsPipelineService.name);
  private readonly masterEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly qw1: Qw1SessionFilterService,
    private readonly qw6: Qw6SymbolBlacklistService,
    private readonly qw11: Qw11AssetClassGateService,
    private readonly qw17: Qw17RepeatSymbolCapService,
    private readonly qw18: Qw18ExchangeMultiplierService,
  ) {
    this.masterEnabled = (this.config.get<string>('QUICK_WINS_PIPELINE_ENABLED') ?? 'false') === 'true';
    if (this.masterEnabled) {
      this.logger.log('Quick Wins pipeline ENABLED (master flag on)');
    }
  }

  isEnabled(): boolean {
    return this.masterEnabled;
  }

  async evaluate(signal: QwSignal): Promise<QwResult> {
    if (!this.masterEnabled) {
      return { decision: 'pass', sizingMultiplier: 1.0, modifications: [], qwTrace: [] };
    }

    const trace: QwTrace[] = [];
    let sizingMultiplier = 1.0;
    const modifications: string[] = [];

    const ordered = [
      () => Promise.resolve(this.qw1.check(signal)),
      () => Promise.resolve(this.qw6.check(signal)),
      () => Promise.resolve(this.qw11.check(signal)),
      () => this.qw17.check(signal),
      () => Promise.resolve(this.qw18.check(signal)),
    ];

    for (const step of ordered) {
      const result = await step();
      trace.push(result);

      if (result.decision === 'block') {
        return {
          decision: 'block',
          blockedBy: result.qwId as QwId,
          reason: result.reason,
          qwTrace: trace,
        };
      }

      if (result.decision === 'modify' && typeof result.multiplier === 'number') {
        sizingMultiplier *= result.multiplier;
        modifications.push(`${result.qwId} ${result.reason}`);
      }
    }

    if (modifications.length > 0) {
      return {
        decision: 'modify',
        sizingMultiplier,
        modifications,
        qwTrace: trace,
      };
    }

    return { decision: 'pass', sizingMultiplier: 1.0, modifications: [], qwTrace: trace };
  }
}
