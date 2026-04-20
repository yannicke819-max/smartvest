import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';
import { DelegationMode, ExecutionIntentKind } from '@smartvest/shared-types';

/**
 * An ExecutionIntent captures the full lifecycle of any action SmartVest proposes or takes.
 * It enforces the strict semantic separation between information → simulation → suggestion
 * → execution_intent → execution, making the delegation layer explicit at the data level.
 */
export const ExecutionIntent = z.object({
  id: Uuid,
  portfolioId: Uuid,
  userId: Uuid,
  mandateId: Uuid.nullable(), // Required if kind === 'execution' (AUTONOMOUS_GUARDED)

  kind: ExecutionIntentKind,
  delegationMode: DelegationMode,

  // The action being described or taken
  action: z.enum(['buy', 'sell', 'rebalance', 'contribute', 'withdraw', 'fx', 'other']),
  assetId: Uuid.nullable(),
  ticker: z.string().nullable(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
  notional: MoneyAmount.nullable(),
  currency: CurrencyCode.nullable(),

  // Why SmartVest proposes or took this action (always shown to user)
  rationale: z.string(),

  // Explicit assumptions (required for simulation and above)
  assumptions: z.array(z.string()),

  // Estimated friction breakdown (always shown if available)
  estimatedFriction: z.object({
    brokerFee: MoneyAmount,
    spreadCost: MoneyAmount,
    slippageCost: MoneyAmount,
    fxMarkup: MoneyAmount,
    totalFriction: MoneyAmount,
    frictionCurrency: CurrencyCode,
  }).nullable(),

  // User validation tracking
  shownToUserAt: z.string().datetime().nullable(),
  validatedByUserAt: z.string().datetime().nullable(),
  rejectedByUserAt: z.string().datetime().nullable(),

  // Execution tracking (only populated for kind === 'execution')
  executedAt: z.string().datetime().nullable(),
  executionAuditId: Uuid.nullable(),

  createdAt: z.string().datetime(),
});
export type ExecutionIntent = z.infer<typeof ExecutionIntent>;
