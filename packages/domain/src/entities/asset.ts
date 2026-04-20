import { z } from 'zod';
import { Uuid, Isin, Ticker, CurrencyCode } from '@smartvest/shared-types';

export const AssetClass = z.enum([
  'equity',
  'etf',
  'bond',
  'fund',
  'cash',
  'crypto',
  'commodity',
  'derivative',
  'other',
]);
export type AssetClass = z.infer<typeof AssetClass>;

export const Asset = z.object({
  id: Uuid,
  isin: Isin.nullable(),
  ticker: Ticker,
  name: z.string(),
  assetClass: AssetClass,
  currency: CurrencyCode,
  marketId: Uuid.nullable(),
  sector: z.string().nullable(),
  country: z.string().length(2).nullable(),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Asset = z.infer<typeof Asset>;
