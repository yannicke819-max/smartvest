import { DEFAULT_FLAGS, type FeatureFlags, type FeatureFlagKey } from '@smartvest/shared-types';
import { publicEnv } from './env';

const truthy = (v: string) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/**
 * Front-end view of feature flags. Only flags exposed via NEXT_PUBLIC_* are
 * reachable client-side; everything else falls back to DEFAULT_FLAGS values.
 * Runtime / execution decisions live on the API and must NOT be inferred here.
 */
export function readFeatureFlags(): FeatureFlags {
  return {
    ...DEFAULT_FLAGS,
    PERSONAL_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_PERSONAL_MODE),
    SAFE_PUBLIC_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE),
    REGULATED_MODE: truthy(publicEnv.NEXT_PUBLIC_FEATURE_REGULATED_MODE),
    HYPER_TRADING_UI_ENABLED: truthy(publicEnv.NEXT_PUBLIC_FEATURE_HYPER_TRADING_UI_ENABLED),
  };
}

export function isEnabled(key: FeatureFlagKey, flags: FeatureFlags = readFeatureFlags()): boolean {
  return flags[key] ?? DEFAULT_FLAGS[key];
}
