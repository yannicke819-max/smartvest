import { z } from 'zod';

const Uuid = z.string().uuid();
const Decimal = z.string().regex(/^\d+(\.\d+)?$/, 'Montant invalide (décimal positif requis)');
const Currency = z.string().length(3);

export const CreateReservationSchema = z.object({
  destinationId: Uuid,
  currency: Currency,
  amount: Decimal,
  reason: z.string().min(1).max(200),
  goalId: Uuid.optional(),
  proposalId: Uuid.optional(),
  planId: Uuid.optional(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateReservationDto = z.infer<typeof CreateReservationSchema>;

export const ListLedgerQuerySchema = z.object({
  destinationId: Uuid.optional(),
  currency: Currency.optional(),
  movementType: z
    .enum([
      'deposit',
      'withdrawal',
      'transfer_in',
      'transfer_out',
      'settlement_credit',
      'settlement_debit',
      'reservation',
      'reservation_release',
      'adjustment',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLedgerQueryDto = z.infer<typeof ListLedgerQuerySchema>;

export const ListReservationsQuerySchema = z.object({
  destinationId: Uuid.optional(),
  status: z.enum(['active', 'released', 'consumed']).optional(),
  goalId: Uuid.optional(),
});
export type ListReservationsQueryDto = z.infer<typeof ListReservationsQuerySchema>;
