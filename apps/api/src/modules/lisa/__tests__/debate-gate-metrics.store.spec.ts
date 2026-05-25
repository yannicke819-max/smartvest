import { DebateGateMetricsStore, type DebateGateEvaluation } from '../services/debate-gate-metrics.store';

function evalAt(over: Partial<DebateGateEvaluation> = {}): DebateGateEvaluation {
  return {
    timestamp: Date.now(),
    symbol: 'TEST.US',
    allow: true,
    shadowMode: false,
    verdictDecision: 'BUY',
    consensusRatio: 0.8,
    agentCount: 4,
    vetoTriggered: false,
    rationale: 'ok',
    ...over,
  };
}

describe('DebateGateMetricsStore', () => {
  let store: DebateGateMetricsStore;

  beforeEach(() => {
    store = new DebateGateMetricsStore();
  });

  it('starts empty', () => {
    expect(store.size()).toBe(0);
  });

  it('records evaluations', () => {
    store.record(evalAt());
    store.record(evalAt({ symbol: 'X.US' }));
    expect(store.size()).toBe(2);
  });

  it('caps buffer at 5000 entries (FIFO eviction)', () => {
    for (let i = 0; i < 5500; i++) {
      store.record(evalAt({ symbol: `S${i}` }));
    }
    expect(store.size()).toBe(5000);
  });

  it('clear empties the buffer', () => {
    store.record(evalAt());
    store.clear();
    expect(store.size()).toBe(0);
  });

  describe('aggregate', () => {
    const now = Date.now();

    beforeEach(() => {
      store.clear();
      // 5 evaluations within last hour
      store.record(evalAt({ timestamp: now - 60_000, symbol: 'A', verdictDecision: 'BUY', allow: true, shadowMode: false }));
      store.record(evalAt({ timestamp: now - 120_000, symbol: 'B', verdictDecision: 'WAIT', allow: false, shadowMode: false }));
      store.record(evalAt({ timestamp: now - 180_000, symbol: 'C', verdictDecision: 'CHASE_THE_TOP', allow: false, shadowMode: false, vetoTriggered: true }));
      store.record(evalAt({ timestamp: now - 240_000, symbol: 'B', verdictDecision: 'WAIT', allow: false, shadowMode: false }));
      store.record(evalAt({ timestamp: now - 300_000, symbol: 'D', verdictDecision: 'BUY', allow: true, shadowMode: true }));
      // 1 evaluation 2h ago (out of 1h window)
      store.record(evalAt({ timestamp: now - 7_200_000, symbol: 'OLD', verdictDecision: 'BUY' }));
    });

    it('returns totals for the window', () => {
      const m = store.aggregate(1);
      expect(m.totalEvaluations).toBe(5);
      expect(m.windowHours).toBe(1);
    });

    it('counts shadow vs active', () => {
      const m = store.aggregate(1);
      expect(m.shadowModeCount).toBe(1);
      expect(m.activeModeCount).toBe(4);
    });

    it('computes wouldBlockCount and blockRatio', () => {
      const m = store.aggregate(1);
      // B (WAIT), C (CHASE), B (WAIT) blocked in active mode = 3
      // D (BUY) in shadow doesn't count as wouldBlock (verdict is BUY)
      // A (BUY active allow) doesn't block
      expect(m.wouldBlockCount).toBe(3);
      expect(m.wouldAllowCount).toBe(2);
      expect(m.blockRatio).toBeCloseTo(0.6, 2);
    });

    it('topVerdicts sorted by count', () => {
      const m = store.aggregate(1);
      const buyEntry = m.topVerdicts.find((v) => v.decision === 'BUY');
      const waitEntry = m.topVerdicts.find((v) => v.decision === 'WAIT');
      expect(buyEntry?.count).toBe(2);
      expect(waitEntry?.count).toBe(2);
    });

    it('topBlockedSymbols sorted by count', () => {
      const m = store.aggregate(1);
      expect(m.topBlockedSymbols[0]?.symbol).toBe('B');
      expect(m.topBlockedSymbols[0]?.count).toBe(2);
    });

    it('counts vetoTriggers', () => {
      const m = store.aggregate(1);
      expect(m.vetoTriggers).toBe(1);
    });

    it('averages agentCount and consensusRatio', () => {
      const m = store.aggregate(1);
      expect(m.averageAgentCount).toBeCloseTo(4, 1);
      expect(m.averageConsensusRatio).toBeCloseTo(0.8, 1);
    });

    it('respects time window (excludes older entries)', () => {
      const m = store.aggregate(0.5); // 30 minutes
      // Only A (60s) and B (120s) and C (180s) and B (240s) and D (300s) within 30min
      expect(m.totalEvaluations).toBe(5);

      const m2 = store.aggregate(3); // 3h window
      // 5 + the OLD one (2h) = 6
      expect(m2.totalEvaluations).toBe(6);
    });

    it('handles empty buffer gracefully', () => {
      store.clear();
      const m = store.aggregate(24);
      expect(m.totalEvaluations).toBe(0);
      expect(m.blockRatio).toBe(0);
      expect(m.topVerdicts).toEqual([]);
      expect(m.topBlockedSymbols).toEqual([]);
    });
  });
});
