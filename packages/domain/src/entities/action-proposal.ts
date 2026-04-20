import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';
import { DelegationMode, ExecutionIntentKind } from '@smartvest/shared-types';

/**
 * SuggestionLifecycleState tracks the state machine of a proposal from creation to resolution.
 * Every transition is timestamped and auditable.
 */
export const SuggestionLifecycleState = z.enum([
  'draft',            // Internal, not yet shown to user
  'presented',        // Shown to user, awaiting decision
  'approved',         // User explicitly validated
  'rejected',         // User explicitly rejected
  'expired',          // Not acted upon within ttl_seconds
  'executed',         // Carried out (AUTONOMOUS_GUARDED or HYBRID post-approval)
  'cancelled',        // Withdrawn before user decision
]);
export type SuggestionLifecycleState = z.infer<typeof SuggestionLifecycleState>;

/**
 * ActionApproval records a user's explicit decision on an ActionProposal.
 */
export const ActionApproval = z.object({
  id: Uuid,
  proposalId: Uuid,
  userId: Uuid,
  decision: z.enum(['approved', 'rejected', 'modified']),
  // If modified, the user-adjusted parameters
  modifiedQuantity: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  modifiedNotional: MoneyAmount.nullable(),
  note: z.string().nullable(),
  decidedAt: z.string().datetime(),
});
export type ActionApproval = z.infer<typeof ActionApproval>;

/**
 * ActionProposal is a concrete action proposed to the user (HYBRID_SUGGESTIVE)
 * or queued for autonomous execution (AUTONOMOUS_GUARDED).
 *
 * Every proposal must carry a rationale, assumptions, and estimated friction.
 * The user must be able to approve, reject, or modify before execution.
 */
export const ActionProposal = z.object({
  id: Uuid,
  portfolioId: Uuid,
  userId: Uuid,
  mandateId: Uuid.nullable(),

  kind: ExecutionIntentKind,
  delegationMode: DelegationMode,
  lifecycleState: SuggestionLifecycleState,

  action: z.enum(['buy', 'sell', 'rebalance', 'contribute', 'withdraw', 'fx', 'other']),
  assetId: Uuid.nullable(),
  ticker: z.string().nullable(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  notional: MoneyAmount.nullable(),
  currency: CurrencyCode.nullable(),

  // Why SmartVest proposes this action — always shown to user
  rationale: z.string(),
  assumptions: z.array(z.string()),

  estimatedFriction: z.object({
    brokerFee: MoneyAmount,
    spreadCost: MoneyAmount,
    slippageCost: MoneyAmount,
    fxMarkup: MoneyAmount,
    totalFriction: MoneyAmount,
    frictionCurrency: CurrencyCode,
  }).nullable(),

  // Lifecycle timestamps
  presentedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(), // proposal auto-expires if not acted upon
  approval: ActionApproval.nullable(),
  executedAt: z.string().datetime().nullable(),
  executionAuditId: Uuid.nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ActionProposal = z.infer<typeof ActionProposal>;
