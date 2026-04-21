import { z } from 'zod';
import { OperatingTempo, RiskIntensityLevel, DelegationMode } from '@smartvest/shared-types';
import { HyperTradingGuardrail } from '@smartvest/domain';

// ---------------------------------------------------------------------------
// Strategy mode selection (lightweight cousin of profile)
// ---------------------------------------------------------------------------
export const SelectStrategyModeSchema = z.object({
  tempo: OperatingTempo,
  portfolioId: z.string().uuid().nullable().optional(),
});
export type SelectStrategyModeDto = z.infer<typeof SelectStrategyModeSchema>;

// ---------------------------------------------------------------------------
// Profile creation / update
// ---------------------------------------------------------------------------
export const ConfigureHyperTradingSchema = z.object({
  portfolioId: z.string().uuid().nullable().optional(),
  mandateId: z.string().uuid().nullable().optional(),
  tempo: OperatingTempo.default('HYPER_ACTIVE'),
  riskLevel: RiskIntensityLevel.default('very_high'),
  delegationMode: DelegationMode.default('MANUAL_EXPLICIT'),
  windowTimezone: z.string().min(1).default('Europe/Paris'),
  expiresAt: z.string().datetime(),
  guardrail: HyperTradingGuardrail.optional(),
});
export type ConfigureHyperTradingDto = z.infer<typeof ConfigureHyperTradingSchema>;

export const UpdateGuardrailSchema = HyperTradingGuardrail.partial();
export type UpdateGuardrailDto = z.infer<typeof UpdateGuardrailSchema>;

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------
export const PauseProfileSchema = z.object({
  reason: z.string().min(1).max(280).optional(),
});
export type PauseProfileDto = z.infer<typeof PauseProfileSchema>;

export const ResumeProfileSchema = z.object({
  reason: z.string().min(1).max(280).optional(),
});
export type ResumeProfileDto = z.infer<typeof ResumeProfileSchema>;

export const KillSwitchSchema = z.object({
  reason: z.string().min(1).max(280),
});
export type KillSwitchDto = z.infer<typeof KillSwitchSchema>;

// ---------------------------------------------------------------------------
// Trading windows
// ---------------------------------------------------------------------------
export const CreateWindowSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  startLocal: z.string().regex(/^\d{2}:\d{2}$/),
  endLocal: z.string().regex(/^\d{2}:\d{2}$/),
});
export type CreateWindowDto = z.infer<typeof CreateWindowSchema>;

// ---------------------------------------------------------------------------
// Listing filters
// ---------------------------------------------------------------------------
export const ListAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListAuditQueryDto = z.infer<typeof ListAuditQuerySchema>;
