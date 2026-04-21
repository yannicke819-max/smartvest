import { HyperTradingPolicyEngine, EvaluationContext } from '../services/hyper-trading-policy-engine.service';
import { DEFAULT_HYPER_TRADING_GUARDRAIL, type HyperTradingProfile } from '@smartvest/domain';

const baseProfile: HyperTradingProfile = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  portfolioId: null,
  mandateId: null,
  status: 'active',
  tempo: 'HYPER_ACTIVE',
  riskLevel: 'very_high',
  delegationMode: 'MANUAL_EXPLICIT',
  guardrail: DEFAULT_HYPER_TRADING_GUARDRAIL,
  windows: [],
  windowTimezone: 'UTC',
  activatedAt: '2026-01-01T00:00:00.000Z',
  pausedAt: null,
  killedAt: null,
  archivedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  killSwitchActive: false,
  totalSessionsOpened: 0,
  totalSuggestionsEmitted: 0,
  totalIntentsApproved: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function buildCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    profile: baseProfile,
    guardrail: baseProfile.guardrail,
    mandate: null,
    tradesToday: 0,
    notionalTradedToday: '0',
    minutesSinceLastTrade: 9999,
    candidateNotionalAbs: '5000',
    candidateTicker: 'CW8',
    candidateAssetClass: 'etf',
    now: new Date('2026-04-21T10:00:00Z'), // Tuesday 10:00 UTC
    ...overrides,
  };
}

describe('HyperTradingPolicyEngine', () => {
  let engine: HyperTradingPolicyEngine;
  beforeEach(() => {
    engine = new HyperTradingPolicyEngine();
  });

  it('allows a clean candidate with empty windows (always-on)', () => {
    const result = engine.evaluate(buildCtx(), []);
    expect(result.permitted).toBe(true);
    expect(result.decision).toBe('allow');
    expect(result.reasons).toHaveLength(0);
  });

  it('blocks immediately when kill-switch is active', () => {
    const ctx = buildCtx({ profile: { ...baseProfile, killSwitchActive: true } });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.decision).toBe('kill_switch');
    expect(r.reasons[0]).toContain('kill-switch');
  });

  it('blocks when profile is not active', () => {
    const ctx = buildCtx({ profile: { ...baseProfile, status: 'paused' } });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.decision).toBe('block');
  });

  it('blocks when profile is expired', () => {
    const ctx = buildCtx({ profile: { ...baseProfile, expiresAt: '2020-01-01T00:00:00Z' } });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.reasons[0]).toContain('expiré');
  });

  it('blocks outside configured windows', () => {
    const ctx = buildCtx({ now: new Date('2026-04-21T22:00:00Z') }); // Tue 22:00 UTC
    const r = engine.evaluate(ctx, [
      { weekday: 2, startLocal: '08:00', endLocal: '17:00' }, // Tue 08:00-17:00 UTC
    ]);
    expect(r.permitted).toBe(false);
    expect(r.signals.insideWindow).toBe(false);
    expect(r.reasons[0]).toContain('hors fenêtre');
  });

  it('allows inside configured windows', () => {
    const ctx = buildCtx({ now: new Date('2026-04-21T10:00:00Z') });
    const r = engine.evaluate(ctx, [
      { weekday: 2, startLocal: '08:00', endLocal: '17:00' },
    ]);
    expect(r.signals.insideWindow).toBe(true);
    expect(r.permitted).toBe(true);
  });

  it('blocks when cooldown not respected', () => {
    const ctx = buildCtx({ minutesSinceLastTrade: 1 }); // default cooldown = 5
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.cooldownRespected).toBe(false);
    expect(r.reasons.some((x) => x.includes('cooldown'))).toBe(true);
  });

  it('blocks when daily trades cap reached', () => {
    const ctx = buildCtx({ tradesToday: 10 }); // default cap = 10
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.dailyTradesUnderCap).toBe(false);
  });

  it('blocks when ticker is denied', () => {
    const ctx = buildCtx({
      guardrail: { ...DEFAULT_HYPER_TRADING_GUARDRAIL, deniedTickers: ['CW8'] },
    });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.reasons.some((x) => x.includes('CW8'))).toBe(true);
  });

  it('blocks when asset class not allowed', () => {
    const ctx = buildCtx({ candidateAssetClass: 'crypto' });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.reasons.some((x) => x.includes('crypto'))).toBe(true);
  });

  it('blocks when spread exceeds cap', () => {
    const ctx = buildCtx({ observedSpreadBps: 60 });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.spreadAcceptable).toBe(false);
  });

  it('blocks when slippage exceeds cap', () => {
    const ctx = buildCtx({ observedSlippageBps: 100 });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.slippageAcceptable).toBe(false);
  });

  it('blocks when liquidity below floor', () => {
    const ctx = buildCtx({ estimatedDailyLiquidityAbs: '500' });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.liquiditySufficient).toBe(false);
  });

  it('blocks when intraday drawdown exceeds cap', () => {
    const ctx = buildCtx({ observedDrawdownPct: 5 }); // default cap = 3
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.drawdownUnderCap).toBe(false);
  });

  it('blocks when daily loss exceeds cap', () => {
    const ctx = buildCtx({ realisedDailyLossPct: 5 }); // default cap = 2
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.dailyLossUnderCap).toBe(false);
  });

  it('blocks when volatility exceeds cap', () => {
    const ctx = buildCtx({ observedAnnualisedVolatilityPct: 100 });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.signals.volatilityAcceptable).toBe(false);
  });

  it('requires human review when notional exceeds approval threshold', () => {
    const ctx = buildCtx({
      candidateNotionalAbs: '50000',
      guardrail: { ...DEFAULT_HYPER_TRADING_GUARDRAIL, requiredHumanApprovalAboveAbs: '10000' },
    });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.decision).toBe('require_review');
    expect(r.reasons[0]).toContain('validation humaine');
  });

  it('blocks when mandate is invalid (kill-switch on mandate)', () => {
    const mandate = {
      id: 'm', portfolioId: 'p', userId: 'u', status: 'active' as const,
      label: 'M', guardrail: {
        maxPositionSizePct: 10, maxSingleTradePct: 5, maxDailyTradePct: 10,
        maxSingleTradeNotional: null, maxSingleTradeNotionalCurrency: null,
        allowedAssetClasses: ['etf'], forbiddenTickers: [], requiresHumanAbovePct: 3,
        stopLossTriggerPct: 15, maxOpenPositions: 20,
      },
      activatedAt: '2025-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      suspendedAt: null, revokedAt: null,
      killSwitchActive: true, // kill-switch on mandate
      totalActionsExecuted: 0, totalNotionalTraded: '0',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const ctx = buildCtx({ mandate });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.reasons.some((x) => x.includes('mandat'))).toBe(true);
  });

  it('aggregates multiple non-blocking signal failures into reasons list', () => {
    const ctx = buildCtx({
      observedSpreadBps: 60,
      observedSlippageBps: 80,
      observedDrawdownPct: 5,
    });
    const r = engine.evaluate(ctx, []);
    expect(r.permitted).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
