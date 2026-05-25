import { resolveDebate } from '../debate-orchestrator';
import { HALF_LIFE_PRESETS, signalDecayFactor } from '../signal-half-life';
import {
  bridgeShadowBatch,
  bridgeShadowToDebate,
  type ShadowSignalRow,
} from '../shadow-to-debate-bridge';

describe('shadow-to-debate-bridge', () => {
  const t0 = 1_700_000_000_000;

  describe('bridgeShadowToDebate', () => {
    it('maps "accept" -> BUY semantic decision', () => {
      const row: ShadowSignalRow = { decision: 'accept', emittedAt: t0, confidence: 0.8 };
      const inp = bridgeShadowToDebate(row);
      expect(inp.signal.context.decision).toBe('BUY');
      expect(inp.signal.context.confidence).toBe(0.8);
    });

    it('maps "reject_persistence" -> WAIT', () => {
      const inp = bridgeShadowToDebate({ decision: 'reject_persistence', emittedAt: t0 });
      expect(inp.signal.context.decision).toBe('WAIT');
    });

    it('maps "reject_overextended" -> CHASE_THE_TOP', () => {
      const inp = bridgeShadowToDebate({ decision: 'reject_overextended', emittedAt: t0 });
      expect(inp.signal.context.decision).toBe('CHASE_THE_TOP');
    });

    it('maps "reject_volatile_regime" -> MARKET_UNSAFE', () => {
      const inp = bridgeShadowToDebate({ decision: 'reject_volatile_regime', emittedAt: t0 });
      expect(inp.signal.context.decision).toBe('MARKET_UNSAFE');
    });

    it('maps unknown decision -> REGIME_UNKNOWN (safe fallback)', () => {
      const inp = bridgeShadowToDebate({ decision: 'reject_unknown_future_code', emittedAt: t0 });
      expect(inp.signal.context.decision).toBe('REGIME_UNKNOWN');
    });

    it('parses ISO string timestamp', () => {
      const iso = new Date(t0).toISOString();
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: iso, confidence: 0.7 });
      expect(inp.signal.emittedAt).toBe(t0);
    });

    it('parses numeric epoch timestamp', () => {
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: t0, confidence: 0.7 });
      expect(inp.signal.emittedAt).toBe(t0);
    });

    it('uses INTRADAY_5M half-life by default', () => {
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: t0, confidence: 0.7 });
      expect(inp.signal.halfLifeMs).toBe(HALF_LIFE_PRESETS.INTRADAY_5M);
    });

    it('respects custom half-life preset', () => {
      const inp = bridgeShadowToDebate(
        { decision: 'accept', emittedAt: t0, confidence: 0.7 },
        { halfLifePreset: 'SCALP_1M' },
      );
      expect(inp.signal.halfLifeMs).toBe(HALF_LIFE_PRESETS.SCALP_1M);
    });

    it('uses default agentId when row has none', () => {
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: t0 });
      expect(inp.agentId).toBe('scanner_gainers');
    });

    it('respects custom defaultAgentId', () => {
      const inp = bridgeShadowToDebate(
        { decision: 'accept', emittedAt: t0 },
        { defaultAgentId: 'scanner_v2' },
      );
      expect(inp.agentId).toBe('scanner_v2');
    });

    it('row.agentId overrides defaultAgentId', () => {
      const inp = bridgeShadowToDebate(
        { decision: 'accept', emittedAt: t0, agentId: 'specific' },
        { defaultAgentId: 'fallback' },
      );
      expect(inp.agentId).toBe('specific');
    });

    it('passes agentWeight through', () => {
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: t0 }, { agentWeight: 2.5 });
      expect(inp.agentWeight).toBe(2.5);
    });

    it('preserves reason from row', () => {
      const inp = bridgeShadowToDebate({ decision: 'accept', emittedAt: t0, reason: 'high persistence' });
      expect(inp.signal.context.reason).toBe('high persistence');
    });

    it('fallback reason mentions legacy decision', () => {
      const inp = bridgeShadowToDebate({ decision: 'reject_cooldown', emittedAt: t0 });
      expect(inp.signal.context.reason).toContain('reject_cooldown');
    });

    it('preserves metadata', () => {
      const inp = bridgeShadowToDebate({
        decision: 'accept',
        emittedAt: t0,
        metadata: { p_win: 0.78, persistence_score: 0.85 },
      });
      expect(inp.signal.context.metadata).toEqual({ p_win: 0.78, persistence_score: 0.85 });
    });
  });

  describe('bridgeShadowBatch', () => {
    it('maps an array of rows', () => {
      const rows: ShadowSignalRow[] = [
        { decision: 'accept', emittedAt: t0, confidence: 0.8 },
        { decision: 'reject_persistence', emittedAt: t0 + 1000, confidence: 0.5 },
      ];
      const inputs = bridgeShadowBatch(rows);
      expect(inputs).toHaveLength(2);
      expect(inputs[0].signal.context.decision).toBe('BUY');
      expect(inputs[1].signal.context.decision).toBe('WAIT');
    });

    it('returns empty array for empty input', () => {
      expect(bridgeShadowBatch([])).toHaveLength(0);
    });
  });

  describe('end-to-end with resolveDebate', () => {
    it('multiple accepts -> BUY consensus via debate', () => {
      const rows: ShadowSignalRow[] = [
        { decision: 'accept', emittedAt: t0, agentId: 'scanner_a', confidence: 0.8 },
        { decision: 'accept', emittedAt: t0, agentId: 'scanner_b', confidence: 0.75 },
      ];
      const debate = resolveDebate(bridgeShadowBatch(rows), t0);
      expect(debate.decision).toBe('BUY');
      expect(debate.contributingAgents).toHaveLength(2);
    });

    it('reject_volatile_regime alone -> MARKET_UNSAFE veto via debate', () => {
      const rows: ShadowSignalRow[] = [
        { decision: 'reject_volatile_regime', emittedAt: t0, confidence: 0.9 },
      ];
      const debate = resolveDebate(bridgeShadowBatch(rows), t0);
      expect(debate.decision).toBe('MARKET_UNSAFE');
      expect(debate.vetoTriggered).toBe(true);
    });

    it('stale shadow signals are filtered out', () => {
      const rows: ShadowSignalRow[] = [
        { decision: 'accept', emittedAt: t0 - 800_000, confidence: 0.9 }, // stale on INTRADAY_5M
      ];
      const debate = resolveDebate(bridgeShadowBatch(rows), t0);
      expect(debate.decision).toBe('WAIT');
      expect(debate.staleAgents.length).toBeGreaterThan(0);
    });

    it('mix accept + reject_cooldown -> WAIT (no consensus, COOLDOWN_ACTIVE is not veto)', () => {
      const rows: ShadowSignalRow[] = [
        { decision: 'accept', emittedAt: t0, agentId: 'a', confidence: 0.8 },
        { decision: 'reject_cooldown', emittedAt: t0, agentId: 'b', confidence: 0.8 },
      ];
      const debate = resolveDebate(bridgeShadowBatch(rows), t0);
      // BUY 1 vs COOLDOWN_ACTIVE 1 -> tie, fallback WAIT
      expect(debate.decision).toBe('WAIT');
    });

    it('shadow signal decay reflects half-life preset', () => {
      const inp = bridgeShadowToDebate(
        { decision: 'accept', emittedAt: t0 - HALF_LIFE_PRESETS.INTRADAY_5M, confidence: 0.9 },
      );
      // After exactly one half-life, decay factor should be 0.5
      expect(signalDecayFactor(inp.signal, t0)).toBeCloseTo(0.5, 2);
    });
  });
});
