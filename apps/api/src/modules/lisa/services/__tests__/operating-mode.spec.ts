/**
 * P7-MODE-GAINERS-BADGE — Tests OperatingModeService.
 *
 * Couvre :
 *   - getMode normalise les valeurs DB (default investment, harvest/gainers passent)
 *   - applyMode 'investment' → délègue à MacroModeService.applyMacroMode('INVESTMENT')
 *   - applyMode 'harvest'    → délègue à MacroModeService.applyMacroMode('HARVEST')
 *   - applyMode 'gainers'    → écrit strategy_mode='gainers' + autopilot_enabled=true
 *   - applyMode 'gainers'    → BadRequestException si capital < $1000
 *   - applyMode écrit toujours mode_change_log (best effort)
 */

import { BadRequestException } from '@nestjs/common';
import { OperatingModeService } from '../operating-mode.service';

interface MockState {
  capitalUsd: number | null;
  strategyMode: string | null;
  profile: string;
  capitalDisciplineMode: string | null;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  rowMissing?: boolean;
}

function makeSupabaseMock(state: MockState) {
  const fromBuilder = (table: string) => {
    let pendingUpdate: Record<string, unknown> | null = null;
    let pendingInsert: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (state.rowMissing) return { data: null, error: null };
      if (table === 'lisa_session_configs') {
        return {
          data: {
            capital_usd: state.capitalUsd != null ? String(state.capitalUsd) : null,
            strategy_mode: state.strategyMode,
            profile: state.profile,
            capital_discipline_mode: state.capitalDisciplineMode,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    chain.update = (values: Record<string, unknown>) => {
      pendingUpdate = values;
      return chain;
    };
    chain.insert = async (values: Record<string, unknown>) => {
      pendingInsert = values;
      state.inserts.push({ table, values });
      return { data: null, error: null };
    };
    // Quand .eq() est chainé après update, on retourne chain qui résout en thenable
    // Le code appelle: .from(t).update(v).eq(a, b).eq(c, d) → on track ici.
    const original = chain.eq as () => unknown;
    let eqCalls = 0;
    chain.eq = () => {
      eqCalls++;
      // After 2nd .eq() if there's a pending update, flush it
      if (pendingUpdate && eqCalls >= 2) {
        state.updates.push({ table, values: pendingUpdate });
        pendingUpdate = null;
        return Promise.resolve({ error: null }) as unknown;
      }
      return chain;
    };
    return chain;
  };

  return {
    getClient: () => ({
      from: (table: string) => fromBuilder(table),
    }),
  };
}

function makeMacroModeMock() {
  const calls: Array<{ userId: string; portfolioId: string; mode: string }> = [];
  return {
    applyMacroMode: jest.fn(async (userId: string, portfolioId: string, mode: string) => {
      calls.push({ userId, portfolioId, mode });
      return { mode, appliedConfig: {} };
    }),
    detectMode: jest.fn(),
    calls,
  };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PORTFOLIO_ID = '22222222-2222-2222-2222-222222222222';

function makeService(state: Partial<MockState> = {}) {
  const fullState: MockState = {
    capitalUsd: 5000,
    strategyMode: 'investment',
    profile: 'long_term_investor',
    capitalDisciplineMode: 'NONE',
    updates: [],
    inserts: [],
    ...state,
  };
  const supabase = makeSupabaseMock(fullState);
  const macro = makeMacroModeMock();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OperatingModeService(supabase as any, macro as any);
  return { service, state: fullState, macro };
}

describe('OperatingModeService.getMode', () => {
  it('returns "investment" when DB has investment', async () => {
    const { service } = makeService({ strategyMode: 'investment' });
    expect(await service.getMode(PORTFOLIO_ID)).toBe('investment');
  });

  it('returns "harvest" when DB has harvest', async () => {
    const { service } = makeService({ strategyMode: 'harvest' });
    expect(await service.getMode(PORTFOLIO_ID)).toBe('harvest');
  });

  it('returns "gainers" when DB has gainers', async () => {
    const { service } = makeService({ strategyMode: 'gainers' });
    expect(await service.getMode(PORTFOLIO_ID)).toBe('gainers');
  });

  it('returns "investment" when DB row missing', async () => {
    const { service } = makeService({ rowMissing: true });
    expect(await service.getMode(PORTFOLIO_ID)).toBe('investment');
  });

  it('normalizes unexpected DB values to "investment"', async () => {
    const { service } = makeService({ strategyMode: 'something_weird' });
    expect(await service.getMode(PORTFOLIO_ID)).toBe('investment');
  });
});

describe('OperatingModeService.applyMode', () => {
  it('investment delegates to MacroModeService and writes strategy_mode', async () => {
    const { service, macro, state } = makeService({ strategyMode: 'gainers' });
    const result = await service.applyMode(USER_ID, PORTFOLIO_ID, 'investment');

    expect(result.mode).toBe('investment');
    expect(macro.applyMacroMode).toHaveBeenCalledWith(USER_ID, PORTFOLIO_ID, 'INVESTMENT');
    const cfgUpdate = state.updates.find((u) => u.table === 'lisa_session_configs');
    expect(cfgUpdate?.values.strategy_mode).toBe('investment');
  });

  it('harvest delegates to MacroModeService HARVEST', async () => {
    const { service, macro } = makeService({ strategyMode: 'investment' });
    await service.applyMode(USER_ID, PORTFOLIO_ID, 'harvest');
    expect(macro.applyMacroMode).toHaveBeenCalledWith(USER_ID, PORTFOLIO_ID, 'HARVEST');
  });

  it('gainers writes strategy_mode + autopilot_enabled=true + kill_switch=false', async () => {
    const { service, macro, state } = makeService({ capitalUsd: 5000 });
    await service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers');

    expect(macro.applyMacroMode).not.toHaveBeenCalled();
    const cfgUpdate = state.updates.find(
      (u) => u.table === 'lisa_session_configs' && u.values.strategy_mode === 'gainers',
    );
    expect(cfgUpdate?.values.autopilot_enabled).toBe(true);
    expect(cfgUpdate?.values.kill_switch_active).toBe(false);
  });

  it('gainers throws BadRequestException when capital < $1000', async () => {
    const { service } = makeService({ capitalUsd: 500 });
    await expect(
      service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gainers throws BadRequestException when capital exactly $999.99', async () => {
    const { service } = makeService({ capitalUsd: 999.99 });
    await expect(
      service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gainers accepts capital exactly $1000', async () => {
    const { service } = makeService({ capitalUsd: 1000 });
    const r = await service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers');
    expect(r.mode).toBe('gainers');
  });

  it('oversold writes strategy_mode + autopilot_enabled=true + kill_switch=false', async () => {
    const { service, macro, state } = makeService({ capitalUsd: 150000 });
    await service.applyMode(USER_ID, PORTFOLIO_ID, 'oversold');

    expect(macro.applyMacroMode).not.toHaveBeenCalled();
    const cfgUpdate = state.updates.find(
      (u) => u.table === 'lisa_session_configs' && u.values.strategy_mode === 'oversold',
    );
    expect(cfgUpdate?.values.autopilot_enabled).toBe(true);
    expect(cfgUpdate?.values.kill_switch_active).toBe(false);
  });

  it('oversold throws BadRequestException when capital < $5000', async () => {
    const { service } = makeService({ capitalUsd: 4999 });
    await expect(
      service.applyMode(USER_ID, PORTFOLIO_ID, 'oversold'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('oversold accepts capital >= $5000', async () => {
    const { service } = makeService({ capitalUsd: 5000 });
    const r = await service.applyMode(USER_ID, PORTFOLIO_ID, 'oversold');
    expect(r.mode).toBe('oversold');
  });

  it('writes mode_change_log entry on every successful apply', async () => {
    const { service, state } = makeService({ strategyMode: 'investment', capitalUsd: 2000 });
    await service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers', {
      userAgent: 'jest-test',
      reason: 'unit-test',
    });
    const audit = state.inserts.find((i) => i.table === 'mode_change_log');
    expect(audit).toBeDefined();
    expect(audit?.values.old_mode).toBe('investment');
    expect(audit?.values.new_mode).toBe('gainers');
    expect(audit?.values.user_agent).toBe('jest-test');
    expect(audit?.values.reason).toBe('unit-test');
  });

  it('does not call MacroModeService when applying gainers', async () => {
    const { service, macro } = makeService({ capitalUsd: 5000 });
    await service.applyMode(USER_ID, PORTFOLIO_ID, 'gainers');
    expect(macro.applyMacroMode).not.toHaveBeenCalled();
  });
});
