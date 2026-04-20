import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const RiskProfileId = z.enum([
  'prudent',
  'equilibre',
  'dynamique',
  'offensif',
  'sur_mesure',
]);
export type RiskProfileId = z.infer<typeof RiskProfileId>;

export const User = z.object({
  id: Uuid,
  email: z.string().email(),
  displayName: z.string().nullable(),
  locale: z.string().default('fr-FR'),
  baseCurrency: z.string().length(3).default('EUR'),
  riskProfile: RiskProfileId.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;
