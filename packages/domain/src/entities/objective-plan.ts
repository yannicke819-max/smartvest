import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';
import { DelegationMode } from '@smartvest/shared-types';

export const PlanStatus = z.enum(['draft', 'active', 'completed', 'abandoned']);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const CheckpointOutcome = z.enum(['on_track', 'off_track', 'achieved', 'abandoned']);
export type CheckpointOutcome = z.infer<typeof CheckpointOutcome>;

export const ActionCandidateStatus = z.enum([
  'pending',
  'suggested',
  'approved',
  'rejected',
  'executed',
]);
export type ActionCandidateStatus = z.infer<typeof ActionCandidateStatus>;

export const ActionCandidateKind = z.enum([
  'contribute',
  'rebalance',
  'buy',
  'sell',
  'review',
  'inform',
]);
export type ActionCandidateKind = z.infer<typeof ActionCandidateKind>;

export const PlanActionCandidate = z.object({
  id: Uuid,
  stepId: Uuid,
  kind: ActionCandidateKind,
  ticker: z.string().nullable(),
  isin: z.string().nullable(),
  amount: z.string().nullable(),
  quantity: z.string().nullable(),
  rationale: z.string(),
  delegationMode: DelegationMode,
  status: ActionCandidateStatus,
  createdAt: z.string().datetime(),
});
export type PlanActionCandidate = z.infer<typeof PlanActionCandidate>;

export const ObjectivePlanStep = z.object({
  id: Uuid,
  planId: Uuid,
  order: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  actionKind: z.enum(['contribution_setup', 'allocation_rebalance', 'product_selection', 'review', 'monitoring']),
  targetDate: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  actionCandidates: z.array(PlanActionCandidate),
});
export type ObjectivePlanStep = z.infer<typeof ObjectivePlanStep>;

export const ObjectiveReviewCheckpoint = z.object({
  id: Uuid,
  planId: Uuid,
  scheduledAt: z.string(),
  title: z.string(),
  description: z.string(),
  triggerIds: z.array(Uuid),
  completedAt: z.string().datetime().nullable(),
  outcome: CheckpointOutcome.nullable(),
  notes: z.string().nullable(),
});
export type ObjectiveReviewCheckpoint = z.infer<typeof ObjectiveReviewCheckpoint>;

export const ObjectivePlan = z.object({
  id: Uuid,
  goalId: Uuid,
  scenarioId: Uuid,

  status: PlanStatus,
  delegationMode: DelegationMode,

  steps: z.array(ObjectivePlanStep),
  checkpoints: z.array(ObjectiveReviewCheckpoint),

  selectedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ObjectivePlan = z.infer<typeof ObjectivePlan>;
