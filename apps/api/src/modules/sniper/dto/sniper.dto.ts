import { z } from 'zod';

export const UnlockSniperSchema = z.object({
  code: z.string().min(1).max(128),
  /** Override TTL (minutes). Falls back to env SNIPER_MODE_TTL_MINUTES else 15. */
  ttlMinutes: z.number().int().min(1).max(240).optional(),
});
export type UnlockSniperDto = z.infer<typeof UnlockSniperSchema>;

export const DeactivateSniperSchema = z.object({
  reason: z.string().min(1).max(280).optional(),
});
export type DeactivateSniperDto = z.infer<typeof DeactivateSniperSchema>;
