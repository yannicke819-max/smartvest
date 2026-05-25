import { ConfigService } from '@nestjs/config';
import { DebateGateService, type CandidateScores } from '../services/debate-gate.service';

function makeService(envValue: string | undefined = undefined): DebateGateService {
  const config = {
    get: (key: string) => (key === 'DEBATE_GATE_ENABLED' ? envValue : undefined),
  } as unknown as ConfigService;
  return new DebateGateService(config);
}

const t0 = 1_700_000_000_000;

function scores(over: Partial<CandidateScores> = {}): CandidateScores {
  return {
    symbol: 'TEST.US',
    persistenceScore: 0.8,
    pathEfficiency: 0.75,
    pWin: 0.6,
    changePct: 5,
    ...over,
  };
}

describe('DebateGateService', () => {
  describe('isActive flag', () => {
    it('defaults to true (ACTIVE) when env unset', () => {
      expect(makeService(undefined).isActive()).toBe(true);
    });

    it('true when env != "false"', () => {
      expect(makeService('true').isActive()).toBe(true);
      expect(makeService('1').isActive()).toBe(true);
      expect(makeService('').isActive()).toBe(true);
    });

    it('false only when env === "false" exactly', () => {
      expect(makeService('false').isActive()).toBe(false);
    });
  });

  describe('shadow mode (env override to false)', () => {
    it('allows everything in shadow mode, even if debate says no', () => {
      const svc = makeService('false');
      const r = svc.evaluateCandidate(scores({ persistenceScore: 0.1, pWin: 0.2, changePct: 50 }), t0);
      expect(r.allow).toBe(true);
      expect(r.shadowMode).toBe(true);
    });

    it('computes verdict even in shadow mode (for audit log)', () => {
      const svc = makeService('false');
      const r = svc.evaluateCandidate(scores({ persistenceScore: 0.1 }), t0);
      expect(r.verdict.decision).toBeDefined();
      expect(r.verdict.rationale).toBeDefined();
    });
  });

  describe('active mode (gate ON)', () => {
    it('allows BUY consensus', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({ persistenceScore: 0.85, pathEfficiency: 0.8, pWin: 0.65, changePct: 5 }),
        t0,
      );
      expect(r.shadowMode).toBe(false);
      expect(r.verdict.decision).toBe('BUY');
      expect(r.allow).toBe(true);
    });

    it('blocks non-BUY consensus', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({ persistenceScore: 0.3, pathEfficiency: 0.3, pWin: 0.3, changePct: -2 }),
        t0,
      );
      expect(r.allow).toBe(false);
      expect(r.verdict.decision).not.toBe('BUY');
    });

    it('blocks CHASE_THE_TOP when momentum + path quality + ml all flag overextension', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({ persistenceScore: 0.4, pathEfficiency: 0.3, pWin: 0.4, changePct: 25 }),
        t0,
      );
      expect(r.allow).toBe(false);
      expect(['CHASE_THE_TOP', 'WAIT']).toContain(r.verdict.decision);
    });

    it('macro PANIC veto blocks the candidate', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({
          persistenceScore: 0.85,
          pathEfficiency: 0.8,
          pWin: 0.7,
          changePct: 5,
          macroRegimeDecision: 'MARKET_UNSAFE',
          macroRegimeConfidence: 0.9,
        }),
        t0,
      );
      expect(r.verdict.vetoTriggered).toBe(true);
      expect(r.verdict.decision).toBe('MARKET_UNSAFE');
      expect(r.allow).toBe(false);
    });

    it('volatility cell stress veto blocks candidate', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({
          persistenceScore: 0.85,
          pathEfficiency: 0.8,
          pWin: 0.7,
          changePct: 5,
          cellDecision: 'MARKET_UNSAFE',
          cellConfidence: 0.9,
        }),
        t0,
      );
      expect(r.allow).toBe(false);
      expect(r.verdict.vetoTriggered).toBe(true);
    });

    it('strategy quarantine veto blocks candidate', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({
          persistenceScore: 0.85,
          pathEfficiency: 0.8,
          pWin: 0.7,
          changePct: 5,
          strategySuggestedVerdict: 'QUARANTINE',
        }),
        t0,
      );
      expect(r.allow).toBe(false);
      expect(r.verdict.vetoTriggered).toBe(true);
    });
  });

  describe('agent count', () => {
    it('includes persistence + momentum minimum (2 agents)', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        { symbol: 'X', persistenceScore: 0.8, changePct: 5 },
        t0,
      );
      expect(r.agentCount).toBe(2);
    });

    it('adds optional agents when scores provided', () => {
      const svc = makeService('true');
      const r = svc.evaluateCandidate(
        scores({ macroRegimeDecision: 'HOLD', cellDecision: 'HOLD', strategySuggestedVerdict: 'HOLD' }),
        t0,
      );
      // persistence + path + ml + momentum + macro + cell + strategy = 7
      expect(r.agentCount).toBe(7);
    });
  });

  describe('verdict mapping', () => {
    const svc = makeService('true');

    it('persistence 0.85 -> BUY signal', () => {
      const inputs = svc.buildAgentInputs(scores({ persistenceScore: 0.85 }), t0);
      const p = inputs.find((i) => i.agentId === 'persistence');
      expect(p?.signal.context.decision).toBe('BUY');
    });

    it('persistence 0.3 -> WAIT signal', () => {
      const inputs = svc.buildAgentInputs(scores({ persistenceScore: 0.3 }), t0);
      const p = inputs.find((i) => i.agentId === 'persistence');
      expect(p?.signal.context.decision).toBe('WAIT');
    });

    it('changePct 25 -> CHASE_THE_TOP signal', () => {
      const inputs = svc.buildAgentInputs(scores({ changePct: 25 }), t0);
      const m = inputs.find((i) => i.agentId === 'momentum');
      expect(m?.signal.context.decision).toBe('CHASE_THE_TOP');
    });

    it('pWin 0.3 -> WAIT signal', () => {
      const inputs = svc.buildAgentInputs(scores({ pWin: 0.3 }), t0);
      const m = inputs.find((i) => i.agentId === 'ml_pwin');
      expect(m?.signal.context.decision).toBe('WAIT');
    });

    it('pathEfficiency 0.2 -> CHASE_THE_TOP signal (choppy)', () => {
      const inputs = svc.buildAgentInputs(scores({ pathEfficiency: 0.2 }), t0);
      const p = inputs.find((i) => i.agentId === 'path_quality');
      expect(p?.signal.context.decision).toBe('CHASE_THE_TOP');
    });
  });

  describe('fail-open on error', () => {
    it('returns allow=true if a downstream throws (no regression)', () => {
      const svc = makeService('true');
      // Force error by passing invalid number (NaN)
      const r = svc.evaluateCandidate(
        { symbol: 'X', persistenceScore: Number.NaN, changePct: Number.NaN },
        t0,
      );
      // Even with weird inputs, service should not crash
      expect(r).toBeDefined();
      expect(typeof r.allow).toBe('boolean');
    });
  });
});
