import { ConflictException, NotFoundException } from '@nestjs/common';
import { SuggestionsService } from '../services/suggestions.service';

function buildChain(opts: {
  single?: unknown;
  maybeSingle?: unknown;
  insertResult?: unknown;
  updateResult?: unknown;
  selectResult?: unknown;
} = {}) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    single: jest.fn().mockResolvedValue(opts.single ?? { data: null, error: null }),
    maybeSingle: jest.fn().mockResolvedValue(opts.maybeSingle ?? { data: null, error: null }),
    insert: jest.fn().mockResolvedValue(opts.insertResult ?? { error: null }),
    update: jest.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  // For list queries that return an array at the end of a chain
  if (opts.selectResult) {
    chain.eq.mockResolvedValue(opts.selectResult);
  }
  return chain;
}

function buildSupabase(proposalData: Record<string, unknown> | null, overrides?: {
  updateResult?: unknown;
  auditPrevHash?: string | null;
}) {
  const calls: Array<{ table: string; chain: Record<string, jest.Mock> }> = [];

  // Per-table shared chain state so the same `from('x')` instance spans get+update
  const sharedProposalChain = buildChain();
  // getProposal flow: select.eq.eq.single -> returns proposalData
  // approve/reject/cancel flow: update.eq.eq.select.single -> returns updateResult
  sharedProposalChain.single = jest.fn()
    .mockResolvedValueOnce({ data: proposalData, error: proposalData ? null : { message: 'not found' } })
    .mockResolvedValue({ data: overrides?.updateResult ?? proposalData, error: null });

  const sharedAuditChain = buildChain({
    maybeSingle: { data: overrides?.auditPrevHash ? { hash: overrides.auditPrevHash } : null, error: null },
  });

  const sharedApprovalsChain = buildChain();

  const fromFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'action_proposals') {
      calls.push({ table, chain: sharedProposalChain });
      return sharedProposalChain;
    }
    if (table === 'action_approvals') {
      calls.push({ table, chain: sharedApprovalsChain });
      return sharedApprovalsChain;
    }
    // autonomy_audit_events
    calls.push({ table, chain: sharedAuditChain });
    return sharedAuditChain;
  });

  return {
    client: { getClient: jest.fn().mockReturnValue({ from: fromFn }), isReady: () => true },
    calls,
    fromFn,
  };
}

const PRESENTED_PROPOSAL = {
  id: 'prop-1',
  portfolio_id: 'pf-1',
  user_id: 'user-1',
  lifecycle_state: 'presented',
  action: 'buy',
  ticker: 'AAPL',
  notional: '1000.00',
  kind: 'suggestion',
  delegation_mode: 'HYBRID_SUGGESTIVE',
  rationale: 'Test rationale',
};

const APPROVED_PROPOSAL = { ...PRESENTED_PROPOSAL, lifecycle_state: 'approved' };
const EXECUTED_PROPOSAL = { ...PRESENTED_PROPOSAL, lifecycle_state: 'executed' };

describe('SuggestionsService', () => {
  describe('getProposal', () => {
    it('returns the proposal if found', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      const result = await svc.getProposal('prop-1', 'user-1');
      expect(result).toEqual(PRESENTED_PROPOSAL);
    });

    it('throws NotFound if missing', async () => {
      const mock = buildSupabase(null);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.getProposal('missing', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('approveProposal', () => {
    it('approves a presented proposal', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: APPROVED_PROPOSAL });
      const svc = new SuggestionsService(mock.client as never);
      const result = await svc.approveProposal('prop-1', 'user-1', { note: 'ok' });
      expect((result as Record<string, unknown>)['lifecycle_state']).toBe('approved');
    });

    it('inserts an action_approvals row', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: APPROVED_PROPOSAL });
      const svc = new SuggestionsService(mock.client as never);
      await svc.approveProposal('prop-1', 'user-1', {});
      const approvalCall = mock.calls.find((c) => c.table === 'action_approvals');
      expect(approvalCall).toBeDefined();
      expect(approvalCall?.chain.insert).toHaveBeenCalled();
      const insertArg = (approvalCall?.chain.insert as jest.Mock).mock.calls[0]?.[0];
      expect(insertArg.decision).toBe('approved');
    });

    it('writes a hash-chained audit event', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL, {
        updateResult: APPROVED_PROPOSAL,
        auditPrevHash: 'prev-hash-abc',
      });
      const svc = new SuggestionsService(mock.client as never);
      await svc.approveProposal('prop-1', 'user-1', {});
      const auditCall = mock.calls.find((c) => c.table === 'autonomy_audit_events' && (c.chain.insert as jest.Mock).mock.calls.length > 0);
      expect(auditCall).toBeDefined();
      const insertArg = (auditCall!.chain.insert as jest.Mock).mock.calls[0]?.[0];
      expect(insertArg.kind).toBe('proposal_approved');
      expect(insertArg.prev_hash).toBe('prev-hash-abc');
      expect(typeof insertArg.hash).toBe('string');
      expect(insertArg.hash.length).toBe(64); // sha256 hex
    });

    it('refuses to approve an already-approved proposal', async () => {
      const mock = buildSupabase(APPROVED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.approveProposal('prop-1', 'user-1', {})).rejects.toThrow(ConflictException);
    });

    it('refuses to approve an executed proposal', async () => {
      const mock = buildSupabase(EXECUTED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.approveProposal('prop-1', 'user-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('rejectProposal', () => {
    it('rejects a presented proposal', async () => {
      const rejected = { ...PRESENTED_PROPOSAL, lifecycle_state: 'rejected' };
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: rejected });
      const svc = new SuggestionsService(mock.client as never);
      const result = await svc.rejectProposal('prop-1', 'user-1', { note: 'not convinced' });
      expect((result as Record<string, unknown>)['lifecycle_state']).toBe('rejected');
    });

    it('writes proposal_rejected audit event', async () => {
      const rejected = { ...PRESENTED_PROPOSAL, lifecycle_state: 'rejected' };
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: rejected });
      const svc = new SuggestionsService(mock.client as never);
      await svc.rejectProposal('prop-1', 'user-1', {});
      const auditCall = mock.calls.find((c) => c.table === 'autonomy_audit_events' && (c.chain.insert as jest.Mock).mock.calls.length > 0);
      const insertArg = (auditCall!.chain.insert as jest.Mock).mock.calls[0]?.[0];
      expect(insertArg.kind).toBe('proposal_rejected');
    });

    it('refuses to reject a terminal-state proposal', async () => {
      const mock = buildSupabase(APPROVED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.rejectProposal('prop-1', 'user-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelProposal', () => {
    it('cancels a presented proposal', async () => {
      const cancelled = { ...PRESENTED_PROPOSAL, lifecycle_state: 'cancelled' };
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: cancelled });
      const svc = new SuggestionsService(mock.client as never);
      const result = await svc.cancelProposal('prop-1', 'user-1', {});
      expect((result as Record<string, unknown>)['lifecycle_state']).toBe('cancelled');
    });

    it('refuses to cancel an already-approved proposal', async () => {
      const mock = buildSupabase(APPROVED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.cancelProposal('prop-1', 'user-1', {})).rejects.toThrow(ConflictException);
    });

    it('refuses to cancel an executed proposal', async () => {
      const mock = buildSupabase(EXECUTED_PROPOSAL);
      const svc = new SuggestionsService(mock.client as never);
      await expect(svc.cancelProposal('prop-1', 'user-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('HYBRID_SUGGESTIVE safety', () => {
    it('audit event always records delegation_mode=HYBRID_SUGGESTIVE', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: APPROVED_PROPOSAL });
      const svc = new SuggestionsService(mock.client as never);
      await svc.approveProposal('prop-1', 'user-1', {});
      const auditCall = mock.calls.find((c) => c.table === 'autonomy_audit_events' && (c.chain.insert as jest.Mock).mock.calls.length > 0);
      const insertArg = (auditCall!.chain.insert as jest.Mock).mock.calls[0]?.[0];
      expect(insertArg.delegation_mode).toBe('HYBRID_SUGGESTIVE');
    });

    it('approve does NOT trigger an execution_attempted audit', async () => {
      const mock = buildSupabase(PRESENTED_PROPOSAL, { updateResult: APPROVED_PROPOSAL });
      const svc = new SuggestionsService(mock.client as never);
      await svc.approveProposal('prop-1', 'user-1', {});
      const auditCalls = mock.calls.filter((c) => c.table === 'autonomy_audit_events');
      for (const call of auditCalls) {
        const insertArgs = (call.chain.insert as jest.Mock).mock.calls;
        for (const [arg] of insertArgs) {
          expect(arg.kind).not.toBe('execution_attempted');
          expect(arg.kind).not.toBe('execution_succeeded');
        }
      }
    });
  });
});
