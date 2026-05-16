import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#14a — Friday EU sizing boost ×1.3.
 *
 * QW#1 autorise déjà l'ouverture eu_equity le vendredi 08h UTC (exception
 * `eu_friday_pass`). QW#14a ajoute un boost sizing ×1.3 sur cette même fenêtre
 * pour capturer la persistance accrue observée le vendredi (data session 14 mai).
 *
 * Décision : modify ×1.3 uniquement si asset_class='eu_equity' ET dow Paris = 5.
 * Aucune autre classe ni autre jour n'est impactée.
 *
 * Placé en dernier de la cascade pour appliquer le boost sur le multiplier final
 * cumulé (après QW#15 first-trade, QW#18 exchange, etc.).
 */

const DEFAULT_MULTIPLIER = 1.3;
const MULTIPLIER_MIN = 1.0;
const MULTIPLIER_MAX = 2.0;

const DOW_MAP_PARIS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

@Injectable()
export class Qw14aFridayEuBoostService {
  private readonly logger = new Logger(Qw14aFridayEuBoostService.name);
  private readonly enabled: boolean;
  private readonly multiplier: number;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    this.enabled = (this.config.get<string>('QW14A_FRIDAY_EU_BOOST_ENABLED') ?? 'true') === 'true';

    const raw = this.config.get<string>('QW14A_FRIDAY_EU_MULT');
    const parsed = raw != null ? Number.parseFloat(raw) : NaN;
    if (raw != null && (!Number.isFinite(parsed) || parsed < MULTIPLIER_MIN || parsed > MULTIPLIER_MAX)) {
      this.logger.warn(
        `QW14A_FRIDAY_EU_MULT="${raw}" invalide (attendu ${MULTIPLIER_MIN}-${MULTIPLIER_MAX}) — fallback ${DEFAULT_MULTIPLIER}`,
      );
      this.multiplier = DEFAULT_MULTIPLIER;
    } else {
      this.multiplier = Number.isFinite(parsed) ? parsed : DEFAULT_MULTIPLIER;
    }
  }

  /** Day-of-week en timezone Europe/Paris : Lundi=1, Dimanche=0. Null si timestamp invalide. */
  getDowParis(timestamp: string): number | null {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const weekday = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris',
      weekday: 'short',
    }).format(date);
    const dow = DOW_MAP_PARIS[weekday];
    return dow ?? null;
  }

  check(signal: QwSignal): QwTrace {
    if (!this.enabled) {
      return { qwId: 'QW_14A', decision: 'pass', reason: 'disabled' };
    }
    if (signal.assetClass !== 'eu_equity') {
      return { qwId: 'QW_14A', decision: 'pass', reason: 'not_eu_class' };
    }
    const dow = this.getDowParis(signal.timestamp);
    if (dow === null) {
      return { qwId: 'QW_14A', decision: 'pass', reason: 'invalid_timestamp' };
    }
    if (dow !== 5) {
      return { qwId: 'QW_14A', decision: 'pass', reason: 'not_friday_paris' };
    }

    const reason = `friday_eu_boost_x${this.multiplier}`;
    this.decisionLogger.log({
      qwId: 'QW_14A',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'modify',
      reason,
      wouldHavePassedWithoutFlag: true,
      details: { dowParis: dow, multiplier: this.multiplier },
    });

    return {
      qwId: 'QW_14A',
      decision: 'modify',
      reason,
      multiplier: this.multiplier,
    };
  }
}
