import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

// =============================================================================
// Enums
// =============================================================================

export const FundingTransferStatus = z.enum([
  'draft',
  'initiated',
  'pending_settlement',
  'settled',
  'partially_settled',
  'cancelled',
  'failed',
  'reversed',
]);
export type FundingTransferStatus = z.infer<typeof FundingTransferStatus>;

export const FundingTransferMethod = z.enum([
  'bank_transfer',
  'manual_record',
  'broker_internal_transfer',
  'cash_adjustment',
]);
export type FundingTransferMethod = z.infer<typeof FundingTransferMethod>;

export const CashMovementType = z.enum([
  'deposit',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'settlement_credit',
  'settlement_debit',
  'reservation',
  'reservation_release',
  'adjustment',
]);
export type CashMovementType = z.infer<typeof CashMovementType>;

export const CashReservationStatus = z.enum(['active', 'released', 'consumed']);
export type CashReservationStatus = z.infer<typeof CashReservationStatus>;

export const FundingAllocationKind = z.enum(['goal', 'portfolio', 'plan', 'proposal']);
export type FundingAllocationKind = z.infer<typeof FundingAllocationKind>;

export const FundingAuditKind = z.enum([
  'transfer_created',
  'transfer_updated',
  'transfer_initiated',
  'transfer_settled',
  'transfer_partially_settled',
  'transfer_cancelled',
  'transfer_failed',
  'transfer_reversed',
  'reservation_created',
  'reservation_released',
  'reservation_consumed',
  'allocation_linked',
  'allocation_unlinked',
  'cash_adjustment',
]);
export type FundingAuditKind = z.infer<typeof FundingAuditKind>;

// Cash availability states are a derived view, not persisted as-is.
// Kept as an enum so UIs can label each bucket consistently.
export const CashAvailabilityState = z.enum([
  'settled',           // credited to the account, not reserved
  'pending_in',        // incoming transfer, not yet settled
  'available',         // settled − reserved (free to allocate)
  'reserved',          // soft-locked for a plan / goal / proposal
  'planned',           // earmarked for a future action (subset of reserved)
]);
export type CashAvailabilityState = z.infer<typeof CashAvailabilityState>;

// Decimal string (monetary). Never `number`.
const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

// =============================================================================
// FundingSource — user-declared source bank account
// =============================================================================
export const FundingSource = z.object({
  id: Uuid,
  userId: Uuid,
  label: z.string().min(1).max(100),
  ibanLast4: z.string().length(4).nullable(),
  bankName: z.string().nullable(),
  currency: z.string().length(3),
  isArchived: z.boolean(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FundingSource = z.infer<typeof FundingSource>;

// =============================================================================
// FundingDestination — investment/broker account that receives funds
// =============================================================================
export const FundingDestination = z.object({
  id: Uuid,
  userId: Uuid,
  portfolioId: Uuid.nullable(),
  portfolioAccountId: Uuid.nullable(),
  brokerAccountRef: z.string().nullable(),
  label: z.string().min(1).max(100),
  currency: z.string().length(3),
  isArchived: z.boolean(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FundingDestination = z.infer<typeof FundingDestination>;

// =============================================================================
// FundingTransfer — user-created transfer intent with state machine
// =============================================================================
export const FundingTransfer = z.object({
  id: Uuid,
  userId: Uuid,
  portfolioId: Uuid.nullable(),
  portfolioAccountId: Uuid.nullable(),

  sourceId: Uuid.nullable(),
  destinationId: Uuid,

  status: FundingTransferStatus,
  method: FundingTransferMethod,

  currency: z.string().length(3),
  requestedAmount: DecimalString,
  settledAmount: DecimalString,

  initiatedAt: z.string().datetime().nullable(),
  expectedSettlementDate: z.string().date().nullable(),
  settledAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  reversedAt: z.string().datetime().nullable(),

  failureReason: z.string().nullable(),
  reversalReason: z.string().nullable(),

  note: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FundingTransfer = z.infer<typeof FundingTransfer>;

// State-machine transitions: which statuses can follow from each state.
// Guards against programmer errors (e.g. trying to settle a cancelled transfer).
export const FUNDING_TRANSFER_TRANSITIONS: Record<FundingTransferStatus, FundingTransferStatus[]> = {
  draft:              ['initiated', 'cancelled'],
  initiated:          ['pending_settlement', 'settled', 'cancelled', 'failed'],
  pending_settlement: ['settled', 'partially_settled', 'failed', 'cancelled'],
  partially_settled:  ['settled', 'failed', 'cancelled'],
  settled:            ['reversed'],
  cancelled:          [],
  failed:             ['reversed'],
  reversed:           [],
};

export function canTransition(from: FundingTransferStatus, to: FundingTransferStatus): boolean {
  return FUNDING_TRANSFER_TRANSITIONS[from].includes(to);
}

/** A transfer is "in transit" from the user's POV while it hasn't settled or failed. */
export function isInTransit(t: FundingTransfer): boolean {
  return t.status === 'initiated' || t.status === 'pending_settlement' || t.status === 'partially_settled';
}

/** A transfer counts as "settled cash" only when fully or partially settled. */
export function contributesToSettledCash(t: FundingTransfer): boolean {
  return t.status === 'settled' || t.status === 'partially_settled';
}

// =============================================================================
// CashBalance — denormalised balance per (destination, currency)
// =============================================================================
export const CashBalance = z.object({
  id: Uuid,
  userId: Uuid,
  destinationId: Uuid,
  currency: z.string().length(3),

  settled: DecimalString,
  pendingIn: DecimalString,
  reserved: DecimalString,

  updatedAt: z.string().datetime(),
});
export type CashBalance = z.infer<typeof CashBalance>;

/**
 * Available = settled − reserved. Computed from a balance row, never stored.
 * Returned as a decimal string (string maths via Decimal.js on call sites).
 */
export function computeAvailable(balance: Pick<CashBalance, 'settled' | 'reserved'>): string {
  const settled = Number(balance.settled);
  const reserved = Number(balance.reserved);
  // Call sites must use Decimal.js when precision matters — this is a UI helper only.
  return (settled - reserved).toFixed(2);
}

// =============================================================================
// CashLedgerEntry — append-only journal row (source of truth for balances)
// =============================================================================
export const CashLedgerEntry = z.object({
  id: Uuid,
  userId: Uuid,
  destinationId: Uuid,
  currency: z.string().length(3),

  movementType: CashMovementType,
  amount: DecimalString,           // signed: +credit / −debit

  transferId: Uuid.nullable(),
  reservationId: Uuid.nullable(),

  balanceAfter: DecimalString,

  description: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type CashLedgerEntry = z.infer<typeof CashLedgerEntry>;

// =============================================================================
// CashReservation — soft-lock on available cash for a plan/goal/proposal
// =============================================================================
export const CashReservation = z.object({
  id: Uuid,
  userId: Uuid,
  destinationId: Uuid,
  currency: z.string().length(3),
  amount: DecimalString,

  status: CashReservationStatus,

  goalId: Uuid.nullable(),
  proposalId: Uuid.nullable(),
  planId: Uuid.nullable(),
  reason: z.string().min(1),

  expiresAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  consumedAt: z.string().datetime().nullable(),

  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CashReservation = z.infer<typeof CashReservation>;

// =============================================================================
// FundingAllocationLink — transfer ↔ (goal | portfolio | plan | proposal)
// =============================================================================
export const FundingAllocationLink = z.object({
  id: Uuid,
  userId: Uuid,
  transferId: Uuid,

  linkKind: FundingAllocationKind,
  goalId: Uuid.nullable(),
  portfolioId: Uuid.nullable(),
  planId: Uuid.nullable(),
  proposalId: Uuid.nullable(),

  allocatedAmount: DecimalString,
  currency: z.string().length(3),

  note: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type FundingAllocationLink = z.infer<typeof FundingAllocationLink>;

// =============================================================================
// FundingAuditEvent — hash-chained audit trail (mirrors autonomy_audit_events)
// =============================================================================
export const FundingAuditEvent = z.object({
  id: Uuid,
  userId: Uuid,
  transferId: Uuid.nullable(),
  reservationId: Uuid.nullable(),

  kind: FundingAuditKind,

  prevStatus: FundingTransferStatus.nullable(),
  newStatus: FundingTransferStatus.nullable(),
  amount: DecimalString.nullable(),
  currency: z.string().length(3).nullable(),

  reason: z.string().nullable(),

  prevHash: z.string().nullable(),
  hash: z.string(),

  metadata: z.record(z.unknown()).default({}),
  occurredAt: z.string().datetime(),
});
export type FundingAuditEvent = z.infer<typeof FundingAuditEvent>;

// =============================================================================
// FundingIntent — lightweight DTO shape used before a full transfer is persisted
// (UI layer creates this, API turns it into a FundingTransfer in state 'draft').
// =============================================================================
export const FundingIntent = z.object({
  destinationId: Uuid,
  sourceId: Uuid.nullable().optional(),
  portfolioId: Uuid.nullable().optional(),
  currency: z.string().length(3),
  amount: DecimalString,
  method: FundingTransferMethod,
  expectedSettlementDate: z.string().date().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  linkGoalId: Uuid.nullable().optional(),
});
export type FundingIntent = z.infer<typeof FundingIntent>;
