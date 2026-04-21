import { ProposalScorerService } from '../services/proposal-scorer.service';
import type { RawProposal } from '../interfaces/raw-proposal';

function make(overrides: Partial<RawProposal> & { sourceKind: RawProposal['sourceKind'] }): RawProposal {
  return {
    action: 'rebalance',
    currency: 'EUR',
    rationale: 'test',
    assumptions: [],
    score: 0.5,
    expiresInDays: 7,
    dedupKey: `test:${Math.random()}`,
    ...overrides,
  };
}

describe('ProposalScorerService', () => {
  const svc = new ProposalScorerService();

  describe('rankAndDedup', () => {
    it('sorts proposals by score descending', () => {
      const proposals = [
        make({ sourceKind: 'drift', score: 0.45, dedupKey: 'a' }),
        make({ sourceKind: 'macro_signal', score: 0.85, dedupKey: 'b' }),
        make({ sourceKind: 'drawdown', score: 0.70, dedupKey: 'c' }),
      ];
      const sorted = svc.rankAndDedup(proposals);
      expect(sorted[0]!.score).toBe(0.85);
      expect(sorted[1]!.score).toBe(0.70);
      expect(sorted[2]!.score).toBe(0.45);
    });

    it('removes in-run duplicate dedupKeys', () => {
      const proposals = [
        make({ sourceKind: 'drift', dedupKey: 'drift:pf1:etf', score: 0.65 }),
        make({ sourceKind: 'drift', dedupKey: 'drift:pf1:etf', score: 0.40 }),
        make({ sourceKind: 'concentration', dedupKey: 'concentration:pf1:bond', score: 0.60 }),
      ];
      const result = svc.rankAndDedup(proposals);
      expect(result).toHaveLength(2);
      // First dedupKey wins (higher score in this case)
      expect(result.some((p) => p.score === 0.65)).toBe(true);
    });

    it('keeps unique dedupKeys intact', () => {
      const proposals = [
        make({ sourceKind: 'drift', dedupKey: 'drift:pf1:etf' }),
        make({ sourceKind: 'drift', dedupKey: 'drift:pf1:bond' }),
        make({ sourceKind: 'macro_signal', dedupKey: 'macro:abc123' }),
      ];
      expect(svc.rankAndDedup(proposals)).toHaveLength(3);
    });
  });

  describe('dedupWindowDays', () => {
    it('returns correct window for each source kind', () => {
      expect(svc.dedupWindowDays('drift')).toBe(7);
      expect(svc.dedupWindowDays('concentration')).toBe(2);
      expect(svc.dedupWindowDays('goal_trigger')).toBe(3);
      expect(svc.dedupWindowDays('macro_signal')).toBe(2);
      expect(svc.dedupWindowDays('drawdown')).toBe(1);
      expect(svc.dedupWindowDays('benchmark')).toBe(7);
    });
  });

  describe('applyGuardrails', () => {
    const activeMandate = {
      kill_switch_active: false,
      status: 'active',
      forbidden_tickers: ['GME', 'AMC'],
      allowed_asset_classes: ['equity', 'etf', 'bond'],
    };

    it('allows all proposals when mandate is null', () => {
      const proposals = [
        make({ sourceKind: 'drift', ticker: 'GME', assetClass: 'equity' }),
        make({ sourceKind: 'macro_signal' }),
      ];
      const { allowed, blocked } = svc.applyGuardrails(proposals, null);
      expect(allowed).toHaveLength(2);
      expect(blocked).toHaveLength(0);
    });

    it('blocks all proposals when kill-switch is active', () => {
      const proposals = [make({ sourceKind: 'drift' }), make({ sourceKind: 'macro_signal' })];
      const { allowed, blocked } = svc.applyGuardrails(proposals, { ...activeMandate, kill_switch_active: true });
      expect(allowed).toHaveLength(0);
      expect(blocked).toHaveLength(2);
      expect(blocked[0]!.reason).toBe('kill_switch_active');
    });

    it('blocks proposals with forbidden ticker (case-insensitive)', () => {
      const proposals = [
        make({ sourceKind: 'drift', ticker: 'gme', assetClass: 'equity' }),
        make({ sourceKind: 'drift', ticker: 'AAPL', assetClass: 'equity' }),
      ];
      const { allowed, blocked } = svc.applyGuardrails(proposals, activeMandate);
      expect(allowed).toHaveLength(1);
      expect(allowed[0]!.ticker).toBe('AAPL');
      expect(blocked[0]!.reason).toContain('GME');
    });

    it('blocks proposals with non-allowed asset class', () => {
      const proposals = [
        make({ sourceKind: 'concentration', assetClass: 'crypto' }),
        make({ sourceKind: 'drift', assetClass: 'etf' }),
      ];
      const { allowed, blocked } = svc.applyGuardrails(proposals, activeMandate);
      expect(allowed).toHaveLength(1);
      expect(allowed[0]!.assetClass).toBe('etf');
      expect(blocked[0]!.reason).toContain('crypto');
    });

    it('blocks all proposals when mandate status is suspended', () => {
      const proposals = [make({ sourceKind: 'drift' })];
      const { allowed, blocked } = svc.applyGuardrails(proposals, { ...activeMandate, status: 'suspended' });
      expect(allowed).toHaveLength(0);
      expect(blocked[0]!.reason).toContain('suspended');
    });
  });
});
