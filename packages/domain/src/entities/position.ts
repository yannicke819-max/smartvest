import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';

export const Position = z.object({
  id: Uuid,
  accountId: Uuid,
  assetId: Uuid,
  quantity: z.string().regex(/^-?\d+(\.\d+)?$/),
  averageCost: MoneyAmount,
  costCurrency: CurrencyCode,
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type Position = z.infer<typeof Position>;
