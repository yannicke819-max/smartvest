import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const GoalType = z.enum([
  'retirement',
  'education',
  'real_estate',
  'emergency_fund',
  'travel',
  'business',
  'other',
]);
export type GoalType = z.infer<typeof GoalType>;

export const GoalStatus = z.enum([
  'draft',
  'active',
  'paused',
  'achieved',
  'abandoned',
]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const GoalTimeframe = z.object({
  totalMonths: z.number().int().positive(),
  targetDate: z.string().nullable(),
});
export type GoalTimeframe = z.infer<typeof GoalTimeframe>;

export const GoalConstraint = z.object({
  monthlyContribution: z.string().regex(/^\d+(\.\d+)?$/),
  horizon: GoalTimeframe,
  riskToleranceOverride: z.string().nullable(),
  maxVolatilityPct: z.string().nullable(),
  minMonthlyLiquidityAmount: z.string().nullable(),
});
export type GoalConstraint = z.infer<typeof GoalConstraint>;

export const GoalIntent = z.object({
  id: Uuid,
  userId: Uuid,
  portfolioId: Uuid,

  type: GoalType,
  status: GoalStatus,

  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),

  targetAmount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string().length(3),
  currentAmount: z.string().regex(/^\d+(\.\d+)?$/),

  constraint: GoalConstraint,

  activePlanId: Uuid.nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GoalIntent = z.infer<typeof GoalIntent>;
