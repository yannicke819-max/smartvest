import { z } from 'zod';

export const FeatureFlagKey = z.enum([
  // Product access modes
  'PERSONAL_MODE',
  'SAFE_PUBLIC_MODE',
  'REGULATED_MODE',
  // Delegation modes — correspond to DelegationMode enum
  // Also aliased as MANUAL_MODE_ENABLED / HYBRID_MODE_ENABLED / AUTONOMOUS_MODE_ENABLED
  'DELEGATION_MANUAL_EXPLICIT',
  'DELEGATION_HYBRID_SUGGESTIVE',
  'DELEGATION_AUTONOMOUS_GUARDED',
  // Autonomy safety controls
  'AUTONOMY_KILL_SWITCH',           // Global kill-switch: suspends ALL autonomous execution
  // Broker integration modes
  'BROKER_EXECUTION_ENABLED',       // Allows real order submission (requires valid mandate)
  'READ_ONLY_BROKER_SYNC_ENABLED',  // Allows read-only data import from broker APIs
  // Hyper-trading personal mode (opt-in, strictly off by default)
  'HYPER_TRADING_MODE_ENABLED',     // Master gate — exposes the hyper-trading concept
  'HYPER_TRADING_UI_ENABLED',       // Renders the configuration / status UI
  'HYPER_TRADING_RUNTIME_ENABLED',  // Runtime policy engine evaluates intents at runtime
  'HYPER_TRADING_EXECUTION_ENABLED',// Even with the above, real execution stays off unless this is true
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKey>;

export const FeatureFlags = z.object({
  // Product access modes
  PERSONAL_MODE: z.boolean(),
  SAFE_PUBLIC_MODE: z.boolean(),
  REGULATED_MODE: z.boolean(),
  // Delegation modes
  DELEGATION_MANUAL_EXPLICIT: z.boolean(),
  DELEGATION_HYBRID_SUGGESTIVE: z.boolean(),
  DELEGATION_AUTONOMOUS_GUARDED: z.boolean(),
  // Autonomy safety controls
  AUTONOMY_KILL_SWITCH: z.boolean(),
  // Broker integration modes
  BROKER_EXECUTION_ENABLED: z.boolean(),
  READ_ONLY_BROKER_SYNC_ENABLED: z.boolean(),
  // Hyper-trading personal mode
  HYPER_TRADING_MODE_ENABLED: z.boolean(),
  HYPER_TRADING_UI_ENABLED: z.boolean(),
  HYPER_TRADING_RUNTIME_ENABLED: z.boolean(),
  HYPER_TRADING_EXECUTION_ENABLED: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlags>;

/** Convenience aliases matching the user-facing flag naming convention */
export type ManualModeEnabled = FeatureFlags['DELEGATION_MANUAL_EXPLICIT'];
export type HybridModeEnabled = FeatureFlags['DELEGATION_HYBRID_SUGGESTIVE'];
export type AutonomousModeEnabled = FeatureFlags['DELEGATION_AUTONOMOUS_GUARDED'];

export const DEFAULT_FLAGS: FeatureFlags = {
  PERSONAL_MODE: true,
  SAFE_PUBLIC_MODE: false,
  REGULATED_MODE: false,
  // Only MANUAL_EXPLICIT active by default — autonomy requires explicit opt-in
  DELEGATION_MANUAL_EXPLICIT: true,
  DELEGATION_HYBRID_SUGGESTIVE: false,
  DELEGATION_AUTONOMOUS_GUARDED: false,
  // Kill-switch off by default (it's a safety override, not the normal state)
  AUTONOMY_KILL_SWITCH: false,
  // No real broker execution by default
  BROKER_EXECUTION_ENABLED: false,
  READ_ONLY_BROKER_SYNC_ENABLED: false,
  // Hyper-trading is strictly opt-in. Master gate, UI and runtime are all off
  // by default; execution stays off even when the rest is on.
  HYPER_TRADING_MODE_ENABLED: false,
  HYPER_TRADING_UI_ENABLED: false,
  HYPER_TRADING_RUNTIME_ENABLED: false,
  HYPER_TRADING_EXECUTION_ENABLED: false,
};
