import { z } from 'zod';
import { MoneyAmount, CurrencyCode } from '@smartvest/shared-types';

/**
 * HyperTradingGuardrail — superset of MandateGuardrail with intraday-grade caps.
 *
 * Always coexists with — never replaces — the underlying MandateGuardrail.
 * Where both define a similar cap (e.g. maxSingleTradePct), the *stricter* of
 * the two applies at runtime. This is intentional: turning hyper-trading on
 * must only ever tighten, never relax, the existing safety envelope.
 *
 * All percentage fields use the 0–100 convention (not 0–1).
 * Basis-point fields (spread, slippage) use the standard "1bp = 0.01%".
 */
export const HyperTradingGuardrail = z.object({
  // ── Rate limits ──────────────────────────────────────────────────────────
  /** Hard cap on number of executed trades per UTC calendar day. */
  maxTradesPerDay: z.number().int().min(0),
  /** Cooldown enforced between any two consecutive executions. */
  cooldownMinutesBetweenTrades: z.number().min(0),
  /** Triggered analyses cannot exceed this cadence. */
  reviewEveryNMinutes: z.number().int().min(1),

  // ── Sizing caps (% of portfolio market value) ─────────────────────────────
  maxNotionalPerTradePct: z.number().min(0).max(100),
  maxDailyNotionalPct: z.number().min(0).max(100),
  maxExposurePerInstrumentPct: z.number().min(0).max(100),
  maxExposurePerAssetClassPct: z.number().min(0).max(100),
  maxExposurePerSectorPct: z.number().min(0).max(100),

  // ── Absolute caps (optional hardcaps regardless of %) ────────────────────
  maxNotionalPerTradeAbs: MoneyAmount.nullable(),
  maxDailyNotionalAbs: MoneyAmount.nullable(),
  notionalCurrency: CurrencyCode,

  // ── Position caps ────────────────────────────────────────────────────────
  maxOpenPositions: z.number().int().min(1),

  // ── Loss / drawdown safety ───────────────────────────────────────────────
  maxDailyLossPct: z.number().min(0).max(100),
  maxIntradayDrawdownPct: z.number().min(0).max(100),
  /** Mandatory stop-loss applied on every opened position (% from entry). */
  mandatoryStopLossPct: z.number().min(0).max(100),
  /** Optional take-profit (% from entry). null = not configured. */
  optionalTakeProfitPct: z.number().min(0).max(1000).nullable(),

  // ── Quality-of-execution gating ──────────────────────────────────────────
  /** Refuse execution if observed spread exceeds this many basis points. */
  maximumAllowedSpreadBps: z.number().min(0),
  /** Refuse execution if simulated slippage exceeds this many basis points. */
  maximumAllowedSlippageBps: z.number().min(0),
  /** Refuse execution if estimated daily liquidity is below this notional. */
  minimumExpectedLiquidityAbs: MoneyAmount,
  /** Refuse execution above this realised volatility (annualised %). */
  maxAcceptableVolatilityPct: z.number().min(0).max(1000),

  // ── Allow / deny lists ───────────────────────────────────────────────────
  allowedAssetClasses: z.array(z.string()).min(1),
  deniedTickers: z.array(z.string()),

  // ── Human-in-the-loop floor ──────────────────────────────────────────────
  /** Any single trade above this absolute notional requires sync human approval. */
  requiredHumanApprovalAboveAbs: MoneyAmount.nullable(),

  // ── Kill-switch triggers (auto) ──────────────────────────────────────────
  killSwitchOnAbnormalLoss: z.boolean(),
  killSwitchOnDataProviderFailure: z.boolean(),
  killSwitchOnBrokerSyncMismatch: z.boolean(),
  killSwitchOnVolatilityShock: z.boolean(),
});
export type HyperTradingGuardrail = z.infer<typeof HyperTradingGuardrail>;

/**
 * Default guardrail tuned for *very* defensive hyper-trading.
 * The user must explicitly relax (or tighten further) any value before
 * activating — there is no implicit aggressive default.
 */
export const DEFAULT_HYPER_TRADING_GUARDRAIL: HyperTradingGuardrail = {
  maxTradesPerDay: 10,
  cooldownMinutesBetweenTrades: 5,
  reviewEveryNMinutes: 5,

  maxNotionalPerTradePct: 2,
  maxDailyNotionalPct: 10,
  maxExposurePerInstrumentPct: 5,
  maxExposurePerAssetClassPct: 30,
  maxExposurePerSectorPct: 25,

  maxNotionalPerTradeAbs: null,
  maxDailyNotionalAbs: null,
  notionalCurrency: 'EUR',

  maxOpenPositions: 10,

  maxDailyLossPct: 2,
  maxIntradayDrawdownPct: 3,
  mandatoryStopLossPct: 2,
  optionalTakeProfitPct: null,

  maximumAllowedSpreadBps: 30,    // 0.30%
  maximumAllowedSlippageBps: 25,  // 0.25%
  minimumExpectedLiquidityAbs: '1000000',
  maxAcceptableVolatilityPct: 60,

  allowedAssetClasses: ['etf', 'equity'],
  deniedTickers: [],

  requiredHumanApprovalAboveAbs: null,

  killSwitchOnAbnormalLoss: true,
  killSwitchOnDataProviderFailure: true,
  killSwitchOnBrokerSyncMismatch: true,
  killSwitchOnVolatilityShock: true,
};
