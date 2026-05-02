/**
 * ADR-007 PR #207a — Kelly sizing pour gainers V1.
 *
 * Formule Kelly pour pari binaire (gain/perte) :
 *   f* = (b × p - q) / b
 *   où :
 *     p = probabilité de gain (winRate)
 *     q = 1 - p = probabilité de perte
 *     b = payoff ratio = avg_gain / avg_loss
 *
 * Spec ADR-007 §3.2 :
 *   - Default = HALF-KELLY (f* / 2) pour réduire la variance (Cohen 2018)
 *   - Clamp [0, 0.25] pour éviter sur-leverage
 *   - p doit être le wilson95 LOWER BOUND (conservateur, intervalle de confiance)
 *   - b doit être le ratio actuel (TP_pct / SL_pct selon BLOC 4 §11.1)
 *   - Si n < 30 (sample baseline insuffisant) → return null (insufficient data)
 *
 * Tests : ADR-007 §3.3 — winRate=55%, R/R=1.67 → full Kelly = 28%, half = 14%.
 */

import { Injectable } from '@nestjs/common';
import { wilsonInterval95 } from '../shadow/power-analysis';

export interface KellySizingInput {
  /** Win rate observé sur l'échantillon shadow. */
  winRate: number;
  /** Taille de l'échantillon (trades fermés). */
  sampleSize: number;
  /** Payoff ratio b = avg_gain / avg_loss. Pour BLOC 4 equity : 1.5 (TP=1.5×path_eff, SL=1.0×path_eff). */
  payoffRatio: number;
  /** Equity actuel (USD). Pour persistance/audit ; n'affecte pas la fraction. */
  equityUsd?: number;
  /** Si true, applique demi-Kelly (default true par ADR-007). */
  applyHalfKelly?: boolean;
}

export interface KellySizingResult {
  /** Fraction Kelly suggérée (∈ [0, 0.25]). null si données insuffisantes. */
  fractionSuggested: number | null;
  /** Full Kelly avant half + clamp (peut être négatif si edge négatif). */
  fullKelly: number;
  /** Wilson lower bound utilisé pour le calcul (conservateur). */
  winRateLowerWilson: number;
  /** Inputs résumé pour audit. */
  inputs: {
    winRate: number;
    sampleSize: number;
    payoffRatio: number;
    halfKellyApplied: boolean;
    clampedFromFullKelly: boolean;
  };
}

/** Sample size minimum pour calculer Kelly fiable (ADR-007 §3.4). */
const MIN_SAMPLE_SIZE = 30;
/** Cap absolu pour éviter sur-leverage (clamp upper). */
const KELLY_UPPER_CAP = 0.25;

@Injectable()
export class KellySizingService {
  /**
   * Calcule la fraction Kelly suggérée.
   *
   * @returns {KellySizingResult} fraction ∈ [0, 0.25], null si sample < 30.
   */
  compute(input: KellySizingInput): KellySizingResult {
    const { winRate, sampleSize, payoffRatio } = input;
    const applyHalfKelly = input.applyHalfKelly ?? true;

    if (sampleSize < MIN_SAMPLE_SIZE || payoffRatio <= 0) {
      return {
        fractionSuggested: null,
        fullKelly: 0,
        winRateLowerWilson: 0,
        inputs: {
          winRate, sampleSize, payoffRatio,
          halfKellyApplied: applyHalfKelly, clampedFromFullKelly: false,
        },
      };
    }

    // Wilson lower bound = conservateur (vs winRate observé)
    const [winRateLower] = wilsonInterval95(winRate, sampleSize);
    const p = winRateLower;
    const q = 1 - p;
    const b = payoffRatio;

    // f* = (b*p - q) / b
    const fullKelly = (b * p - q) / b;

    // Edge négatif → 0 (ne pas trader)
    if (fullKelly <= 0) {
      return {
        fractionSuggested: 0,
        fullKelly,
        winRateLowerWilson: winRateLower,
        inputs: {
          winRate, sampleSize, payoffRatio,
          halfKellyApplied: applyHalfKelly, clampedFromFullKelly: false,
        },
      };
    }

    // Half-Kelly + clamp [0, 0.25]
    const afterHalf = applyHalfKelly ? fullKelly / 2 : fullKelly;
    const clamped = Math.max(0, Math.min(KELLY_UPPER_CAP, afterHalf));
    const wasClamped = clamped !== afterHalf;

    return {
      fractionSuggested: clamped,
      fullKelly,
      winRateLowerWilson: winRateLower,
      inputs: {
        winRate, sampleSize, payoffRatio,
        halfKellyApplied: applyHalfKelly, clampedFromFullKelly: wasClamped,
      },
    };
  }

  /** Convertit fraction Kelly + equity → position size USD. */
  toPositionSizeUsd(fraction: number | null, equityUsd: number): number {
    if (fraction === null || equityUsd <= 0) return 0;
    return fraction * equityUsd;
  }
}
