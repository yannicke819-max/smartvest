import { z } from 'zod';
import { Uuid, CurrencyCode } from '@smartvest/shared-types';

export const AccountKind = z.enum([
  'cash',
  'brokerage',
  'pea',
  'ira',
  'crypto_exchange',
  'wallet',
  'other',
]);
export type AccountKind = z.infer<typeof AccountKind>;

export const PortfolioAccount = z.object({
  id: Uuid,
  portfolioId: Uuid,
  brokerId: Uuid.nullable(),
  kind: AccountKind,
  label: z.string(),
  accountCurrency: CurrencyCode,
  externalRef: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PortfolioAccount = z.infer<typeof PortfolioAccount>;
