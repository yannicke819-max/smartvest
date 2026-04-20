import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const ScenarioKind = z.enum([
  'allocation_simulation',
  'rebalance_projection',
  'monte_carlo',
  'stress_test',
  'cost_impact',
]);
export type ScenarioKind = z.infer<typeof ScenarioKind>;

export const ScenarioRun = z.object({
  id: Uuid,
  userId: Uuid,
  portfolioId: Uuid.nullable(),
  kind: ScenarioKind,
  engineVersion: z.string(),
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  assumptions: z.array(z.string()),
  disclaimers: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type ScenarioRun = z.infer<typeof ScenarioRun>;
