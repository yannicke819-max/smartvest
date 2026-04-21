import { z } from 'zod';

const Uuid = z.string().uuid();
const Decimal = z.string().regex(/^\d+(\.\d+)?$/, 'Montant invalide (décimal positif requis)');
const Currency = z.string().length(3);

// ============================================================================
// Sources / Destinations
// ============================================================================
export const CreateFundingSourceSchema = z.object({
  label: z.string().min(1).max(100),
  ibanLast4: z.string().length(4).regex(/^[A-Z0-9]+$/).optional(),
  bankName: z.string().max(100).optional(),
  currency: Currency.default('EUR'),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateFundingSourceDto = z.infer<typeof CreateFundingSourceSchema>;

export const CreateFundingDestinationSchema = z.object({
  label: z.string().min(1).max(100),
  portfolioId: Uuid.optional(),
  portfolioAccountId: Uuid.optional(),
  brokerAccountRef: z.string().max(100).optional(),
  currency: Currency.default('EUR'),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateFundingDestinationDto = z.infer<typeof CreateFundingDestinationSchema>;

// ============================================================================
// Transfers
// ============================================================================
export const CreateTransferSchema = z.object({
  destinationId: Uuid,
  sourceId: Uuid.optional(),
  portfolioId: Uuid.optional(),
  portfolioAccountId: Uuid.optional(),
  method: z.enum(['bank_transfer', 'manual_record', 'broker_internal_transfer', 'cash_adjustment']),
  currency: Currency,
  requestedAmount: Decimal,
  expectedSettlementDate: z.string().date().optional(),
  note: z.string().max(500).optional(),
  linkGoalId: Uuid.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateTransferDto = z.infer<typeof CreateTransferSchema>;

// PATCH can only touch the "soft" fields while the transfer is still in draft
export const UpdateTransferSchema = z.object({
  note: z.string().max(500).optional(),
  expectedSettlementDate: z.string().date().optional(),
  requestedAmount: Decimal.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateTransferDto = z.infer<typeof UpdateTransferSchema>;

// Filters for GET /funding/transfers
export const ListTransfersQuerySchema = z.object({
  status: z
    .enum([
      'draft',
      'initiated',
      'pending_settlement',
      'settled',
      'partially_settled',
      'cancelled',
      'failed',
      'reversed',
    ])
    .optional(),
  currency: Currency.optional(),
  portfolioId: Uuid.optional(),
  method: z
    .enum(['bank_transfer', 'manual_record', 'broker_internal_transfer', 'cash_adjustment'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTransfersQueryDto = z.infer<typeof ListTransfersQuerySchema>;

// ============================================================================
// Transition bodies
// ============================================================================
export const SettleTransferSchema = z.object({
  settledAmount: Decimal.optional(), // if absent, uses requestedAmount
  settledAt: z.string().datetime().optional(),
});
export type SettleTransferDto = z.infer<typeof SettleTransferSchema>;

export const CancelTransferSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelTransferDto = z.infer<typeof CancelTransferSchema>;

export const FailTransferSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type FailTransferDto = z.infer<typeof FailTransferSchema>;

export const ReverseTransferSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type ReverseTransferDto = z.infer<typeof ReverseTransferSchema>;

// ============================================================================
// Allocation links
// ============================================================================
export const LinkTransferSchema = z.object({
  linkKind: z.enum(['goal', 'portfolio', 'plan', 'proposal']),
  goalId: Uuid.optional(),
  portfolioId: Uuid.optional(),
  planId: Uuid.optional(),
  proposalId: Uuid.optional(),
  allocatedAmount: Decimal,
  currency: Currency,
  note: z.string().max(500).optional(),
});
export type LinkTransferDto = z.infer<typeof LinkTransferSchema>;
