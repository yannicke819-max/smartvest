import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';

export const TransactionType = z.enum([
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'tax',
  'transfer_in',
  'transfer_out',
  'fx',
  'split',
  'adjustment',
]);
export type TransactionType = z.infer<typeof TransactionType>;

export const ExecutionQuality = z.object({
  // Rend visibles les frictions d'intermédiation.
  grossAmount: MoneyAmount,
  brokerFee: MoneyAmount.default('0'),
  exchangeFee: MoneyAmount.default('0'),
  taxes: MoneyAmount.default('0'),
  spreadCost: MoneyAmount.default('0'),
  slippageCost: MoneyAmount.default('0'),
  fxMarkup: MoneyAmount.default('0'),
  netAmount: MoneyAmount,
  feeCurrency: CurrencyCode,
  benchmarkPrice: MoneyAmount.nullable(),
  benchmarkSource: z.string().nullable(),
});
export type ExecutionQuality = z.infer<typeof ExecutionQuality>;

export const Transaction = z.object({
  id: Uuid,
  accountId: Uuid,
  assetId: Uuid.nullable(),
  type: TransactionType,
  tradeDate: z.string().datetime(),
  settleDate: z.string().datetime().nullable(),
  quantity: z.string().regex(/^-?\d+(\.\d+)?$/).nullable(),
  unitPrice: MoneyAmount.nullable(),
  currency: CurrencyCode,
  execution: ExecutionQuality.nullable(),
  externalRef: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Transaction = z.infer<typeof Transaction>;
