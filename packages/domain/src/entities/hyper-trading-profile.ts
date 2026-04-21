import { z } from 'zod';
import { Uuid, OperatingTempo, RiskIntensityLevel, DelegationMode } from '@smartvest/shared-types';
import { HyperTradingGuardrail } from './hyper-trading-guardrail';

/**
 * HyperTradingProfile — per-user / per-portfolio configuration of the
 * hyper-trading personal mode. Activation is strictly opt-in; deactivation
 * (kill-switch) is always one click away.
 */
export const HyperTradingProfileStatus = z.enum([
  'draft',     // User is editing — no runtime effect
  'active',    // Runtime evaluator is live within the configured tempo windows
  'paused',    // Temporarily suspended (manual or auto-trigger), resumable
  'killed',    // Hard stop — must be re-armed explicitly to resume
  'archived',  // Disabled and retired — kept for audit only
]);
export type HyperTradingProfileStatus = z.infer<typeof HyperTradingProfileStatus>;

/**
 * HyperTradingTradingWindow — declarative time-of-day window during which
 * the runtime engine is allowed to surface intraday suggestions. Outside any
 * configured window, the engine refuses to act regardless of tempo.
 */
export const HyperTradingWindow = z.object({
  /** ISO weekday (1=Monday … 7=Sunday). */
  weekday: z.number().int().min(1).max(7),
  /** "HH:MM" 24h, exchange-local timezone configured at the profile level. */
  startLocal: z.string().regex(/^\d{2}:\d{2}$/),
  endLocal: z.string().regex(/^\d{2}:\d{2}$/),
});
export type HyperTradingWindow = z.infer<typeof HyperTradingWindow>;

export const HyperTradingProfile = z.object({
  id: Uuid,
  userId: Uuid,
  /** Optional — when null the profile applies user-wide. */
  portfolioId: Uuid.nullable(),
  /** Optional link to an AutonomyMandate. Required to ever permit autonomous execution. */
  mandateId: Uuid.nullable(),

  status: HyperTradingProfileStatus,
  tempo: OperatingTempo,
  riskLevel: RiskIntensityLevel,

  /**
   * The DelegationMode this profile is paired with. The compatibility matrix:
   *   MANUAL_EXPLICIT     + HYPER_ACTIVE → high-frequency analysis only, full human action
   *   HYBRID_SUGGESTIVE   + HYPER_ACTIVE → high-frequency suggestions, explicit per-action validation
   *   AUTONOMOUS_GUARDED  + HYPER_ACTIVE → permitted only with valid mandate + reinforced guardrails
   */
  delegationMode: DelegationMode,

  guardrail: HyperTradingGuardrail,

  /** Activity windows — empty list = always-on (within tempo cadence). */
  windows: z.array(HyperTradingWindow),
  /** IANA timezone used to interpret window boundaries. */
  windowTimezone: z.string().min(1),

  // ── Lifecycle timestamps ─────────────────────────────────────────────────
  activatedAt: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  killedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),

  /** Mandatory expiry — no permanent activation. */
  expiresAt: z.string().datetime(),

  /** Strict kill-switch: when true, runtime refuses ALL evaluations. */
  killSwitchActive: z.boolean(),

  // ── Cumulative observability fields ──────────────────────────────────────
  totalSessionsOpened: z.number().int().min(0),
  totalSuggestionsEmitted: z.number().int().min(0),
  totalIntentsApproved: z.number().int().min(0),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HyperTradingProfile = z.infer<typeof HyperTradingProfile>;

/**
 * Returns null if the profile currently permits a runtime evaluation,
 * or a string reason if blocked. Mirrors checkMandatePermission() shape so
 * that callers can compose both checks identically.
 */
export function checkHyperTradingProfilePermission(
  profile: HyperTradingProfile,
  now: Date = new Date(),
): string | null {
  if (profile.killSwitchActive) return 'kill-switch hyper-trading actif';
  if (profile.status !== 'active') return `profil hyper-trading non actif (statut: ${profile.status})`;
  if (new Date(profile.expiresAt) <= now) return 'profil hyper-trading expiré';
  return null;
}
