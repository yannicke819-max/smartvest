import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#17 — Repeat-same-day cap par classe.
 *
 * Format env QW_17_REPEAT_CAPS=asia:4,us_sm:1,crypto:1,eu:2,us_large:2.
 * Day boundary = 00:00 Europe/Paris (UTC+2 été, UTC+1 hiver — calcul dérivé).
 *
 * Cache in-memory + hydratation Supabase au premier check d'une journée
 * (resilience restart Fly). Compteurs purgés des jours > 2 au passage.
 */

const SHORT_TO_LONG_CLASS: Record<string, string> = {
  asia: 'asia_equity',
  us_sm: 'us_equity_small_mid',
  us_large: 'us_equity_large',
  eu: 'eu_equity',
  crypto: 'crypto_major',
};

@Injectable()
export class Qw17RepeatSymbolCapService {
  private readonly logger = new Logger(Qw17RepeatSymbolCapService.name);
  private readonly rules = new Map<string, number>();
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly hydrated = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = this.config.get<string>('QW_17_REPEAT_CAPS') ?? 'asia:4,us_sm:1,crypto:1,eu:2,us_large:2';
    raw.split(',').forEach((pair) => {
      const [short, maxStr] = pair.split(':').map((s) => s.trim());
      const fullClass = SHORT_TO_LONG_CLASS[short];
      const max = Number.parseInt(maxStr, 10);
      if (fullClass && Number.isFinite(max) && max > 0) {
        this.rules.set(fullClass, max);
      }
    });
  }

  async check(signal: QwSignal): Promise<QwTrace> {
    const cap = this.rules.get(signal.assetClass);
    if (cap === undefined) {
      return { qwId: 'QW_17', decision: 'pass', reason: 'no_cap_for_class' };
    }

    const dayKey = this.getParisDayKey(signal.timestamp);
    if (!this.hydrated.has(dayKey)) {
      await this.hydrateFromDb(dayKey);
      this.purgeOldDays(dayKey);
    }

    const dayMap = this.counters.get(dayKey) ?? new Map<string, number>();
    const symbolKey = `${signal.symbol.toUpperCase()}__${signal.assetClass}`;
    const currentCount = dayMap.get(symbolKey) ?? 0;

    if (currentCount >= cap) {
      this.decisionLogger.log({
        qwId: 'QW_17',
        symbol: signal.symbol,
        assetClass: signal.assetClass,
        decision: 'block',
        reason: 'repeat_cap_reached',
        wouldHavePassedWithoutFlag: true,
        details: { dayKey, currentCount, cap },
      });
      return { qwId: 'QW_17', decision: 'block', reason: 'repeat_cap_reached' };
    }

    dayMap.set(symbolKey, currentCount + 1);
    this.counters.set(dayKey, dayMap);

    return { qwId: 'QW_17', decision: 'pass', reason: `count_${currentCount + 1}_of_${cap}` };
  }

  /** Visible pour les tests : day key au sens Paris (UTC+1 hiver / UTC+2 été). */
  getParisDayKey(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'invalid';
    const parisStr = date.toLocaleString('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return parisStr;
  }

  private async hydrateFromDb(dayKey: string): Promise<void> {
    this.hydrated.add(dayKey);
    if (!this.supabase.isReady()) return;

    const dayStartUtc = new Date(`${dayKey}T00:00:00+02:00`).toISOString();
    const dayEndUtc = new Date(`${dayKey}T23:59:59+02:00`).toISOString();

    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('symbol, asset_class')
        .gte('entry_timestamp', dayStartUtc)
        .lte('entry_timestamp', dayEndUtc);

      if (error) {
        this.logger.warn(`QW_17 hydrate failed for ${dayKey}: ${error.message}`);
        return;
      }

      const dayMap = new Map<string, number>();
      (data ?? []).forEach((row: { symbol: string; asset_class: string }) => {
        const key = `${row.symbol.toUpperCase()}__${row.asset_class}`;
        dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
      });
      this.counters.set(dayKey, dayMap);
    } catch (err) {
      this.logger.warn(`QW_17 hydrate exception for ${dayKey}: ${(err as Error).message}`);
    }
  }

  private purgeOldDays(currentDayKey: string): void {
    for (const cached of this.counters.keys()) {
      if (cached < currentDayKey && cached !== 'invalid') {
        this.counters.delete(cached);
        this.hydrated.delete(cached);
      }
    }
  }
}
