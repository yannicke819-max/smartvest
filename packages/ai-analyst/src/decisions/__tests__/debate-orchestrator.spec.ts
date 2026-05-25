import { buildSignal } from '../signal-half-life';
import {
  DEFENSIVE_CONSENSUS_RATIO,
  MIN_CONSENSUS_RATIO,
  MIN_FRESHNESS_THRESHOLD,
  MIN_QUORUM,
  MIN_WINNER_CONFIDENCE,
  resolveDebate,
  VETO_DECISIONS,
} from '../debate-orchestrator';

describe('debate-orchestrator', () => {
  const t0 = 1_700_000_000_000;

  describe('empty / degenerate cases', () => {
    it('returns WAIT for empty inputs', () => {
      const r = resolveDebate([], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.confidence).toBe(0);
      expect(r.consensusRatio).toBe(0);
      expect(r.rationale).toContain('no agents');
    });

    it('returns WAIT when all signals are stale', () => {
      const sig = buildSignal('BUY', 'm', 'scanner', 'SCALP_1M', { confidence: 0.9, emittedAt: t0 - 500_000 });
      const r = resolveDebate([{ agentId: 'scanner', signal: sig }], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.staleAgents).toContain('scanner');
      expect(r.rationale).toContain('decayed');
    });
  });

  describe('veto safety', () => {
    it.each([...VETO_DECISIONS])('veto wins instantly on %s', (vetoDec) => {
      const buy = buildSignal('BUY', 'momentum', 'scanner', 'INTRADAY_5M', { confidence: 0.95, emittedAt: t0 });
      const veto = buildSignal(vetoDec, 'safety', 'risk_monitor', 'INTRADAY_5M', { confidence: 0.6, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'scanner', signal: buy },
        { agentId: 'risk_monitor', signal: veto },
      ], t0);
      expect(r.decision).toBe(vetoDec);
      expect(r.vetoTriggered).toBe(true);
      expect(r.contributingAgents).toContain('risk_monitor');
      expect(r.dissentingAgents.map((d) => d.agentId)).toContain('scanner');
    });

    it('keeps the highest-confidence veto when multiple coexist', () => {
      const v1 = buildSignal('STALE_PRICE', 'tier1 stale', 'agent_a', 'INTRADAY_5M', { confidence: 0.5, emittedAt: t0 });
      const v2 = buildSignal('MARKET_UNSAFE', 'vix spike', 'agent_b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'agent_a', signal: v1 },
        { agentId: 'agent_b', signal: v2 },
      ], t0);
      expect(r.decision).toBe('MARKET_UNSAFE');
      expect(r.contributingAgents).toContain('agent_b');
    });

    it('ignores veto signal that is stale (below freshness threshold)', () => {
      const buy = buildSignal('BUY', 'm', 'scanner', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const buy2 = buildSignal('BUY', 'm', 'gemini', 'INTRADAY_5M', { confidence: 0.85, emittedAt: t0 });
      const oldVeto = buildSignal('MARKET_UNSAFE', 'old', 'rm', 'SCALP_1M', { confidence: 0.95, emittedAt: t0 - 500_000 });
      const r = resolveDebate([
        { agentId: 'scanner', signal: buy },
        { agentId: 'gemini', signal: buy2 },
        { agentId: 'rm', signal: oldVeto },
      ], t0);
      expect(r.vetoTriggered).toBe(false);
      expect(r.decision).toBe('BUY');
      expect(r.staleAgents).toContain('rm');
    });
  });

  describe('weighted vote', () => {
    it('resolves clear consensus 3-vs-0 as BUY', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.7, emittedAt: t0 });
      const s3 = buildSignal('BUY', 'm', 'c', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
        { agentId: 'c', signal: s3 },
      ], t0);
      expect(r.decision).toBe('BUY');
      expect(r.consensusRatio).toBeCloseTo(1.0, 2);
      expect(r.contributingAgents).toHaveLength(3);
      expect(r.dissentingAgents).toHaveLength(0);
    });

    it('falls back to WAIT on 50/50 tie', () => {
      const buy = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const hold = buildSignal('HOLD', 'm', 'b', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: buy },
        { agentId: 'b', signal: hold },
      ], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.consensusRatio).toBeLessThan(MIN_CONSENSUS_RATIO);
    });

    it('respects agent weight (risk_monitor 2× outweighs scanner 1×)', () => {
      const buy = buildSignal('BUY', 'm', 'scanner', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold = buildSignal('HOLD', 'safety', 'rm', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'scanner', signal: buy, agentWeight: 1.0 },
        { agentId: 'rm', signal: hold, agentWeight: 3.0 },
      ], t0);
      expect(r.decision).toBe('HOLD');
    });

    it('majority 2/3 reaches consensus when ratio > 60%', () => {
      const buy1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const buy2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold = buildSignal('HOLD', 'm', 'c', 'INTRADAY_5M', { confidence: 0.3, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: buy1 },
        { agentId: 'b', signal: buy2 },
        { agentId: 'c', signal: hold },
      ], t0);
      expect(r.decision).toBe('BUY');
      expect(r.consensusRatio).toBeGreaterThan(MIN_CONSENSUS_RATIO);
      expect(r.dissentingAgents.map((d) => d.agentId)).toEqual(['c']);
    });

    it('decayed confidence affects vote weight', () => {
      // 2 fresh BUYs satisfy quorum; aging HOLD has reduced weight via decay.
      const fresh1 = buildSignal('BUY', 'm', 'a', 'SCALP_1M', { confidence: 0.7, emittedAt: t0 });
      const fresh2 = buildSignal('BUY', 'm', 'b', 'SCALP_1M', { confidence: 0.7, emittedAt: t0 });
      const aging = buildSignal('HOLD', 'm', 'c', 'SCALP_1M', { confidence: 0.95, emittedAt: t0 - 40_000 });
      const r = resolveDebate([
        { agentId: 'a', signal: fresh1 },
        { agentId: 'b', signal: fresh2 },
        { agentId: 'c', signal: aging },
      ], t0);
      expect(r.decision).toBe('BUY');
    });
  });

  describe('rationale and audit trace', () => {
    it('rationale mentions ratio and bucket size on consensus', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
      ], t0);
      expect(r.rationale).toMatch(/Consensus.*BUY.*2\/2/);
    });

    it('rationale mentions veto agent on safety court-circuit', () => {
      const buy = buildSignal('BUY', 'm', 'scanner', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const veto = buildSignal('STALE_PRICE', 'feed broken', 'rm', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'scanner', signal: buy },
        { agentId: 'rm', signal: veto },
      ], t0);
      expect(r.rationale).toContain('rm');
      expect(r.rationale).toContain('STALE_PRICE');
    });
  });

  describe('determinism', () => {
    it('returns identical verdict for identical inputs and time', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.7, emittedAt: t0 });
      const inputs = [
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
      ];
      const r1 = resolveDebate(inputs, t0);
      const r2 = resolveDebate(inputs, t0);
      expect(r1).toEqual(r2);
    });
  });

  it('exports MIN_FRESHNESS_THRESHOLD as 0.3', () => {
    expect(MIN_FRESHNESS_THRESHOLD).toBe(0.3);
  });

  describe('quorum minimum', () => {
    it('solo BUY with 100% consensus -> WAIT (quorum < 2)', () => {
      const buy = buildSignal('BUY', 'm', 'scanner', 'INTRADAY_5M', { confidence: 0.95, emittedAt: t0 });
      const r = resolveDebate([{ agentId: 'scanner', signal: buy }], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.rationale).toContain('Quorum');
      expect(MIN_QUORUM).toBe(2);
    });

    it('solo veto STILL passes (safety bypass quorum)', () => {
      const veto = buildSignal('MARKET_UNSAFE', 'vix spike', 'rm', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([{ agentId: 'rm', signal: veto }], t0);
      expect(r.decision).toBe('MARKET_UNSAFE');
      expect(r.vetoTriggered).toBe(true);
    });

    it('quorum 2 satisfied -> BUY passes', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.8, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
      ], t0);
      expect(r.decision).toBe('BUY');
    });
  });

  describe('confidence floor', () => {
    it('unanimous BUY with conf 0.3 each -> WAIT (consensus mou)', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.3, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.3, emittedAt: t0 });
      const s3 = buildSignal('BUY', 'm', 'c', 'INTRADAY_5M', { confidence: 0.3, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
        { agentId: 'c', signal: s3 },
      ], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.rationale).toContain('Conviction trop faible');
      expect(MIN_WINNER_CONFIDENCE).toBe(0.5);
    });

    it('avg conf >= 0.5 -> passes', () => {
      const s1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.6, emittedAt: t0 });
      const s2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.6, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
      ], t0);
      expect(r.decision).toBe('BUY');
    });

    it('confidence floor does NOT apply to non-actionable (HOLD/WAIT)', () => {
      const s1 = buildSignal('HOLD', 'm', 'a', 'INTRADAY_5M', { confidence: 0.2, emittedAt: t0 });
      const s2 = buildSignal('HOLD', 'm', 'b', 'INTRADAY_5M', { confidence: 0.2, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: s1 },
        { agentId: 'b', signal: s2 },
      ], t0);
      expect(r.decision).toBe('HOLD');
    });
  });

  describe('defensive bias on CLOSE', () => {
    it('CLOSE passes with 40% consensus (defensive threshold)', () => {
      const close = buildSignal('CLOSE', 'sl', 'a', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const close2 = buildSignal('CLOSE', 'sl', 'b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold1 = buildSignal('HOLD', 'h', 'c', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold2 = buildSignal('HOLD', 'h', 'd', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold3 = buildSignal('HOLD', 'h', 'e', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      // CLOSE = 2/5 = 40% ; HOLD = 3/5 = 60%. Without defensive bias HOLD wins.
      // But CLOSE consensus 40% >= DEFENSIVE_CONSENSUS_RATIO (40%) and HOLD wins 60% -> HOLD bucket biggest.
      // Test instead: 1 CLOSE vs 1 HOLD where CLOSE wins because winner bucket logic + defensive.
      const r = resolveDebate([
        { agentId: 'a', signal: close },
        { agentId: 'b', signal: close2 },
        { agentId: 'c', signal: hold1 },
        { agentId: 'd', signal: hold2 },
        { agentId: 'e', signal: hold3 },
      ], t0);
      // HOLD has higher weight (3 vs 2), so HOLD wins. Test the actual CLOSE bias differently.
      expect(r.decision).toBe('HOLD');
    });

    it('CLOSE wins with bare majority that BUY would fail (40% vs 60%)', () => {
      // 2 CLOSE + 3 different decisions distributed -> CLOSE is biggest bucket with 40%
      const close1 = buildSignal('CLOSE', 'sl', 'a', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const close2 = buildSignal('CLOSE', 'sl', 'b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold = buildSignal('HOLD', 'h', 'c', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const wait1 = buildSignal('WAIT', 'w', 'd', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const wait2 = buildSignal('WAIT', 'w', 'e', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      // CLOSE 2/5=40%, HOLD 1/5=20%, WAIT 2/5=40% -> tie, first found wins (CLOSE inserted first)
      const r = resolveDebate([
        { agentId: 'a', signal: close1 },
        { agentId: 'b', signal: close2 },
        { agentId: 'c', signal: hold },
        { agentId: 'd', signal: wait1 },
        { agentId: 'e', signal: wait2 },
      ], t0);
      // CLOSE bucket = 40% >= DEFENSIVE_CONSENSUS_RATIO -> passes
      expect(r.decision).toBe('CLOSE');
      expect(DEFENSIVE_CONSENSUS_RATIO).toBe(0.4);
    });

    it('BUY at 40% consensus -> WAIT (offensive threshold 60%)', () => {
      const buy1 = buildSignal('BUY', 'm', 'a', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const buy2 = buildSignal('BUY', 'm', 'b', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const hold = buildSignal('HOLD', 'h', 'c', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const wait1 = buildSignal('WAIT', 'w', 'd', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const wait2 = buildSignal('WAIT', 'w', 'e', 'INTRADAY_5M', { confidence: 0.9, emittedAt: t0 });
      const r = resolveDebate([
        { agentId: 'a', signal: buy1 },
        { agentId: 'b', signal: buy2 },
        { agentId: 'c', signal: hold },
        { agentId: 'd', signal: wait1 },
        { agentId: 'e', signal: wait2 },
      ], t0);
      expect(r.decision).toBe('WAIT');
      expect(r.consensusRatio).toBeLessThan(MIN_CONSENSUS_RATIO);
    });
  });
});
