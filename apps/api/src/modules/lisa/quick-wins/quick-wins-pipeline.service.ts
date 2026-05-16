import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LisaCircuitBreakerService } from '../services/circuit-breaker.service';
import { Qw1SessionFilterService } from './qw-1-session-filter.service';
import { Qw4RegimeFilterService } from './qw-4-regime-filter.service';
import { Qw6SymbolBlacklistService } from './qw-6-symbol-blacklist.service';
import { Qw9ScoreFloorService } from './qw-9-score-floor.service';
import { Qw11AssetClassGateService } from './qw-11-asset-class-gate.service';
import { Qw15FirstTradeBoostService } from './qw-15-first-trade-boost.service';
import { Qw17RepeatSymbolCapService } from './qw-17-repeat-symbol-cap.service';
import { Qw14aFridayEuBoostService } from './qw-14a-friday-eu-boost.service';
import { Qw18ExchangeMultiplierService } from './qw-18-exchange-multiplier.service';
import { Qw27PathEffFloorService } from './qw-27-path-eff-floor.service';
import { Qw46AsiaDowSkipService } from './qw-46-asia-dow-skip.service';
import { Qw47LseSkipService } from './qw-47-lse-skip.service';
import type { QwId, QwResult, QwSignal, QwTrace } from './types';

/**
 * Phase 5 N1 — orchestrateur Quick Wins (cascade unifiée PR-1 + PR-3+PR-4).
 *
 * Ordre exact (short-circuit dès qu'un check renvoie 'block') :
 *   0. CircuitBreaker (pre-cascade, requiert portfolioId)
 *   1. QW#46 asia Jeu/Ven
 *   2. QW#47 .LSE
 *   3. QW#1  session filter
 *   4. QW#6  symbol blacklist
 *   5. QW#11 asset class gate
 *   6. QW#9  score floor
 *   7. QW#27 path eff floor
 *   8. QW#4  régime asia (queries Supabase, cache 5min)
 *   9. QW#17 repeat cap
 *  10. QW#15 first trade boost (modify)
 *  11. QW#18 exchange multiplier (modify)
 *
 * Master flag QUICK_WINS_PIPELINE_ENABLED. Default 'false' jusqu'à validation
 * post-merge par l'agent (Perplexity Computer).
 */
@Injectable()
export class QuickWinsPipelineService {
  private readonly logger = new Logger(QuickWinsPipelineService.name);
  private readonly masterEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly circuitBreaker: LisaCircuitBreakerService,
    private readonly qw1: Qw1SessionFilterService,
    private readonly qw4: Qw4RegimeFilterService,
    private readonly qw6: Qw6SymbolBlacklistService,
    private readonly qw9: Qw9ScoreFloorService,
    private readonly qw11: Qw11AssetClassGateService,
    private readonly qw15: Qw15FirstTradeBoostService,
    private readonly qw17: Qw17RepeatSymbolCapService,
    private readonly qw18: Qw18ExchangeMultiplierService,
    private readonly qw27: Qw27PathEffFloorService,
    private readonly qw46: Qw46AsiaDowSkipService,
    private readonly qw47: Qw47LseSkipService,
    private readonly qw14a: Qw14aFridayEuBoostService,
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

    // 0. Circuit breaker pre-cascade
    if (signal.portfolioId) {
      // Best-effort reset (no-op si pas de trigger périmé)
      void this.circuitBreaker.autoResetIfNewDay(signal.portfolioId);
      const cbActive = await this.circuitBreaker.isActive(signal.portfolioId);
      if (cbActive) {
        const cbTrace: QwTrace = {
          qwId: 'CIRCUIT_BREAKER',
          decision: 'block',
          reason: 'daily_drawdown_active',
        };
        trace.push(cbTrace);
        return {
          decision: 'block',
          blockedBy: 'CIRCUIT_BREAKER',
          reason: cbTrace.reason,
          qwTrace: trace,
        };
      }
    }

    const ordered: Array<() => Promise<QwTrace>> = [
      () => Promise.resolve(this.qw46.check(signal)),
      () => Promise.resolve(this.qw47.check(signal)),
      () => Promise.resolve(this.qw1.check(signal)),
      () => Promise.resolve(this.qw6.check(signal)),
      () => Promise.resolve(this.qw11.check(signal)),
      () => Promise.resolve(this.qw9.check(signal)),
      () => Promise.resolve(this.qw27.check(signal)),
      () => this.qw4.check(signal),
      () => this.qw17.check(signal),
      () => this.qw15.check(signal),
      () => Promise.resolve(this.qw18.check(signal)),
      () => Promise.resolve(this.qw14a.check(signal)),
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
