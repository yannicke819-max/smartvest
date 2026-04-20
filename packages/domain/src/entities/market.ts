import { z } from 'zod';
import { Uuid, Mic, CurrencyCode } from '@smartvest/shared-types';

export const Market = z.object({
  id: Uuid,
  mic: Mic,
  name: z.string(),
  country: z.string().length(2),
  currency: CurrencyCode,
  timezone: z.string(),
  isActive: z.boolean().default(true),
});
export type Market = z.infer<typeof Market>;
