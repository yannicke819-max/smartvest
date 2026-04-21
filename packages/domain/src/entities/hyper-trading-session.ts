import { z } from 'zod';
import { Uuid, MoneyAmount, CurrencyCode } from '@smartvest/shared-types';

/**
 * HyperTradingSession — bounded period of activity opened by the engine
 * (or the user) under a HyperTradingProfile. Tracks counters used by the
 * runtime guardrail evaluator (trade count, realised P&L, drawdown…) and
 * gets closed at the end of the day or on pause/kill events.
 */
export const HyperTradingSessionStatus = z.enum([
  'open',
  'paused',
  'closed',
  'killed',
]);
export type HyperTradingSessionStatus = z.infer<typeof HyperTradingSessionStatus>;

export const HyperTradingPauseReason = z.enum([
  'manual_user_pause',
  'cooldown_breached',
  'daily_loss_breached',
  'intraday_drawdown_breached',
  'volatility_shock',
  'data_provider_failure',
  'broker_sync_mismatch',
  'window_closed',
  'kill_switch',
  'mandate_invalid',
]);
export type HyperTradingPauseReason = z.infer<typeof HyperTradingPauseReason>;

export const HyperTradingRiskSnapshot = z.object({
  /** Realised P&L since session open. */
  realisedPnl: MoneyAmount,
  /** Unrealised P&L from open positions at snapshot time. */
  unrealisedPnl: MoneyAmount,
  /** Peak-to-trough drawdown observed in-session. */
  observedDrawdownPct: z.number().min(0).max(100),
  /** Number of trades executed in-session. */
  tradesExecuted: z.number().int().min(0),
  /** Notional traded in-session. */
  notionalTraded: MoneyAmount,
  /** Annualised realised volatility observed on the universe being traded. */
  observedVolatilityPct: z.number().min(0).max(1000),
  /** Currency for monetary fields above. */
  currency: CurrencyCode,
  capturedAt: z.string().datetime(),
});
export type HyperTradingRiskSnapshot = z.infer<typeof HyperTradingRiskSnapshot>;

export const HyperTradingSession = z.object({
  id: Uuid,
  profileId: Uuid,
  userId: Uuid,
  portfolioId: Uuid.nullable(),

  status: HyperTradingSessionStatus,

  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  pausedAt: z.string().datetime().nullable(),
  pauseReason: HyperTradingPauseReason.nullable(),

  /** Latest snapshot — refreshed on every guardrail evaluation. */
  latestSnapshot: HyperTradingRiskSnapshot.nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HyperTradingSession = z.infer<typeof HyperTradingSession>;
