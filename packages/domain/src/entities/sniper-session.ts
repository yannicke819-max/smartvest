import { z } from 'zod';
import { Uuid, SniperSessionStatus, SniperUnlockMethod } from '@smartvest/shared-types';

/**
 * SniperSession — minimal record of a personal unlock event.
 * One row per unlock attempt that succeeded. Status transitions through
 * unlocked → expired (passive, TTL) or unlocked → revoked (explicit user action).
 * Row stays in place after termination — acts as the audit trail itself.
 */
export const SniperSession = z.object({
  id: Uuid,
  userId: Uuid,
  status: SniperSessionStatus,
  unlockMethod: SniperUnlockMethod,
  unlockedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  ttlMinutes: z.number().int().min(1).max(240),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SniperSession = z.infer<typeof SniperSession>;

/**
 * Derives the PersonalOverrideMode from the user's latest session + current time.
 * Returns `STANDARD` when no session has ever existed.
 */
export function derivePersonalOverrideMode(
  latestSession: SniperSession | null,
  now: Date = new Date(),
): 'STANDARD' | 'SNIPER_LOCKED' | 'SNIPER_ACTIVE' {
  if (!latestSession) return 'STANDARD';
  if (latestSession.status === 'unlocked' && new Date(latestSession.expiresAt) > now) {
    return 'SNIPER_ACTIVE';
  }
  return 'SNIPER_LOCKED';
}
