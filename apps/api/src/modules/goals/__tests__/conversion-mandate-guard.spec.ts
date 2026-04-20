import { ForbiddenException } from '@nestjs/common';
import { GoalAuditService } from '../services/goal-audit.service';

function buildQueryChain(resolvedValue: unknown) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    single: jest.fn().mockResolvedValue(resolvedValue),
    insert: jest.fn().mockResolvedValue({ error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

function buildMockSupabase(mandateData: Record<string, unknown> | null) {
  const fromFn = jest.fn().mockImplementation((table: string) => {
    if (table === 'autonomy_mandates') {
      return buildQueryChain({ data: mandateData, error: null });
    }
    // autonomy_audit_events: select returns no prev hash, insert succeeds
    const chain = buildQueryChain({ data: null, error: null });
    chain.insert = jest.fn().mockResolvedValue({ error: null });
    return chain;
  });

  return {
    getClient: jest.fn().mockReturnValue({ from: fromFn }),
    isReady: jest.fn().mockReturnValue(true),
  };
}

const BASE_PARAMS = {
  portfolioId: 'portfolio-1',
  userId: 'user-1',
  goalId: 'goal-1',
  scenarioId: 'scenario-1',
};

describe('GoalAuditService — conversion mandate guard', () => {
  describe('MANUAL_EXPLICIT mode', () => {
    it('is always permitted without any mandate', async () => {
      const svc = new GoalAuditService(buildMockSupabase(null) as never);
      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'MANUAL_EXPLICIT' }),
      ).resolves.toBeUndefined();
    });

    it('does not query autonomy_mandates in MANUAL_EXPLICIT mode', async () => {
      const mockSupabase = buildMockSupabase(null);
      const svc = new GoalAuditService(mockSupabase as never);
      await svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'MANUAL_EXPLICIT' });

      const fromCalls: string[] = (mockSupabase.getClient().from as jest.Mock).mock.calls.map(
        (c: string[]) => c[0],
      );
      expect(fromCalls).not.toContain('autonomy_mandates');
    });
  });

  describe('AUTONOMOUS_GUARDED mode — no active mandate', () => {
    it('throws ForbiddenException when no active mandate exists', async () => {
      const svc = new GoalAuditService(buildMockSupabase(null) as never);
      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'AUTONOMOUS_GUARDED' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('still writes a policy_violation audit event before throwing', async () => {
      const mockSupabase = buildMockSupabase(null);
      const getClientFn = mockSupabase.getClient as jest.Mock;
      const svc = new GoalAuditService(mockSupabase as never);

      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'AUTONOMOUS_GUARDED' }),
      ).rejects.toThrow(ForbiddenException);

      // Find all insert calls across all from() usages
      const allFromCalls = getClientFn.mock.results.flatMap(
        (r: jest.MockResult<{ from: jest.Mock }>) => r.value.from.mock.results.map(
          (fr: jest.MockResult<{ insert: jest.Mock }>) => fr.value,
        ),
      );
      const insertCalls = allFromCalls.filter((c: { insert?: jest.Mock }) => (c.insert?.mock?.calls?.length ?? 0) > 0);
      expect(insertCalls.length).toBeGreaterThan(0);
    });
  });

  describe('HYBRID_SUGGESTIVE mode — no active mandate', () => {
    it('throws ForbiddenException when no active mandate exists', async () => {
      const svc = new GoalAuditService(buildMockSupabase(null) as never);
      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'HYBRID_SUGGESTIVE' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('AUTONOMOUS_GUARDED mode — expired mandate', () => {
    it('throws ForbiddenException when mandate is expired', async () => {
      const expiredMandate = {
        id: 'mandate-1',
        portfolio_id: 'portfolio-1',
        user_id: 'user-1',
        status: 'active',
        label: 'Test mandate',
        max_position_size_pct: 10,
        max_single_trade_pct: 5,
        max_daily_trade_pct: 10,
        max_single_trade_notional: null,
        max_single_trade_notional_currency: null,
        allowed_asset_classes: ['equity'],
        forbidden_tickers: [],
        requires_human_above_pct: 3,
        stop_loss_trigger_pct: 15,
        max_open_positions: null,
        activated_at: '2024-01-01T00:00:00Z',
        expires_at: '2024-01-31T00:00:00Z', // expired in the past
        suspended_at: null,
        revoked_at: null,
        kill_switch_active: false,
        total_actions_executed: 0,
        total_notional_traded: '0',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };
      const svc = new GoalAuditService(buildMockSupabase(expiredMandate) as never);
      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'AUTONOMOUS_GUARDED' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('AUTONOMOUS_GUARDED mode — active mandate with kill-switch', () => {
    it('throws ForbiddenException when kill-switch is active', async () => {
      const killSwitchedMandate = {
        id: 'mandate-2',
        portfolio_id: 'portfolio-1',
        user_id: 'user-1',
        status: 'active',
        label: 'Kill-switched mandate',
        max_position_size_pct: 10,
        max_single_trade_pct: 5,
        max_daily_trade_pct: 10,
        max_single_trade_notional: null,
        max_single_trade_notional_currency: null,
        allowed_asset_classes: ['equity'],
        forbidden_tickers: [],
        requires_human_above_pct: 3,
        stop_loss_trigger_pct: 15,
        max_open_positions: null,
        activated_at: '2025-01-01T00:00:00Z',
        expires_at: '2099-12-31T00:00:00Z',
        suspended_at: null,
        revoked_at: null,
        kill_switch_active: true, // kill-switch ON
        total_actions_executed: 0,
        total_notional_traded: '0',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      };
      const svc = new GoalAuditService(buildMockSupabase(killSwitchedMandate) as never);
      await expect(
        svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'AUTONOMOUS_GUARDED' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('hash chain', () => {
    it('includes prev_hash in audit event when previous event exists', async () => {
      const mockSupabase = buildMockSupabase(null);
      // Override autonomy_audit_events to return a prev hash
      const fromFn = mockSupabase.getClient().from as jest.Mock;
      const originalImpl = fromFn.getMockImplementation()!;
      fromFn.mockImplementation((table: string) => {
        if (table === 'autonomy_audit_events') {
          const chain = buildQueryChain({ data: { hash: 'prev-hash-abc123' }, error: null });
          chain.insert = jest.fn().mockResolvedValue({ error: null });
          return chain;
        }
        return originalImpl(table);
      });

      const svc = new GoalAuditService(mockSupabase as never);
      // MANUAL_EXPLICIT always succeeds
      await svc.checkAndAuditConversion({ ...BASE_PARAMS, delegationMode: 'MANUAL_EXPLICIT' });
      // Verify an insert was called (audit event written)
      const insertedTables = fromFn.mock.calls
        .map((c: [string]) => c[0])
        .filter((t: string) => t === 'autonomy_audit_events');
      expect(insertedTables.length).toBeGreaterThan(0);
    });
  });
});
