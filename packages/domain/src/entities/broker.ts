import { z } from 'zod';
import { Uuid, CurrencyCode, MoneyAmount } from '@smartvest/shared-types';

export const BrokerKind = z.enum([
  'manual',
  'api_readonly',
  'api_execution',
]);
export type BrokerKind = z.infer<typeof BrokerKind>;

export const FeeSchedule = z.object({
  // Montants fixes et variables des frais d'exécution — exprimés en devise natif du broker.
  fixedPerOrder: MoneyAmount.default('0'),
  percentOfNotional: z.string().regex(/^-?\d+(\.\d+)?$/).default('0'),
  minPerOrder: MoneyAmount.nullable(),
  maxPerOrder: MoneyAmount.nullable(),
  fxMarkupPct: z.string().regex(/^-?\d+(\.\d+)?$/).default('0'),
  currency: CurrencyCode,
});
export type FeeSchedule = z.infer<typeof FeeSchedule>;

export const Broker = z.object({
  id: Uuid,
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  kind: BrokerKind,
  country: z.string().length(2),
  supportedCurrencies: z.array(CurrencyCode),
  feeSchedule: FeeSchedule.nullable(),
  isActive: z.boolean().default(true),
});
export type Broker = z.infer<typeof Broker>;
