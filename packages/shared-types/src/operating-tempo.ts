import { z } from 'zod';

/**
 * OperatingTempo — opt-in personal operating cadence applied on top of
 * the existing DelegationMode. Always paired with — never replacing — a
 * DelegationMode. This dimension governs HOW OFTEN SmartVest analyses,
 * proposes and (when permitted) executes; the DelegationMode still governs
 * WHO acts (user vs. autonomy-with-mandate).
 *
 *   LONG_HORIZON  — default. Buy-and-hold cadence, low-frequency review.
 *   ACTIVE        — frequent review, swing-trading horizon, daily-ish suggestions.
 *   HYPER_ACTIVE  — high-intensity personal mode. Strict guardrails, kill-switch,
 *                   intraday horizon. Strictly opt-in. Reinforces — never relaxes
 *                   — the underlying delegation safety doctrine.
 */
export const OperatingTempo = z.enum([
  'LONG_HORIZON',
  'ACTIVE',
  'HYPER_ACTIVE',
]);
export type OperatingTempo = z.infer<typeof OperatingTempo>;

/**
 * RiskIntensityLevel — coarse risk descriptor surfaced in the UI alongside the tempo.
 * Used for badging and disclosure, not for runtime checks (those live in guardrails).
 */
export const RiskIntensityLevel = z.enum([
  'low',
  'moderate',
  'high',
  'very_high',
]);
export type RiskIntensityLevel = z.infer<typeof RiskIntensityLevel>;

export const DEFAULT_OPERATING_TEMPO: OperatingTempo = 'LONG_HORIZON';

/**
 * Indicative review cadence per tempo (in minutes). The runtime
 * HyperTradingPolicyEngine reads this when evaluating whether a new
 * suggestion or intent is allowed to be presented.
 */
export const TEMPO_REVIEW_INTERVAL_MINUTES: Record<OperatingTempo, number> = {
  LONG_HORIZON: 60 * 24, // daily
  ACTIVE: 60,            // hourly
  HYPER_ACTIVE: 5,       // every 5 minutes
};

/**
 * Indicative risk descriptor per tempo — UI hint only.
 */
export const TEMPO_RISK_LEVEL: Record<OperatingTempo, RiskIntensityLevel> = {
  LONG_HORIZON: 'low',
  ACTIVE: 'moderate',
  HYPER_ACTIVE: 'very_high',
};
