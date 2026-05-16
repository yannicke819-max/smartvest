import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import type { QwId, QwDecision } from './types';

export interface QwLogEntry {
  qwId: QwId;
  symbol: string;
  assetClass: string;
  decision: QwDecision;
  reason: string;
  wouldHavePassedWithoutFlag: boolean;
  details?: Record<string, unknown>;
}

/**
 * Logger Règle E — append-only dans qw_decision_log.
 * Fire-and-forget : une erreur d'insertion log un warn mais ne casse jamais
 * le cycle scanner appelant.
 */
@Injectable()
export class QwDecisionLoggerService {
  private readonly logger = new Logger(QwDecisionLoggerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  log(entry: QwLogEntry): void {
    if (!this.supabase.isReady()) return;
    void this.supabase
      .getClient()
      .from('qw_decision_log')
      .insert({
        qw_id: entry.qwId,
        symbol: entry.symbol,
        asset_class: entry.assetClass,
        decision: entry.decision,
        reason: entry.reason,
        would_have_passed_without_flag: entry.wouldHavePassedWithoutFlag,
        details: entry.details ?? {},
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          this.logger.warn(`qw_decision_log insert failed (${entry.qwId} ${entry.symbol}): ${error.message}`);
        }
      });
  }
}
