// PR2 cost-cuts (H) — tests unitaires GeminiBudgetGuardService.
//
// Focus sur la logique de décision isAllowed/assertAllowed + parsing du status.
// Pas de test live Supabase (mocké) — la logique pure est ce qui compte.

import { ConfigService } from '@nestjs/config';
import { GeminiBudgetGuardService, GeminiBudgetExceededError } from '../gemini-budget-guard.service';

type SupabaseRow = Record<string, unknown> | null;

function makeSupabaseMock(rows: {
  apiCostsDailyToday?: SupabaseRow;
  apiCostsDailyMonth?: SupabaseRow[];
  override?: SupabaseRow;
}) {
  const calls: { table: string; method: string }[] = [];
  const builder = (table: string) => {
    const ctx = {
      table,
      _filterEq: false,
      _filterGte: false,
      _isMaybeSingle: false,
    };
    const result: Record<string, unknown> = {
      select: (_cols?: string) => result,
      eq: (_col: string, _val: unknown) => {
        ctx._filterEq = true;
        return result;
      },
      gte: (_col: string, _val: unknown) => {
        ctx._filterGte = true;
        return result;
      },
      is: (_col: string, _val: unknown) => result,
      update: () => result,
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => result,
      maybeSingle: () => {
        calls.push({ table, method: 'maybeSingle' });
        if (table === 'api_costs_daily') {
          return Promise.resolve({ data: rows.apiCostsDailyToday ?? null, error: null });
        }
        if (table === 'gemini_cost_override') {
          return Promise.resolve({ data: rows.override ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // For non-single queries, the chain ends with await on the chained builder.
      then: (cb: (v: { data: unknown; error: unknown }) => unknown) => {
        if (table === 'api_costs_daily' && ctx._filterGte) {
          return Promise.resolve({ data: rows.apiCostsDailyMonth ?? [], error: null }).then(cb);
        }
        return Promise.resolve({ data: null, error: null }).then(cb);
      },
    };
    return result;
  };
  return {
    isReady: () => true,
    getClient: () => ({ from: builder }),
    _calls: calls,
  } as unknown as { isReady: () => boolean; getClient: () => unknown };
}

function makeConfig(envs: Record<string, string>): ConfigService {
  return {
    get: (key: string) => envs[key],
  } as unknown as ConfigService;
}

function makeCostTracker() {
  return { record: jest.fn(), recordApiCost: jest.fn(), getTodayTotalUsd: jest.fn() } as never;
}

describe('GeminiBudgetGuardService', () => {
  it('hard cap par défaut $30 si env absent', () => {
    const svc = new GeminiBudgetGuardService(makeConfig({}), makeSupabaseMock({}) as never, makeCostTracker());
    expect(svc.getHardCapUsd()).toBe(30);
  });

  it('hard cap configurable via GEMINI_DAILY_HARD_CAP_USD', () => {
    const svc = new GeminiBudgetGuardService(makeConfig({ GEMINI_DAILY_HARD_CAP_USD: '50' }), makeSupabaseMock({}) as never, makeCostTracker());
    expect(svc.getHardCapUsd()).toBe(50);
  });

  it('hard cap ignore valeur invalide (négative ou non-numeric)', () => {
    const svc1 = new GeminiBudgetGuardService(makeConfig({ GEMINI_DAILY_HARD_CAP_USD: '-5' }), makeSupabaseMock({}) as never, makeCostTracker());
    expect(svc1.getHardCapUsd()).toBe(30);
    const svc2 = new GeminiBudgetGuardService(makeConfig({ GEMINI_DAILY_HARD_CAP_USD: 'abc' }), makeSupabaseMock({}) as never, makeCostTracker());
    expect(svc2.getHardCapUsd()).toBe(30);
  });

  it('isAllowed=true quand todayUsd < cap', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 5, by_model: { 'gemini-2.5-pro': 5 } },
      override: null,
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    expect(await svc.isAllowed()).toBe(true);
  });

  it('isAllowed=false quand todayUsd >= cap ET pas d override', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 35, by_model: { 'gemini-2.5-pro': 35 } },
      override: null,
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    expect(await svc.isAllowed()).toBe(false);
  });

  it('isAllowed=true quand todayUsd >= cap MAIS override actif', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 35, by_model: { 'gemini-2.5-pro': 35 } },
      override: { overridden_at: '2026-05-31T05:30:00Z', reason: 'A++ setup' },
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    expect(await svc.isAllowed()).toBe(true);
  });

  it('assertAllowed throw GeminiBudgetExceededError quand bloqué', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 35, by_model: { 'gemini-2.5-pro': 35 } },
      override: null,
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    await expect(svc.assertAllowed()).rejects.toThrow(GeminiBudgetExceededError);
  });

  it('assertAllowed ne throw pas quand override actif', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 35, by_model: { 'gemini-2.5-pro': 35 } },
      override: { overridden_at: '2026-05-31T05:30:00Z', reason: null },
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    await expect(svc.assertAllowed()).resolves.toBeUndefined();
  });

  it('getStatus retourne shape complet attendu', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: { total_usd: 12.34, by_model: { 'gemini-2.5-pro': 10, 'gemini-2.5-flash-lite': 2.34 } },
      override: null,
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    const status = await svc.getStatus();
    expect(status.todayUsd).toBe(12.34);
    expect(status.hardCapUsd).toBe(30);
    expect(status.killSwitchActive).toBe(false);
    expect(status.manualOverrideActive).toBe(false);
    expect(status.capUsedPct).toBe(41.1); // 12.34 / 30 * 100 = 41.13
    expect(typeof status.nextResetUtc).toBe('string');
  });

  it('getStatus aggregate uniquement les modeles Gemini (ignore Claude)', async () => {
    const supabase = makeSupabaseMock({
      apiCostsDailyToday: {
        total_usd: 100,
        by_model: { 'gemini-2.5-pro': 8, 'claude-opus-4-7': 92 },
      },
      override: null,
    });
    const svc = new GeminiBudgetGuardService(makeConfig({}), supabase as never, makeCostTracker());
    const status = await svc.getStatus();
    expect(status.todayUsd).toBe(8); // Pas 100
  });

  it('GeminiBudgetExceededError porte les valeurs todayCostUsd + hardCapUsd', () => {
    const err = new GeminiBudgetExceededError(45.67, 30);
    expect(err.todayCostUsd).toBe(45.67);
    expect(err.hardCapUsd).toBe(30);
    expect(err.message).toContain('$45.67');
    expect(err.message).toContain('$30.00');
    expect(err.name).toBe('GeminiBudgetExceededError');
  });
});
