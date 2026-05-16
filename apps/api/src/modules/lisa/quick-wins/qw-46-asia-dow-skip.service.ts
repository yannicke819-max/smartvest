import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#46 — Skip asia_equity Jeudi + Vendredi (Europe/Paris).
 *
 * Data 30j par dow Paris pour asia_equity :
 *   Lun 37.5 % WR, Mar 32 %, Mer 28.6 % → profitable
 *   Jeu 14.7 % WR -$438, Ven 4.3 % WR -$471 → -$909/30j = -$30/jour
 *
 * Env var : QW46_ASIA_SKIP_DOW (CSV de dow Paris, Lundi=1, Vendredi=5).
 * Default : "4,5" (Jeudi + Vendredi).
 */
@Injectable()
export class Qw46AsiaDowSkipService {
  private readonly skipDays: Set<number>;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = this.config.get<string>('QW46_ASIA_SKIP_DOW') ?? '4,5';
    this.skipDays = new Set(
      raw
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7),
    );
  }

  /** Day-of-week en timezone Europe/Paris : Lundi=1, Dimanche=7. */
  getParisDow(timestamp: string): number | null {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    // toLocaleString avec weekday=long puis mapping → fragile (i18n).
    // À la place, on dérive l'offset Paris vs UTC pour la date, puis Date.getUTCDay().
    const parisDateStr = date.toLocaleString('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Construct a Date at midnight Paris-local interpreted as UTC for getUTCDay safety.
    const parisDateUtc = new Date(`${parisDateStr}T00:00:00Z`);
    const dow0Sun = parisDateUtc.getUTCDay(); // 0=Sunday
    return dow0Sun === 0 ? 7 : dow0Sun;
  }

  check(signal: QwSignal): QwTrace {
    if (signal.assetClass !== 'asia_equity') {
      return { qwId: 'QW_46', decision: 'pass', reason: 'not_asia_class' };
    }
    const dow = this.getParisDow(signal.timestamp);
    if (dow === null) {
      return { qwId: 'QW_46', decision: 'pass', reason: 'invalid_timestamp' };
    }
    if (!this.skipDays.has(dow)) {
      return { qwId: 'QW_46', decision: 'pass', reason: `dow_paris_${dow}_allowed` };
    }

    this.decisionLogger.log({
      qwId: 'QW_46',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'asia_thursday_friday_skip',
      wouldHavePassedWithoutFlag: true,
      details: { dowParis: dow, skipDays: Array.from(this.skipDays) },
    });
    return { qwId: 'QW_46', decision: 'block', reason: 'asia_thursday_friday_skip' };
  }
}
