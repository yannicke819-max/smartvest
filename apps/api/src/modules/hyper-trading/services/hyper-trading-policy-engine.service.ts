import { Injectable } from '@nestjs/common';
import {
  checkHyperTradingProfilePermission,
  checkMandatePermission,
  type HyperTradingProfile,
  type HyperTradingGuardrail,
  type AutonomyMandate,
  type HyperTradingWindow,
} from '@smartvest/domain';

/**
 * The decision returned for every evaluation request.
 * NEVER returns "execute" implicitly — `permitted` only reflects whether
 * the chain of guardrails accepts the action *as a candidate*.
 * Real execution still depends on flags, mandate and broker layer.
 */
export interface HyperTradingDecision {
  permitted: boolean;
  decision: 'allow' | 'block' | 'require_review' | 'kill_switch';
  /** Ordered list of reasons (audit-friendly). First = most blocking. */
  reasons: string[];
  /** Flags collected from the evaluation, surfaced to UI. */
  signals: {
    insideWindow: boolean;
    cooldownRespected: boolean;
    dailyTradesUnderCap: boolean;
    notionalUnderCap: boolean;
    spreadAcceptable: boolean | null;
    slippageAcceptable: boolean | null;
    liquiditySufficient: boolean | null;
    drawdownUnderCap: boolean | null;
    dailyLossUnderCap: boolean | null;
    volatilityAcceptable: boolean | null;
  };
}

export interface EvaluationContext {
  profile: HyperTradingProfile;
  guardrail: HyperTradingGuardrail;
  mandate: AutonomyMandate | null;
  /** Number of trades already executed today (UTC). */
  tradesToday: number;
  /** Notional already traded today (same currency as guardrail). */
  notionalTradedToday: string; // decimal as string
  /** Minutes since the last execution (Infinity if none). */
  minutesSinceLastTrade: number;
  /** Currently observed market metrics for the candidate instrument. */
  observedSpreadBps?: number;
  observedSlippageBps?: number;
  estimatedDailyLiquidityAbs?: string;
  observedAnnualisedVolatilityPct?: number;
  /** Realised intraday loss as % of portfolio (positive number). */
  realisedDailyLossPct?: number;
  /** Observed drawdown since session open (positive number). */
  observedDrawdownPct?: number;
  /** Notional of the candidate trade (absolute, same currency). */
  candidateNotionalAbs: string;
  /** Tickers/ISIN of the candidate instrument. */
  candidateTicker: string;
  /** Asset class of the candidate (must be in allowedAssetClasses). */
  candidateAssetClass: string;
  /** Wall-clock evaluation timestamp. */
  now: Date;
}

const dec = (v: string | number) => (typeof v === 'number' ? v : parseFloat(v || '0'));

/**
 * Returns true if `now` falls inside any declared window of the profile.
 * Uses the IANA timezone configured at the profile level.
 *
 * For windowing simplicity we compare against the local time string rendered
 * via Intl.DateTimeFormat — sufficient for declarative weekday windows.
 */
function isInsideAnyWindow(
  windows: HyperTradingWindow[],
  timezone: string,
  now: Date,
): boolean {
  if (windows.length === 0) return true; // empty list = always-on
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wdStr = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const isoWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wdStr) + 1;
  if (isoWeekday < 1) return false;
  const local = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
  return windows.some((w) => w.weekday === isoWeekday && local >= w.startLocal && local < w.endLocal);
}

@Injectable()
export class HyperTradingPolicyEngine {
  /**
   * Single source of truth for "is this candidate allowed under the current profile?"
   *
   * Order of checks is intentional:
   *   1. profile / mandate validity (kill-switch, status, expiry)
   *   2. windows
   *   3. allow/deny lists
   *   4. rate limits (cooldown, max trades / day)
   *   5. sizing caps (notional / day, per-trade)
   *   6. quality of execution (spread, slippage, liquidity)
   *   7. risk envelope (volatility, drawdown, daily loss)
   *   8. human-in-the-loop floor
   *
   * Any blocking reason short-circuits subsequent checks but ALL non-blocking
   * signals are still evaluated and returned, so the UI can show a complete
   * picture rather than guessing.
   */
  evaluate(
    ctx: EvaluationContext,
    windows: HyperTradingWindow[],
  ): HyperTradingDecision {
    const reasons: string[] = [];
    const signals: HyperTradingDecision['signals'] = {
      insideWindow: false,
      cooldownRespected: false,
      dailyTradesUnderCap: false,
      notionalUnderCap: false,
      spreadAcceptable: null,
      slippageAcceptable: null,
      liquiditySufficient: null,
      drawdownUnderCap: null,
      dailyLossUnderCap: null,
      volatilityAcceptable: null,
    };

    // 1. Profile permission (kill-switch / status / expiry)
    const profileBlock = checkHyperTradingProfilePermission(ctx.profile, ctx.now);
    if (profileBlock) {
      reasons.push(profileBlock);
      return {
        permitted: false,
        decision: ctx.profile.killSwitchActive ? 'kill_switch' : 'block',
        reasons,
        signals,
      };
    }

    // 1b. Mandate permission if a mandate is attached
    if (ctx.mandate) {
      const mandateBlock = checkMandatePermission(ctx.mandate);
      if (mandateBlock) {
        reasons.push(`mandat: ${mandateBlock}`);
        return { permitted: false, decision: 'block', reasons, signals };
      }
    }

    // 2. Windows
    signals.insideWindow = isInsideAnyWindow(windows, ctx.profile.windowTimezone, ctx.now);
    if (!signals.insideWindow) {
      reasons.push('hors fenêtre d\'activité configurée');
      return { permitted: false, decision: 'block', reasons, signals };
    }

    // 3. Allow / deny lists
    if (!ctx.guardrail.allowedAssetClasses.includes(ctx.candidateAssetClass)) {
      reasons.push(`classe d'actifs ${ctx.candidateAssetClass} non autorisée`);
    }
    if (ctx.guardrail.deniedTickers.includes(ctx.candidateTicker)) {
      reasons.push(`ticker ${ctx.candidateTicker} sur la liste d'interdiction`);
    }

    // 4. Rate limits
    signals.cooldownRespected = ctx.minutesSinceLastTrade >= ctx.guardrail.cooldownMinutesBetweenTrades;
    if (!signals.cooldownRespected) {
      reasons.push(
        `cooldown non respecté (${ctx.minutesSinceLastTrade.toFixed(1)} min < ${ctx.guardrail.cooldownMinutesBetweenTrades} min)`,
      );
    }
    signals.dailyTradesUnderCap = ctx.tradesToday < ctx.guardrail.maxTradesPerDay;
    if (!signals.dailyTradesUnderCap) {
      reasons.push(
        `cap de trades journalier atteint (${ctx.tradesToday} / ${ctx.guardrail.maxTradesPerDay})`,
      );
    }

    // 5. Sizing caps — absolute notional only (% caps need portfolio MV, evaluated upstream)
    const candidateNotional = dec(ctx.candidateNotionalAbs);
    const dailyTraded = dec(ctx.notionalTradedToday);
    if (ctx.guardrail.maxNotionalPerTradeAbs !== null) {
      const cap = dec(ctx.guardrail.maxNotionalPerTradeAbs);
      signals.notionalUnderCap = candidateNotional <= cap;
      if (!signals.notionalUnderCap) {
        reasons.push(`notionnel par trade > cap (${candidateNotional} > ${cap})`);
      }
    } else {
      signals.notionalUnderCap = true;
    }
    if (ctx.guardrail.maxDailyNotionalAbs !== null) {
      const cap = dec(ctx.guardrail.maxDailyNotionalAbs);
      if (dailyTraded + candidateNotional > cap) {
        reasons.push(`notionnel quotidien cumulé > cap (${dailyTraded + candidateNotional} > ${cap})`);
      }
    }

    // 6. Quality of execution (only if observed metrics are provided)
    if (ctx.observedSpreadBps !== undefined) {
      signals.spreadAcceptable = ctx.observedSpreadBps <= ctx.guardrail.maximumAllowedSpreadBps;
      if (!signals.spreadAcceptable) {
        reasons.push(
          `spread observé ${ctx.observedSpreadBps}bp > cap ${ctx.guardrail.maximumAllowedSpreadBps}bp`,
        );
      }
    }
    if (ctx.observedSlippageBps !== undefined) {
      signals.slippageAcceptable = ctx.observedSlippageBps <= ctx.guardrail.maximumAllowedSlippageBps;
      if (!signals.slippageAcceptable) {
        reasons.push(
          `slippage estimé ${ctx.observedSlippageBps}bp > cap ${ctx.guardrail.maximumAllowedSlippageBps}bp`,
        );
      }
    }
    if (ctx.estimatedDailyLiquidityAbs !== undefined) {
      const liquidity = dec(ctx.estimatedDailyLiquidityAbs);
      const floor = dec(ctx.guardrail.minimumExpectedLiquidityAbs);
      signals.liquiditySufficient = liquidity >= floor;
      if (!signals.liquiditySufficient) {
        reasons.push(`liquidité estimée ${liquidity} < plancher ${floor}`);
      }
    }

    // 7. Risk envelope
    if (ctx.observedAnnualisedVolatilityPct !== undefined) {
      signals.volatilityAcceptable =
        ctx.observedAnnualisedVolatilityPct <= ctx.guardrail.maxAcceptableVolatilityPct;
      if (!signals.volatilityAcceptable) {
        reasons.push(
          `volatilité observée ${ctx.observedAnnualisedVolatilityPct}% > cap ${ctx.guardrail.maxAcceptableVolatilityPct}%`,
        );
      }
    }
    if (ctx.observedDrawdownPct !== undefined) {
      signals.drawdownUnderCap = ctx.observedDrawdownPct <= ctx.guardrail.maxIntradayDrawdownPct;
      if (!signals.drawdownUnderCap) {
        reasons.push(
          `drawdown intraday ${ctx.observedDrawdownPct}% > cap ${ctx.guardrail.maxIntradayDrawdownPct}%`,
        );
      }
    }
    if (ctx.realisedDailyLossPct !== undefined) {
      signals.dailyLossUnderCap = ctx.realisedDailyLossPct <= ctx.guardrail.maxDailyLossPct;
      if (!signals.dailyLossUnderCap) {
        reasons.push(
          `perte journalière ${ctx.realisedDailyLossPct}% > cap ${ctx.guardrail.maxDailyLossPct}%`,
        );
      }
    }

    // 8. Human-in-the-loop floor
    if (
      ctx.guardrail.requiredHumanApprovalAboveAbs !== null &&
      candidateNotional > dec(ctx.guardrail.requiredHumanApprovalAboveAbs)
    ) {
      reasons.unshift(
        `validation humaine requise — notionnel ${candidateNotional} > seuil ${ctx.guardrail.requiredHumanApprovalAboveAbs}`,
      );
      return { permitted: false, decision: 'require_review', reasons, signals };
    }

    if (reasons.length > 0) {
      return { permitted: false, decision: 'block', reasons, signals };
    }
    return { permitted: true, decision: 'allow', reasons: [], signals };
  }
}
