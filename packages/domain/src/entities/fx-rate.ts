import { z } from 'zod';
import { CurrencyCode } from '@smartvest/shared-types';

export const FXRate = z.object({
  base: CurrencyCode,
  quote: CurrencyCode,
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  asOf: z.string().datetime(),
  source: z.string(),
});
export type FXRate = z.infer<typeof FXRate>;
