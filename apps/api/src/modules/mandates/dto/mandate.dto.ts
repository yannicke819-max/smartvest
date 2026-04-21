import { z } from 'zod';

export const ALLOWED_ASSET_CLASSES = [
  'equity', 'bond', 'etf', 'fund', 'commodity', 'crypto', 'real_estate', 'cash',
] as const;

export const CreateMandateSchema = z.object({
  portfolioId: z.string().uuid({ message: 'portfolioId doit être un UUID valide' }),
  label: z.string().min(3, 'label doit avoir au moins 3 caractères').max(100),
  maxPositionSizePct: z.number().min(0.1).max(100),
  maxSingleTradePct: z.number().min(0.1).max(100),
  maxDailyTradePct: z.number().min(0.1).max(100),
  maxSingleTradeNotional: z.number().positive().optional(),
  maxSingleTradeNotionalCurrency: z.string().length(3).optional(),
  allowedAssetClasses: z.array(z.enum(ALLOWED_ASSET_CLASSES)).min(1, 'Au moins une classe d\'actifs requise'),
  forbiddenTickers: z.array(z.string().min(1)).default([]),
  requiresHumanAbovePct: z.number().min(0).max(100),
  stopLossTriggerPct: z.number().min(0.1).max(50),
  maxOpenPositions: z.number().int().positive().optional(),
  expiresAt: z.string().datetime({ message: 'expiresAt doit être une date ISO 8601' }),
});

export type CreateMandateDto = z.infer<typeof CreateMandateSchema>;

export const UpdateMandateSchema = CreateMandateSchema
  .omit({ portfolioId: true })
  .partial();

export type UpdateMandateDto = z.infer<typeof UpdateMandateSchema>;
