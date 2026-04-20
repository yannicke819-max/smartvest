import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const TensionKind = z.enum([
  'target_too_high',
  'horizon_too_short',
  'contribution_insufficient',
  'risk_profile_mismatch',
  'volatility_too_high',
]);
export type TensionKind = z.infer<typeof TensionKind>;

export const LeverKind = z.enum([
  'increase_contribution',
  'extend_horizon',
  'reduce_target',
  'accept_higher_volatility',
  'reallocate_existing_capital',
]);
export type LeverKind = z.infer<typeof LeverKind>;

export const Lever = z.object({
  kind: LeverKind,
  description: z.string(),
  estimatedImpactPct: z.string().nullable(),
  requiredChange: z.string().nullable(),
});
export type Lever = z.infer<typeof Lever>;

export const FeasibilityAssessment = z.object({
  id: Uuid,
  goalId: Uuid,

  credibilityScore: z.number().min(0).max(1),
  isCredible: z.boolean(),

  impliedAnnualReturnRequired: z.string(),
  currentPortfolioReturn: z.string().nullable(),

  tensions: z.array(TensionKind),
  levers: z.array(Lever),

  riskProfileAdequate: z.boolean(),
  riskProfileNote: z.string().nullable(),

  horizonMonths: z.number().int(),
  gapToTarget: z.string(),

  assessedAt: z.string().datetime(),
  notes: z.string().nullable(),
});
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessment>;
