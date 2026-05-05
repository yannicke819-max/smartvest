/**
 * PR Gainers-autonomy — tests du gate strategy_mode='gainers' dans
 * LisaAutopilotService.runAutopilotCycleInner.
 *
 * En mode 'gainers' :
 *   - Lisa LLM cycle SKIPPÉ (le scanner Gainers gère seul les opens)
 *   - Aucun appel à runPortfolioCycle
 *   - Aucun appel à maybeResumeOrSkip / generateProposal
 *
 * En mode 'investment' / 'harvest' :
 *   - runPortfolioCycle appelé normalement
 */

import { LisaAutopilotService } from '../lisa-autopilot.service';

interface MockState {
  configsReturned: Array<Record<string, unknown>>;
  runPortfolioCycleCalls: string[];
  maybeResumeOrSkipCalls: string[];
}

function makeService(state: MockState) {
  const supabase = {
    getClient: () => ({
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: state.configsReturned, error: null });
        return chain;
      },
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new (LisaAutopilotService as any)(
    supabase, null, { append: jest.fn() }, null, null, null, null, null, null, null,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).runPortfolioCycle = jest.fn(async (_userId: string, portfolioId: string) => {
    state.runPortfolioCycleCalls.push(portfolioId);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).maybeResumeOrSkip = jest.fn(async (cfg: Record<string, unknown>) => {
    state.maybeResumeOrSkipCalls.push(String(cfg.portfolio_id));
    return true;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return service as any;
}

const GAINERS_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const INVESTMENT_ID = 'bbbbbbbb-2222-2222-2222-222222222222';
const HARVEST_ID = 'cccccccc-3333-3333-3333-333333333333';

describe('LisaAutopilotService.runAutopilotCycleInner — gainers gate', () => {
  it('SKIPS portfolio with strategy_mode=gainers (no runPortfolioCycle, no maybeResumeOrSkip)', async () => {
    const state: MockState = {
      configsReturned: [
        {
          portfolio_id: GAINERS_ID,
          user_id: 'user-1',
          strategy_mode: 'gainers',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
          autopilot_cycle_minutes: 15,
        },
      ],
      runPortfolioCycleCalls: [],
      maybeResumeOrSkipCalls: [],
    };
    const service = makeService(state);
    await service.runAutopilotCycleInner();

    expect(state.runPortfolioCycleCalls).toEqual([]);
    expect(state.maybeResumeOrSkipCalls).toEqual([]);
  });

  it('RUNS portfolio with strategy_mode=investment normally', async () => {
    const state: MockState = {
      configsReturned: [
        {
          portfolio_id: INVESTMENT_ID,
          user_id: 'user-2',
          strategy_mode: 'investment',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
          autopilot_cycle_minutes: 60,
        },
      ],
      runPortfolioCycleCalls: [],
      maybeResumeOrSkipCalls: [],
    };
    const service = makeService(state);
    await service.runAutopilotCycleInner();

    expect(state.maybeResumeOrSkipCalls).toEqual([INVESTMENT_ID]);
    expect(state.runPortfolioCycleCalls).toEqual([INVESTMENT_ID]);
  });

  it('RUNS portfolio with strategy_mode=harvest normally', async () => {
    const state: MockState = {
      configsReturned: [
        {
          portfolio_id: HARVEST_ID,
          user_id: 'user-3',
          strategy_mode: 'harvest',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
          autopilot_cycle_minutes: 7,
        },
      ],
      runPortfolioCycleCalls: [],
      maybeResumeOrSkipCalls: [],
    };
    const service = makeService(state);
    await service.runAutopilotCycleInner();

    expect(state.runPortfolioCycleCalls).toEqual([HARVEST_ID]);
  });

  it('RUNS portfolio with NULL strategy_mode (legacy) normally — backward compat', async () => {
    const state: MockState = {
      configsReturned: [
        {
          portfolio_id: 'dddddddd-4444-4444-4444-444444444444',
          user_id: 'user-4',
          strategy_mode: null,
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
          autopilot_cycle_minutes: 30,
        },
      ],
      runPortfolioCycleCalls: [],
      maybeResumeOrSkipCalls: [],
    };
    const service = makeService(state);
    await service.runAutopilotCycleInner();

    expect(state.runPortfolioCycleCalls).toHaveLength(1);
  });

  it('MIXED batch : skips only gainers, runs others', async () => {
    const state: MockState = {
      configsReturned: [
        {
          portfolio_id: GAINERS_ID,
          user_id: 'user-1',
          strategy_mode: 'gainers',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
        },
        {
          portfolio_id: INVESTMENT_ID,
          user_id: 'user-2',
          strategy_mode: 'investment',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
        },
        {
          portfolio_id: HARVEST_ID,
          user_id: 'user-3',
          strategy_mode: 'harvest',
          autopilot_enabled: true,
          kill_switch_active: false,
          autopilot_market_hours_only: false,
        },
      ],
      runPortfolioCycleCalls: [],
      maybeResumeOrSkipCalls: [],
    };
    const service = makeService(state);
    await service.runAutopilotCycleInner();

    expect(state.runPortfolioCycleCalls).not.toContain(GAINERS_ID);
    expect(state.runPortfolioCycleCalls).toContain(INVESTMENT_ID);
    expect(state.runPortfolioCycleCalls).toContain(HARVEST_ID);
    expect(state.runPortfolioCycleCalls).toHaveLength(2);
  });
});
