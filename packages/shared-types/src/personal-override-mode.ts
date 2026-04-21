import { z } from 'zod';

/**
 * PersonalOverrideMode — light personal layer sitting ABOVE DelegationMode
 * and OperatingTempo. Does not alter the delegation rules; only adjusts the
 * UX/cadence intensity when the user manually unlocks it.
 *
 *   STANDARD       — default. No personal override active.
 *   SNIPER_LOCKED  — user has previously used sniper but session expired/revoked.
 *                    Same behavior as STANDARD; UI can surface a "re-unlock" affordance.
 *   SNIPER_ACTIVE  — an unlocked, non-expired sniper session exists for the user.
 *                    Other modules MAY read this flag to increase review cadence
 *                    or shorten horizons — never to bypass safety checks.
 */
export const PersonalOverrideMode = z.enum([
  'STANDARD',
  'SNIPER_LOCKED',
  'SNIPER_ACTIVE',
]);
export type PersonalOverrideMode = z.infer<typeof PersonalOverrideMode>;

/**
 * SniperSessionStatus — session lifecycle.
 *   unlocked — currently active until expires_at
 *   expired  — past expires_at, no explicit revocation
 *   revoked  — manually deactivated by user
 */
export const SniperSessionStatus = z.enum(['unlocked', 'expired', 'revoked']);
export type SniperSessionStatus = z.infer<typeof SniperSessionStatus>;

export const SniperUnlockMethod = z.enum(['local_code']);
export type SniperUnlockMethod = z.infer<typeof SniperUnlockMethod>;

export const DEFAULT_SNIPER_TTL_MINUTES = 15;
