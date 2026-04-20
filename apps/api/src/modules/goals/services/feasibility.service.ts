import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { v4 as uuid } from 'uuid';
import type { FeasibilityAssessment, TensionKind, Lever } from '@smartvest/domain';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export interface FeasibilityInput {
  goalId: string;
  targetAmount: string;
  currentAmount: string;
  monthlyContribution: string;
  horizonMonths: number;
  riskProfile?: string | null;
  currentPortfolioReturnPct?: string | null;
}

// Compound future value: FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r
function futureValue(pv: Decimal, pmt: Decimal, annualRatePct: Decimal, months: number): Decimal {
  if (months <= 0) return pv;
  const r = annualRatePct.div(100).div(12);
  if (r.isZero()) {
    return pv.add(pmt.mul(months));
  }
  const factor = r.add(1).pow(months);
  return pv.mul(factor).add(pmt.mul(factor.sub(1)).div(r));
}

// Solve for the implied annual return that makes FV equal target
// Uses bisection between -20% and 50%
function solveImpliedReturn(pv: Decimal, pmt: Decimal, target: Decimal, months: number): Decimal {
  if (months <= 0) return new Decimal(0);
  let lo = new Decimal(-20);
  let hi = new Decimal(50);
  for (let i = 0; i < 60; i++) {
    const mid = lo.add(hi).div(2);
    const fv = futureValue(pv, pmt, mid, months);
    if (fv.lt(target)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo.add(hi).div(2);
}

const RISK_PROFILE_MAX_RETURN: Record<string, number> = {
  conservative: 4,
  balanced: 7,
  growth: 10,
  aggressive: 14,
};

@Injectable()
export class FeasibilityService {
  assess(input: FeasibilityInput): FeasibilityAssessment {
    const target = new Decimal(input.targetAmount);
    const current = new Decimal(input.currentAmount);
    const pmt = new Decimal(input.monthlyContribution);
    const { horizonMonths, riskProfile } = input;

    const impliedReturn = solveImpliedReturn(current, pmt, target, horizonMonths);
    const impliedPct = impliedReturn.toDecimalPlaces(4).toNumber();

    const profileMaxReturn = riskProfile
      ? (RISK_PROFILE_MAX_RETURN[riskProfile.toLowerCase()] ?? 7)
      : 7;

    const riskProfileAdequate = impliedPct <= profileMaxReturn;

    const tensions: TensionKind[] = [];
    const levers: Lever[] = [];

    // Check horizon adequacy (minimum 6 months)
    if (horizonMonths < 6) {
      tensions.push('horizon_too_short');
      levers.push({
        kind: 'extend_horizon',
        description: 'Prolonger l\'horizon d\'au moins 6 mois',
        estimatedImpactPct: null,
        requiredChange: `+${6 - horizonMonths} mois`,
      });
    }

    // Check if implied return is realistic
    if (impliedPct > 14) {
      tensions.push('target_too_high');
      levers.push({
        kind: 'reduce_target',
        description: 'Réduire l\'objectif ou accepter un horizon plus long',
        estimatedImpactPct: null,
        requiredChange: null,
      });
    }

    // Check contribution adequacy: can we reach target with 0% return?
    const fvZeroReturn = current.add(pmt.mul(horizonMonths));
    if (fvZeroReturn.lt(target.mul('0.5'))) {
      tensions.push('contribution_insufficient');
      // How much more monthly contribution needed?
      const gap = target.sub(current);
      const neededMonthly = gap.div(horizonMonths);
      const additional = neededMonthly.sub(pmt).toDecimalPlaces(2);
      levers.push({
        kind: 'increase_contribution',
        description: 'Augmenter les versements mensuels',
        estimatedImpactPct: null,
        requiredChange: additional.gt(0) ? `+${additional.toFixed(2)} / mois` : null,
      });
    }

    if (!riskProfileAdequate) {
      tensions.push('risk_profile_mismatch');
      levers.push({
        kind: 'accept_higher_volatility',
        description: 'Accepter un profil de risque plus élevé pour viser un rendement supérieur',
        estimatedImpactPct: null,
        requiredChange: null,
      });
    }

    // Credibility: score between 0-1
    // 1.0 = implied return ≤ 5%, no tensions
    // decreases as implied return grows, heavily penalized above 15%
    let score = 1.0;
    if (impliedPct > 0) {
      score = Math.max(0, 1 - impliedPct / 20);
    }
    if (tensions.includes('contribution_insufficient')) score *= 0.7;
    if (tensions.includes('horizon_too_short')) score *= 0.6;
    score = Math.max(0, Math.min(1, score));

    const gapAtZeroReturn = target.sub(fvZeroReturn).toDecimalPlaces(2);

    return {
      id: uuid(),
      goalId: input.goalId,
      credibilityScore: parseFloat(score.toFixed(4)),
      isCredible: score >= 0.35,
      impliedAnnualReturnRequired: impliedReturn.toDecimalPlaces(4).toFixed(4),
      currentPortfolioReturn: input.currentPortfolioReturnPct ?? null,
      tensions,
      levers,
      riskProfileAdequate,
      riskProfileNote: riskProfileAdequate
        ? null
        : `Le profil "${riskProfile}" tolère jusqu'à ${profileMaxReturn}% de rendement annuel ; l'objectif en requiert ${impliedPct.toFixed(2)}%.`,
      horizonMonths,
      gapToTarget: gapAtZeroReturn.lt(0) ? '0' : gapAtZeroReturn.toFixed(2),
      assessedAt: new Date().toISOString(),
      notes: tensions.length === 0 ? 'Objectif cohérent avec les paramètres.' : null,
    };
  }
}
