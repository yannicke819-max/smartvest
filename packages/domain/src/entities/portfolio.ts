import { z } from 'zod';
import { Uuid, CurrencyCode } from '@smartvest/shared-types';

export const Portfolio = z.object({
  id: Uuid,
  userId: Uuid,
  name: z.string().min(1).max(120),
  baseCurrency: CurrencyCode,
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Portfolio = z.infer<typeof Portfolio>;
