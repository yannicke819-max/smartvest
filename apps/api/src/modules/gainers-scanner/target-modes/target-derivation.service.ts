/**
 * ADR-007 PR #207a — Target derivation pure logic.
 *
 * Convertit annual ↔ monthly ↔ daily via compounding géométrique :
 *   monthly_pct = (1 + annual_pct)^(1/12) - 1   (12 mois calendaires)
 *   daily_pct   = (1 + annual_pct)^(1/252) - 1  (252 jours ouvrés)
 *   daily_pct   = (1 + monthly_pct)^(1/21) - 1  (21 jours ouvrés / mois)
 *
 * Pour ABSOLUTE_USD et PCT_OF_EQUITY : pas de dérivation, target_value direct.
 */

import { Injectable } from '@nestjs/common';
import {
  TargetConfig,
  TargetMode,
  DerivedTargets,
  TRADING_DAYS_PER_MONTH,
  TRADING_DAYS_PER_YEAR,
} from './types';

@Injectable()
export class TargetDerivationService {
  /**
   * Compounding annuel → mensuel.
   * (1 + monthly)^12 = 1 + annual.
   */
  annualToMonthly(annualPct: number): number {
    return Math.pow(1 + annualPct, 1 / 12) - 1;
  }

  /**
   * Compounding annuel → daily.
   * (1 + daily)^252 = 1 + annual.
   */
  annualToDaily(annualPct: number): number {
    return Math.pow(1 + annualPct, 1 / TRADING_DAYS_PER_YEAR) - 1;
  }

  /**
   * Compounding mensuel → daily (21 jours ouvrés/mois).
   * (1 + daily)^21 = 1 + monthly.
   */
  monthlyToDaily(monthlyPct: number): number {
    return Math.pow(1 + monthlyPct, 1 / TRADING_DAYS_PER_MONTH) - 1;
  }

  /** Inverse : daily → monthly. (1 + daily)^21 - 1 = monthly. */
  dailyToMonthly(dailyPct: number): number {
    return Math.pow(1 + dailyPct, TRADING_DAYS_PER_MONTH) - 1;
  }

  /** Inverse : daily → annual. (1 + daily)^252 - 1 = annual. */
  dailyToAnnual(dailyPct: number): number {
    return Math.pow(1 + dailyPct, TRADING_DAYS_PER_YEAR) - 1;
  }

  /**
   * Calcule la triple représentation (daily/monthly/annual) en pct ET en USD
   * à partir d'un TargetConfig + equity courant.
   */
  derive(config: TargetConfig, equityUsd: number): DerivedTargets {
    let dailyPct: number | null = null;
    let monthlyPct: number | null = null;
    let annualPct: number | null = null;
    let dailyUsd: number | null = null;

    switch (config.mode) {
      case TargetMode.ABSOLUTE_USD:
        if (config.targetValue !== undefined && equityUsd > 0) {
          dailyUsd = config.targetValue;
          dailyPct = config.targetValue / equityUsd;
        }
        break;

      case TargetMode.PCT_OF_EQUITY:
        if (config.targetValue !== undefined && equityUsd > 0) {
          dailyPct = config.targetValue;
          dailyUsd = config.targetValue * equityUsd;
        }
        break;

      case TargetMode.MONTHLY_COMPOUND:
        if (config.monthlyTargetPct !== undefined) {
          monthlyPct = config.monthlyTargetPct;
          dailyPct = this.monthlyToDaily(config.monthlyTargetPct);
          if (equityUsd > 0) dailyUsd = dailyPct * equityUsd;
        }
        break;

      case TargetMode.ANNUAL_COMPOUND:
        if (config.annualTargetPct !== undefined) {
          annualPct = config.annualTargetPct;
          dailyPct = this.annualToDaily(config.annualTargetPct);
          if (equityUsd > 0) dailyUsd = dailyPct * equityUsd;
        }
        break;
    }

    // Compute the missing horizons via compounding from daily
    if (dailyPct !== null) {
      if (monthlyPct === null) monthlyPct = this.dailyToMonthly(dailyPct);
      if (annualPct === null) annualPct = this.dailyToAnnual(dailyPct);
    }

    const monthlyUsd = monthlyPct !== null && equityUsd > 0 ? monthlyPct * equityUsd : null;
    const annualUsd = annualPct !== null && equityUsd > 0 ? annualPct * equityUsd : null;

    return {
      daily: { pct: dailyPct, usd: dailyUsd },
      monthly: { pct: monthlyPct, usd: monthlyUsd },
      annual: { pct: annualPct, usd: annualUsd },
    };
  }

  /**
   * Calcule derived_daily_pct à persister dans daily_harvest_config.
   * Utile pour pré-calcul DB-side avant l'appel runtime.
   */
  computeDerivedDailyPct(config: TargetConfig): number | null {
    if (config.mode === TargetMode.MONTHLY_COMPOUND && config.monthlyTargetPct !== undefined) {
      return this.monthlyToDaily(config.monthlyTargetPct);
    }
    if (config.mode === TargetMode.ANNUAL_COMPOUND && config.annualTargetPct !== undefined) {
      return this.annualToDaily(config.annualTargetPct);
    }
    if (config.mode === TargetMode.PCT_OF_EQUITY && config.targetValue !== undefined) {
      return config.targetValue;
    }
    // ABSOLUTE_USD : pas de daily_pct fixe (dépend de l'equity)
    return null;
  }
}
