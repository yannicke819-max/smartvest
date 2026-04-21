import { z } from 'zod';
import { BrokerProvider, BrokerCredentials, BrokerAccountType } from '@smartvest/domain';

export const CreateConnectionSchema = z.object({
  provider: BrokerProvider,
  label: z.string().min(1).max(100),
  credentials: BrokerCredentials,
});
export type CreateConnectionDto = z.infer<typeof CreateConnectionSchema>;

export const UpdateConnectionSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  // Credentials may be rotated without creating a new connection.
  credentials: BrokerCredentials.optional(),
});
export type UpdateConnectionDto = z.infer<typeof UpdateConnectionSchema>;

export const CreateBrokerAccountSchema = z.object({
  accountIdExternal: z.string().min(1),
  accountType: BrokerAccountType.default('other'),
  baseCurrency: z.string().length(3).default('EUR'),
  displayName: z.string().max(100).optional(),
});
export type CreateBrokerAccountDto = z.infer<typeof CreateBrokerAccountSchema>;
