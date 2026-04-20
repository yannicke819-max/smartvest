import { z } from 'zod';
import { MoneyAmount, CurrencyCode } from '@smartvest/shared-types';

/**
 * Caps and restrictions enforced on every autonomous action.
 * All percentage fields are 0–100 (not 0–1).
 * Checked before any execution in AUTONOMOUS_GUARDED mode.
 */
export const MandateGuardrail = z.object({
  // Position sizing caps (% of portfolio market value)
  maxPositionSizePct: z.number().min(0).max(100),
  maxSingleTradePct: z.number().min(0).max(100),
  maxDailyTradePct: z.number().min(0).max(100),

  // Absolute notional cap per trade (optional hardcap regardless of %)
  maxSingleTradeNotional: MoneyAmount.nullable(),
  maxSingleTradeNotionalCurrency: CurrencyCode.nullable(),

  // Asset class whitelist — only these classes may be traded autonomously
  allowedAssetClasses: z.array(z.string()).min(1),

  // Ticker/ISIN blacklist — never traded regardless of other rules
  forbiddenTickers: z.array(z.string()),

  // Any action above this % of portfolio requires synchronous human validation
  requiresHumanAbovePct: z.number().min(0).max(100),

  // Portfolio drawdown % from high-water mark that triggers auto-suspension
  stopLossTriggerPct: z.number().min(0).max(100),

  // Maximum open positions allowed in autonomous mode
  maxOpenPositions: z.number().int().min(1).nullable(),
});
export type MandateGuardrail = z.infer<typeof MandateGuardrail>;

export const DEFAULT_CONSERVATIVE_GUARDRAIL: MandateGuardrail = {
  maxPositionSizePct: 10,
  maxSingleTradePct: 5,
  maxDailyTradePct: 10,
  maxSingleTradeNotional: null,
  maxSingleTradeNotionalCurrency: null,
  allowedAssetClasses: ['etf', 'equity'],
  forbiddenTickers: [],
  requiresHumanAbovePct: 3,
  stopLossTriggerPct: 15,
  maxOpenPositions: 20,
};
