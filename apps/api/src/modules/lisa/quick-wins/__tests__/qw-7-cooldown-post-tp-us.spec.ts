import { ConfigService } from '@nestjs/config';
import { Qw7CooldownPostTpUsService } from '../qw-7-cooldown-post-tp-us.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { log: (e: unknown) => calls.push(e), calls } as unknown as QwDecisionLoggerService & {
    calls: unknown[];
  };
}
function makeSupabaseNotReady(): SupabaseService {
  return {
    isReady: () => false,
    getClient: () => {
      throw new Error('not ready');
    },
  } as unknown as SupabaseService;
}

interface QueryShape {
  resolveWith: { data: unknown[] | null; error: { message: string } | null };
  capturedCalls: { table: string; filters: Record<string, unknown> }[];
}

function makeSupabaseWith(query: QueryShape): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            filters[`eq_${col}`] = val;
            return chain;
          },
          gte: (col: string, val: unknown) => {
            filters[`gte_${col}`] = val;
            return chain;
          },
          limit: (_n: number) => {
            query.capturedCalls.push({ table, filters });
            return Promise.resolve(query.resolveWith);
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseService;
}

describe('Qw7CooldownPostTpUsService', () => {
  const baseSignal = {
    symbol: 'AAPL.US',
    assetClass: 'us_equity_large',
    timestamp: '2026-05-20T15:30:00Z',
    portfolioId: 'pf-1',
  };

  it('class non éligible (asia_equity) → pass class_not_eligible', async () => {
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, assetClass: 'asia_equity' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('class_not_eligible');
  });

  it('no portfolioId → pass no_portfolio_id', async () => {
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, portfolioId: null });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_portfolio_id');
  });

  it('supabase not ready → fail-open pass supabase_not_ready', async () => {
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('supabase_not_ready');
  });

  it('aucune ligne récente TP → pass no_recent_tp', async () => {
    const query: QueryShape = {
      resolveWith: { data: [], error: null },
      capturedCalls: [],
    };
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({}),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_recent_tp');
    expect(query.capturedCalls[0].table).toBe('lisa_positions');
    expect(query.capturedCalls[0].filters.eq_status).toBe('closed_target');
    expect(query.capturedCalls[0].filters.eq_symbol).toBe('AAPL.US');
  });

  it('TP récent < 60min → block cooldown_post_tp_active + logger appelé', async () => {
    const logger = makeLogger();
    const query: QueryShape = {
      resolveWith: {
        data: [{ id: 'p123', exit_timestamp: '2026-05-20T15:00:00Z' }],
        error: null,
      },
      capturedCalls: [],
    };
    const svc = new Qw7CooldownPostTpUsService(makeConfig({}), makeSupabaseWith(query), logger);
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('cooldown_post_tp_active');
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_7',
      decision: 'block',
      reason: 'cooldown_post_tp_active',
      wouldHavePassedWithoutFlag: true,
    });
  });

  it('Supabase erreur → fail-open pass db_error_fail_open', async () => {
    const query: QueryShape = {
      resolveWith: { data: null, error: { message: 'connection lost' } },
      capturedCalls: [],
    };
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({}),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('db_error_fail_open');
  });

  it('config QW_7_COOLDOWN_MIN=30 → utilise 30 min, pas 60', async () => {
    const query: QueryShape = {
      resolveWith: { data: [], error: null },
      capturedCalls: [],
    };
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({ QW_7_COOLDOWN_MIN: '30' }),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await svc.check(baseSignal);
    const expectedCutoff = new Date(now - 30 * 60_000).toISOString();
    expect(query.capturedCalls[0].filters.gte_exit_timestamp).toBe(expectedCutoff);
  });

  it('config QW_7_TARGET_CLASSES=us_equity_large seulement → us_equity_small_mid passe', async () => {
    const svc = new Qw7CooldownPostTpUsService(
      makeConfig({ QW_7_TARGET_CLASSES: 'us_equity_large' }),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, assetClass: 'us_equity_small_mid' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('class_not_eligible');
  });
});
