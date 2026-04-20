import { DEFAULT_FLAGS, type FeatureFlags, type FeatureFlagKey } from '@smartvest/shared-types';
import { publicEnv } from './env';

const truthy = (v: string) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export function readFeatureFlags(): FeatureFlags {
  return {
    PERSONAL_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_PERSONAL_MODE),
    SAFE_PUBLIC_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE),
    REGULATED_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_REGULATED_MODE),
  };
}

export function isEnabled(key: FeatureFlagKey, flags: FeatureFlags = readFeatureFlags()): boolean {
  return flags[key] ?? DEFAULT_FLAGS[key];
}
