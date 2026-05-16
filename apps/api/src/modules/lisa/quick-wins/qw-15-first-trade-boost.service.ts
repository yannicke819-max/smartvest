import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#15 — First trade boost asia + crypto.
 *
 * Data 30j :
 *   asia first   : +$78 WR 57 %   (vs repeat WR 14 %)
 *   crypto first : +$27 WR 20 %   (vs repeat WR 0 %)
 *   eu / us      : first ET repeat tous deux négatifs → ne pas booster
 *
 * Décision : NE bloque PAS. Booste sizing ×1.15 sur first trade du jour
 * (timezone Europe/Paris) pour asia_equity et crypto_major uniquement.
 *
 * Fail-open : Supabase down → pas de boost (signal pass au sizing nominal).
 */

const BOOSTABLE_CLASSES = new Set(['asia_equity', 'crypto_major']);
const ENV_BY_CLASS: Record<string, string> = {
  asia_equity: 'QW15_FIRST_TRADE_BOOST_ASIA',
  crypto_major: 'QW15_FIRST_TRADE_BOOST_CRYPTO',
};

@Injectable()
export class Qw15FirstTradeBoostService {
  private readonly logger = new Logger(Qw15FirstTradeBoostService.name);
  private readonly multipliers = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    for (const [cls, envKey] of Object.entries(ENV_BY_CLASS)) {
      const raw = this.config.get<string>(envKey);
      const parsed = raw != null ? Number.parseFloat(raw) : NaN;
      this.multipliers.set(cls, Number.isFinite(parsed) ? parsed : 1.15);
    }
  }

  async check(signal: QwSignal): Promise<QwTrace> {
    if (!BOOSTABLE_CLASSES.has(signal.assetClass)) {
      return { qwId: 'QW_15', decision: 'pass', reason: 'class_not_boostable' };
    }
    if (!signal.portfolioId) {
      return { qwId: 'QW_15', decision: 'pass', reason: 'portfolio_id_missing' };
    }
    if (!this.supabase.isReady()) {
      return { qwId: 'QW_15', decision: 'pass', reason: 'supabase_not_ready' };
    }

    const startOfDayParis = this.getParisDayStartIso(signal.timestamp);
    if (startOfDayParis === null) {
      return { qwId: 'QW_15', decision: 'pass', reason: 'invalid_timestamp' };
    }

    try {
      const { count, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id', { count: 'exact', head: true })
        .eq('portfolio_id', signal.portfolioId)
        .eq('asset_class', signal.assetClass)
        .gte('entry_timestamp', startOfDayParis);
      if (error) {
        this.logger.warn(`QW_15 first-trade query failed: ${error.message}`);
        return { qwId: 'QW_15', decision: 'pass', reason: 'query_failed' };
      }
      if ((count ?? 0) > 0) {
        return { qwId: 'QW_15', decision: 'pass', reason: 'not_first_trade_of_day' };
      }
    } catch (err) {
      this.logger.warn(`QW_15 first-trade exception: ${(err as Error).message}`);
      return { qwId: 'QW_15', decision: 'pass', reason: 'query_exception' };
    }

    const multiplier = this.multipliers.get(signal.assetClass) ?? 1.15;

    this.decisionLogger.log({
      qwId: 'QW_15',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'modify',
      reason: 'first_trade_boost',
      wouldHavePassedWithoutFlag: true,
      details: { multiplier },
    });

    return {
      qwId: 'QW_15',
      decision: 'modify',
      reason: 'first_trade_boost',
      multiplier,
    };
  }

  /** ISO du début de jour Europe/Paris pour la date `timestamp`. Null si invalide. */
  getParisDayStartIso(timestamp: string): string | null {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const parisDateStr = date.toLocaleString('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Construct midnight Paris-local and produce ISO equivalent.
    // Paris offset can be +01:00 or +02:00 depending on DST — use Intl to derive.
    const localMidnight = new Date(`${parisDateStr}T00:00:00`);
    // Compute timezone offset for that local date in Paris
    const utcParts = new Date(
      localMidnight.toLocaleString('en-US', { timeZone: 'Europe/Paris' }),
    );
    const offsetMs = localMidnight.getTime() - utcParts.getTime();
    const parisMidnightUtc = new Date(localMidnight.getTime() + offsetMs);
    return parisMidnightUtc.toISOString();
  }
}
