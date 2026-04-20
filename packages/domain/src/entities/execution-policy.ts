import { z } from 'zod';
import { Uuid, CurrencyCode } from '@smartvest/shared-types';
import { DelegationMode } from '@smartvest/shared-types';

/**
 * ExecutionPolicy defines HOW autonomous execution should behave when triggered.
 * It is attached to a mandate and governs timing, order types, and retry logic.
 * Does not override MandateGuardrail caps — both must be satisfied.
 */
export const OrderType = z.enum([
  'market',         // Execute at best available price
  'limit',          // Execute only at or better than limit_price_offset_pct
  'limit_post_only', // Limit order, never taker
]);
export type OrderType = z.infer<typeof OrderType>;

export const ExecutionTiming = z.enum([
  'immediate',          // Execute as soon as mandate conditions are met
  'market_open',        // Execute at next market open
  'market_close',       // Execute at next market close
  'next_business_day',  // Execute on next business day open
]);
export type ExecutionTiming = z.infer<typeof ExecutionTiming>;

export const KillSwitchState = z.object({
  active: z.boolean(),
  reason: z.string().nullable(),
  triggeredBy: z.enum(['user', 'stop_loss', 'system', 'expiry']).nullable(),
  triggeredAt: z.string().datetime().nullable(),
  canResume: z.boolean(),
});
export type KillSwitchState = z.infer<typeof KillSwitchState>;

export const ExecutionPolicy = z.object({
  id: Uuid,
  mandateId: Uuid,
  delegationMode: DelegationMode,

  orderType: OrderType,
  // For limit orders: max acceptable slippage as % above/below mid
  limitPriceOffsetPct: z.number().min(0).max(10).nullable(),

  timing: ExecutionTiming,

  // Retry policy on execution failure
  maxRetries: z.number().int().min(0).max(5).default(2),
  retryDelaySeconds: z.number().int().min(0).default(30),

  // Currency used for notional calculations in this policy
  notionalCurrency: CurrencyCode,

  // Whether partial fills are acceptable
  allowPartialFill: z.boolean().default(false),

  // Minimum fill ratio before considering execution failed (0–1)
  minFillRatio: z.number().min(0).max(1).default(1),

  killSwitch: KillSwitchState,

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

export const DEFAULT_EXECUTION_POLICY: Omit<ExecutionPolicy, 'id' | 'mandateId' | 'createdAt' | 'updatedAt'> = {
  delegationMode: 'AUTONOMOUS_GUARDED',
  orderType: 'limit',
  limitPriceOffsetPct: 0.5,
  timing: 'market_open',
  maxRetries: 2,
  retryDelaySeconds: 60,
  notionalCurrency: 'EUR',
  allowPartialFill: false,
  minFillRatio: 1,
  killSwitch: {
    active: false,
    reason: null,
    triggeredBy: null,
    triggeredAt: null,
    canResume: true,
  },
};
