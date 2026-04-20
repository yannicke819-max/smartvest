import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';
import { DelegationMode } from '@smartvest/shared-types';

/**
 * AutonomyAuditEvent is a specialized, append-only audit record for any action
 * taken in HYBRID_SUGGESTIVE or AUTONOMOUS_GUARDED mode.
 *
 * Extends the base ExecutionAudit with delegation-specific context:
 * the mandate that authorized the action, the guardrail state at execution time,
 * and the kill-switch state. This ensures full a-posteriori explainability.
 */
export const AutonomyAuditEventKind = z.enum([
  'mandate_created',
  'mandate_activated',
  'mandate_suspended',
  'mandate_revoked',
  'mandate_expired',
  'kill_switch_triggered',
  'kill_switch_released',
  'proposal_presented',
  'proposal_approved',
  'proposal_rejected',
  'execution_attempted',
  'execution_succeeded',
  'execution_failed',
  'guardrail_blocked',      // Action blocked because it violated a guardrail
  'stop_loss_triggered',    // Portfolio drawdown exceeded stopLossTriggerPct
  'policy_violation',       // Action attempted outside mandate scope
]);
export type AutonomyAuditEventKind = z.infer<typeof AutonomyAuditEventKind>;

export const AutonomyAuditEvent = z.object({
  id: Uuid,
  portfolioId: Uuid,
  userId: Uuid,
  mandateId: Uuid.nullable(),
  proposalId: Uuid.nullable(),

  kind: AutonomyAuditEventKind,
  delegationMode: DelegationMode,

  // Snapshot of relevant state at event time (for full explainability)
  portfolioValueAtEvent: MoneyAmount.nullable(),
  portfolioCurrency: CurrencyCode.nullable(),

  // The action attempted or performed
  action: z.string().nullable(),
  ticker: z.string().nullable(),
  notional: MoneyAmount.nullable(),

  // Why this event occurred
  reason: z.string(),

  // Which guardrail blocked or allowed the action (if applicable)
  guardrailField: z.string().nullable(),
  guardrailValue: z.unknown().nullable(),
  guardrailLimit: z.unknown().nullable(),

  // SHA-256 hash chain — links to previous event for tamper detection
  prevHash: z.string().nullable(),
  hash: z.string(),

  occurredAt: z.string().datetime(),
});
export type AutonomyAuditEvent = z.infer<typeof AutonomyAuditEvent>;
