import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const ScenarioType = z.enum(['prudent', 'central', 'ambitieux']);
export type ScenarioType = z.infer<typeof ScenarioType>;

export const TrajectoryPoint = z.object({
  month: z.number().int().min(0),
  projectedValue: z.string(),
  contribution: z.string(),
});
export type TrajectoryPoint = z.infer<typeof TrajectoryPoint>;

export const ObjectiveScenario = z.object({
  id: Uuid,
  goalId: Uuid,

  scenarioType: ScenarioType,

  annualReturnAssumptionPct: z.string(),
  volatilityAssumptionPct: z.string(),
  monthlyContribution: z.string(),
  projectedFinalValue: z.string(),
  shortfallOrSurplus: z.string(),

  estimatedProbability: z.number().min(0).max(1).nullable(),

  suggestedAllocation: z.record(z.string(), z.number()),

  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  failureConditions: z.array(z.string()),

  trajectory: z.array(TrajectoryPoint),

  generatedAt: z.string().datetime(),
});
export type ObjectiveScenario = z.infer<typeof ObjectiveScenario>;
