import { z } from 'zod';

export const FeatureFlagKey = z.enum([
  'PERSONAL_MODE',
  'SAFE_PUBLIC_MODE',
  'REGULATED_MODE',
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKey>;

export const FeatureFlags = z.object({
  PERSONAL_MODE: z.boolean(),
  SAFE_PUBLIC_MODE: z.boolean(),
  REGULATED_MODE: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlags>;

export const DEFAULT_FLAGS: FeatureFlags = {
  PERSONAL_MODE: true,
  SAFE_PUBLIC_MODE: false,
  REGULATED_MODE: false,
};
