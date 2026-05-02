/**
 * ADR-007 PR #207a — Target Modes types.
 *
 * 4 modes pour définir un objectif scalable sans casser l'algo :
 *   ABSOLUTE_USD       : montant fixe (ex: $100/jour)
 *   PCT_OF_EQUITY      : % du capital courant (ex: 0.5%/jour)
 *   MONTHLY_COMPOUND   : objectif mensuel %, daily dérivé géométrique 21j ouvrés
 *   ANNUAL_COMPOUND    : objectif annuel %, daily dérivé géométrique 252j
 */

export enum TargetMode {
  ABSOLUTE_USD = 'ABSOLUTE_USD',
  PCT_OF_EQUITY = 'PCT_OF_EQUITY',
  MONTHLY_COMPOUND = 'MONTHLY_COMPOUND',
  ANNUAL_COMPOUND = 'ANNUAL_COMPOUND',
}

export interface TargetConfig {
  mode: TargetMode;
  /** ABSOLUTE_USD : montant cible. PCT_OF_EQUITY : fraction décimale (0.005 = 0.5%). */
  targetValue?: number;
  /** Pour MONTHLY_COMPOUND : fraction décimale (0.05 = +5%/mois). */
  monthlyTargetPct?: number;
  /** Pour ANNUAL_COMPOUND : fraction décimale (0.30 = +30%/an). */
  annualTargetPct?: number;
  /** Auto-calculé : fraction décimale daily équivalente (lecture seule). */
  derivedDailyPct?: number;
}

export interface DerivedTargets {
  daily: { pct: number | null; usd: number | null };
  monthly: { pct: number | null; usd: number | null };
  annual: { pct: number | null; usd: number | null };
}

/** Constantes calendrier équity US standard (cf. ADR-005 §1bis). */
export const TRADING_DAYS_PER_MONTH = 21;
export const TRADING_DAYS_PER_YEAR = 252;
