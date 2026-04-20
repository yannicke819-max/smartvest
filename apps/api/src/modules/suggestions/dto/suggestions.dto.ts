import { z } from 'zod';

export const ApproveProposalSchema = z.object({
  note: z.string().max(1000).optional(),
  modifiedQuantity: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  modifiedNotional: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
});
export type ApproveProposalDto = z.infer<typeof ApproveProposalSchema>;

export const RejectProposalSchema = z.object({
  note: z.string().max(1000).optional(),
});
export type RejectProposalDto = z.infer<typeof RejectProposalSchema>;

export const CancelProposalSchema = z.object({
  reason: z.string().max(1000).optional(),
});
export type CancelProposalDto = z.infer<typeof CancelProposalSchema>;

export const ListProposalsQuerySchema = z.object({
  portfolioId: z.string().uuid().optional(),
  lifecycleState: z.enum(['draft', 'presented', 'approved', 'rejected', 'expired', 'executed', 'cancelled']).optional(),
  kind: z.enum(['information', 'simulation', 'suggestion', 'execution_intent', 'execution']).optional(),
  action: z.enum(['buy', 'sell', 'rebalance', 'contribute', 'withdraw', 'fx', 'other']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type ListProposalsQuery = z.infer<typeof ListProposalsQuerySchema>;
