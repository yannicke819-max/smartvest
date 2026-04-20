import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';
import { MandateGuardrail } from './mandate-guardrail';

/**
 * An AutonomyMandate is a user-created, time-bounded authorisation for SmartVest
 * to act autonomously within strictly defined guardrails.
 *
 * One may only be active per portfolio at a time.
 * It cannot be created programmatically — only by explicit user action.
 * It expires automatically and can be killed instantly via killSwitchActive.
 */
export const MandateStatus = z.enum([
  'pending_activation', // Created, not yet confirmed by user
  'active',             // Fully active, autonomous actions permitted within guardrails
  'suspended',          // Paused (kill-switch or stop-loss trigger), resumable
  'expired',            // Past expiresAt — no actions possible
  'revoked',            // Permanently revoked by user — cannot be reactivated
]);
export type MandateStatus = z.infer<typeof MandateStatus>;

export const AutonomyMandate = z.object({
  id: Uuid,
  portfolioId: Uuid,
  userId: Uuid,

  status: MandateStatus,

  // Human-readable label set by user when creating the mandate
  label: z.string().min(1).max(100),

  guardrail: MandateGuardrail,

  // Mandate window — expiresAt is mandatory, no permanent mandates
  activatedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  suspendedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),

  // Instant kill-switch — setting true suspends all autonomous execution immediately
  killSwitchActive: z.boolean().default(false),

  // Cumulative stats tracked on every autonomous action
  totalActionsExecuted: z.number().int().min(0).default(0),
  totalNotionalTraded: z.string().regex(/^\d+(\.\d+)?$/).default('0'),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutonomyMandate = z.infer<typeof AutonomyMandate>;

/**
 * Validates whether a mandate permits execution right now.
 * Returns null if permitted, or a reason string if blocked.
 */
export function checkMandatePermission(mandate: AutonomyMandate): string | null {
  if (mandate.killSwitchActive) return 'kill-switch actif';
  if (mandate.status !== 'active') return `mandat non actif (statut: ${mandate.status})`;
  const now = new Date();
  if (new Date(mandate.expiresAt) <= now) return 'mandat expiré';
  return null;
}
