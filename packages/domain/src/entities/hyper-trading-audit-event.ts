import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

/**
 * HyperTradingAuditEvent — specialised, hash-chained audit record covering
 * every state transition or guardrail decision taken by the hyper-trading
 * engine. Designed to be replayable and explainable a posteriori.
 *
 * Sits beside (not in place of) AutonomyAuditEvent. Hyper-trading events
 * MUST also propagate to the autonomy audit when they affect a mandate
 * (e.g. kill-switch propagation).
 */
export const HyperTradingAuditKind = z.enum([
  'profile_created',
  'profile_updated',
  'profile_activated',
  'profile_paused',
  'profile_resumed',
  'profile_killed',
  'profile_archived',
  'session_opened',
  'session_paused',
  'session_resumed',
  'session_closed',
  'guardrail_updated',
  'guardrail_violation_blocked',
  'guardrail_violation_warned',
  'kill_switch_armed',
  'kill_switch_disarmed',
  'window_entered',
  'window_exited',
  'risk_snapshot_recorded',
]);
export type HyperTradingAuditKind = z.infer<typeof HyperTradingAuditKind>;

export const HyperTradingAuditEvent = z.object({
  id: Uuid,
  profileId: Uuid,
  sessionId: Uuid.nullable(),
  userId: Uuid,

  kind: HyperTradingAuditKind,

  /** Free-form, user-readable explanation of why the event occurred. */
  reason: z.string().min(1),

  /** Optional structured payload (e.g. before/after values). */
  payload: z.record(z.unknown()).nullable(),

  /** Hash of `${id}|${userId}|${kind}|${reason}|${prevHash ?? ''}` */
  hash: z.string().min(1),
  prevHash: z.string().nullable(),

  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type HyperTradingAuditEvent = z.infer<typeof HyperTradingAuditEvent>;
