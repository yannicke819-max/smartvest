import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const TriggerType = z.enum([
  'date_reached',
  'value_reached',
  'drawdown_exceeded',
  'allocation_drift_exceeded',
  'contribution_missed',
  'goal_achieved',
  'goal_at_risk',
  'manual_review',
]);
export type TriggerType = z.infer<typeof TriggerType>;

export const TriggerParams = z.discriminatedUnion('type', [
  z.object({ type: z.literal('date_reached'), targetDate: z.string() }),
  z.object({ type: z.literal('value_reached'), targetValue: z.string(), currency: z.string().length(3) }),
  z.object({ type: z.literal('drawdown_exceeded'), thresholdPct: z.string() }),
  z.object({ type: z.literal('allocation_drift_exceeded'), thresholdPct: z.string() }),
  z.object({ type: z.literal('contribution_missed'), gracePeriodDays: z.number().int().min(0) }),
  z.object({ type: z.literal('goal_achieved') }),
  z.object({ type: z.literal('goal_at_risk'), projectedShortfallPct: z.string() }),
  z.object({ type: z.literal('manual_review'), note: z.string().max(500).nullable() }),
]);
export type TriggerParams = z.infer<typeof TriggerParams>;

export const GoalTrigger = z.object({
  id: Uuid,
  goalId: Uuid,
  type: TriggerType,
  params: TriggerParams,
  isActive: z.boolean().default(true),
  linkedAlertRuleId: Uuid.nullable(),
  lastFiredAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GoalTrigger = z.infer<typeof GoalTrigger>;
