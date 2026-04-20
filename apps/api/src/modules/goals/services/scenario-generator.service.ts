import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { v4 as uuid } from 'uuid';
import type { ObjectiveScenario, ScenarioType, TrajectoryPoint } from '@smartvest/domain';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

const SCENARIO_PARAMS: Record<ScenarioType, {
  annualReturnPct: number;
  volatilityPct: number;
  contributionMultiplier: number;
  probabilityBase: number;
}> = {
  prudent: { annualReturnPct: 3.5, volatilityPct: 5, contributionMultiplier: 1, probabilityBase: 0.80 },
  central: { annualReturnPct: 6.5, volatilityPct: 10, contributionMultiplier: 1, probabilityBase: 0.55 },
  ambitieux: { annualReturnPct: 10, volatilityPct: 16, contributionMultiplier: 1.1, probabilityBase: 0.30 },
};

const DEFAULT_ALLOCATIONS: Record<ScenarioType, Record<string, number>> = {
  prudent: { bonds: 0.60, equity: 0.30, cash: 0.10 },
  central: { equity: 0.60, bonds: 0.30, alternatives: 0.10 },
  ambitieux: { equity: 0.85, alternatives: 0.10, cash: 0.05 },
};

function buildTrajectory(
  current: Decimal,
  monthlyPmt: Decimal,
  annualReturnPct: number,
  horizonMonths: number,
): TrajectoryPoint[] {
  const r = new Decimal(annualReturnPct).div(100).div(12);
  const points: TrajectoryPoint[] = [];
  let value = current;
  for (let m = 0; m <= horizonMonths; m += Math.max(1, Math.floor(horizonMonths / 24))) {
    points.push({
      month: m,
      projectedValue: value.toDecimalPlaces(2).toFixed(2),
      contribution: monthlyPmt.toFixed(2),
    });
    if (m < horizonMonths) {
      const steps = Math.min(Math.max(1, Math.floor(horizonMonths / 24)), horizonMonths - m);
      for (let s = 0; s < steps; s++) {
        value = value.mul(r.add(1)).add(monthlyPmt);
      }
    }
  }
  return points;
}

function fv(pv: Decimal, pmt: Decimal, annualReturnPct: number, months: number): Decimal {
  const r = new Decimal(annualReturnPct).div(100).div(12);
  if (r.isZero()) return pv.add(pmt.mul(months));
  const factor = r.add(1).pow(months);
  return pv.mul(factor).add(pmt.mul(factor.sub(1)).div(r));
}

@Injectable()
export class ScenarioGeneratorService {
  generate(
    goalId: string,
    targetAmount: string,
    currentAmount: string,
    baseMonthlyContribution: string,
    horizonMonths: number,
  ): ObjectiveScenario[] {
    const target = new Decimal(targetAmount);
    const current = new Decimal(currentAmount);
    const basePmt = new Decimal(baseMonthlyContribution);

    return (['prudent', 'central', 'ambitieux'] as ScenarioType[]).map((type) => {
      const p = SCENARIO_PARAMS[type];
      const pmt = basePmt.mul(p.contributionMultiplier).toDecimalPlaces(2);
      const projected = fv(current, pmt, p.annualReturnPct, horizonMonths);
      const surplus = projected.sub(target).toDecimalPlaces(2);
      const probability = parseFloat(Math.max(0, Math.min(1, p.probabilityBase + (surplus.gt(0) ? 0.1 : -0.1))).toFixed(4));

      const trajectory = buildTrajectory(current, pmt, p.annualReturnPct, horizonMonths);

      const assumptions: string[] = [
        `Rendement annuel hypothétique : ${p.annualReturnPct}% (avant frais)`,
        `Volatilité annuelle estimée : ${p.volatilityPct}%`,
        `Versements mensuels : ${pmt.toFixed(2)} (constants, non indexés)`,
        'Les performances passées ne préjugent pas des performances futures.',
        'Hypothèses déterministes — aucune garantie de rendement.',
      ];

      if (type === 'ambitieux') {
        assumptions.push('Surexposition actions : risque de perte en capital élevé.');
      }

      const risks: string[] = [];
      const failureConditions: string[] = [];

      if (type === 'prudent') {
        risks.push('Rendement réel potentiellement inférieur à l\'inflation.');
        failureConditions.push('Taux d\'intérêt négatifs prolongés.');
      }
      if (type === 'central') {
        risks.push('Drawdown actions pouvant dépasser 30% temporairement.');
        failureConditions.push('Crise de marché durable dans les 3 dernières années de l\'horizon.');
      }
      if (type === 'ambitieux') {
        risks.push('Volatilité élevée — perte possible supérieure à 40%.');
        risks.push('Risque de concentration sectorielle.');
        failureConditions.push('Krach prolongé ou environnement de taux structurellement élevés.');
        failureConditions.push('Interruption des versements pendant plus de 6 mois.');
      }

      return {
        id: uuid(),
        goalId,
        scenarioType: type,
        annualReturnAssumptionPct: new Decimal(p.annualReturnPct).toFixed(4),
        volatilityAssumptionPct: new Decimal(p.volatilityPct).toFixed(4),
        monthlyContribution: pmt.toFixed(2),
        projectedFinalValue: projected.toDecimalPlaces(2).toFixed(2),
        shortfallOrSurplus: surplus.toFixed(2),
        estimatedProbability: probability,
        suggestedAllocation: DEFAULT_ALLOCATIONS[type],
        assumptions,
        risks,
        failureConditions,
        trajectory,
        generatedAt: new Date().toISOString(),
      } satisfies ObjectiveScenario;
    });
  }
}
