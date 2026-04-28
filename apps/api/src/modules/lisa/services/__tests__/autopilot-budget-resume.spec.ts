/**
 * P8-BR — Tests du mécanisme pause/resume autopilot sur budget.
 *
 * Couvre :
 *   - Aucune pause → cycle continue
 *   - Paused BUDGET_EXCEEDED + cost < 90% budget → CLEAR + resume + log
 *   - Paused BUDGET_EXCEEDED + cost ≥ 90% budget → skip cycle, paused_reason inchangé
 *   - Paused BUDGET_EXCEEDED + budget retiré (null) → CLEAR + resume
 *   - Paused MANUAL → skip (resume manuel uniquement)
 *
 * Le mécanisme est encapsulé dans `LisaAutopilotService.maybeResumeOrSkip()`.
 * On le teste via une instance partielle avec mocks Supabase + ApiCostTracker.
 */

import { LisaAutopilotService } from '../lisa-autopilot.service';

interface MockState {
  costToday: number;
  configUpdates: Array<Record<string, unknown>>;
  decisionLogs: Array<{ kind: string; portfolioId: string; payload?: unknown }>;
}

function makeService(state: MockState) {
  const supabase = {
    getClient: () => ({
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.update = (values: Record<string, unknown>) => {
          state.configUpdates.push(values);
          return chain;
        };
        chain.eq = () => Promise.resolve({ error: null });
        return chain;
      },
    }),
  };
  const apiCostTracker = {
    getTodayTotalUsd: jest.fn().mockResolvedValue(state.costToday),
  };
  const decisionLog = {
    append: jest.fn(async (entry: { kind: string; portfolioId: string; payload?: unknown }) => {
      state.decisionLogs.push({
        kind: entry.kind,
        portfolioId: entry.portfolioId,
        payload: entry.payload,
      });
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new (LisaAutopilotService as any)(
    supabase, // supabase
    null, // lisa
    decisionLog, // decisionLog
    null, // realtimePrice
    null, // performance
    null, // materialDetector
    null, // dailyProfitGovernor
    null, // lisaReplay
    null, // config
    apiCostTracker, // apiCostTracker
  );
  return service as LisaAutopilotService & { maybeResumeOrSkip: (cfg: Record<string, unknown>) => Promise<boolean> };
}

const PORTFOLIO_ID = '11111111-2222-3333-4444-555555555555';

function emptyState(overrides: Partial<MockState> = {}): MockState {
  return {
    costToday: 0,
    configUpdates: [],
    decisionLogs: [],
    ...overrides,
  };
}

describe('LisaAutopilotService.maybeResumeOrSkip', () => {
  it('returns true (cycle continues) when no paused_reason', async () => {
    const state = emptyState();
    const service = makeService(state);
    const cfg = { portfolio_id: PORTFOLIO_ID, autopilot_paused_reason: null };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(true);
    expect(state.configUpdates).toEqual([]);
    expect(state.decisionLogs).toEqual([]);
  });

  it('paused BUDGET_EXCEEDED + cost < 90% budget → CLEAR + resume + log', async () => {
    const state = emptyState({ costToday: 80 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: 100, // 80% of 100 = 80, cost=80 → 80% < 90% → resume
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(true);
    expect(state.configUpdates).toContainEqual({ autopilot_paused_reason: null });
    expect(state.decisionLogs[0]?.kind).toBe('autopilot_resumed');
  });

  it('paused BUDGET_EXCEEDED + cost = 89.99 of 100 → resume (just under 90%)', async () => {
    const state = emptyState({ costToday: 89.99 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: 100,
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(true);
    expect(state.configUpdates).toContainEqual({ autopilot_paused_reason: null });
  });

  it('paused BUDGET_EXCEEDED + cost = 90 of 100 (≥ 90%) → skip, no clear', async () => {
    const state = emptyState({ costToday: 90 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: 100,
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(false);
    expect(state.configUpdates).toEqual([]);
    expect(state.decisionLogs).toEqual([]);
  });

  it('paused BUDGET_EXCEEDED + budget bumped from $50 to $200 → resume (cost $51 < 90% of $200=$180)', async () => {
    const state = emptyState({ costToday: 51 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: 200, // user just bumped from $50 to $200
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(true);
    expect(state.configUpdates).toContainEqual({ autopilot_paused_reason: null });
  });

  it('paused BUDGET_EXCEEDED + budget removed (null) → resume', async () => {
    const state = emptyState({ costToday: 999 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: null,
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(true);
    expect(state.configUpdates).toContainEqual({ autopilot_paused_reason: null });
  });

  it('paused MANUAL → skip (no auto-resume on manual pauses)', async () => {
    const state = emptyState({ costToday: 0 });
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'MANUAL',
      daily_cost_budget_usd: 100,
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(false);
    expect(state.configUpdates).toEqual([]);
  });

  it('paused PROVIDER_OUTAGE → skip (manual resume only)', async () => {
    const state = emptyState();
    const service = makeService(state);
    const cfg = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'PROVIDER_OUTAGE',
      daily_cost_budget_usd: 100,
    };
    const ok = await service.maybeResumeOrSkip(cfg);
    expect(ok).toBe(false);
  });

  it('integration scenario: 3-cycle pause → bump budget → resume', async () => {
    const state = emptyState({ costToday: 51 });
    const service = makeService(state);

    // Cycle 1 : budget=$50, cost=$51 → already paused (set by lisa.service)
    const cfg1 = {
      portfolio_id: PORTFOLIO_ID,
      autopilot_paused_reason: 'BUDGET_EXCEEDED',
      daily_cost_budget_usd: 50,
    };
    expect(await service.maybeResumeOrSkip(cfg1)).toBe(false); // skip (cost >= 90%)

    // Cycle 2 : user bumps budget to $200
    const cfg2 = {
      ...cfg1,
      daily_cost_budget_usd: 200,
    };
    expect(await service.maybeResumeOrSkip(cfg2)).toBe(true);
    expect(state.configUpdates.length).toBe(1);
    expect(state.decisionLogs.length).toBe(1);
    expect(state.decisionLogs[0].kind).toBe('autopilot_resumed');
  });
});
