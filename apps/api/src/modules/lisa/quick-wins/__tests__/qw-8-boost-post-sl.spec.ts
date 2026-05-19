import { ConfigService } from '@nestjs/config';
import { Qw8BoostPostSlService } from '../qw-8-boost-post-sl.service';
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
          order: (col: string, opts: unknown) => {
            filters[`order_${col}`] = opts;
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

describe('Qw8BoostPostSlService', () => {
  const baseSignal = {
    symbol: 'AAPL.US',
    assetClass: 'us_equity_large',
    timestamp: '2026-05-20T15:30:00Z',
    portfolioId: 'pf-1',
  };

  it('class non éligible (asia_equity) → pass class_not_eligible', async () => {
    const svc = new Qw8BoostPostSlService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, assetClass: 'asia_equity' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('class_not_eligible');
  });

  it('eu_equity est inclus par défaut → pass no_recent_sl quand supabase OK + 0 ligne', async () => {
    const query: QueryShape = {
      resolveWith: { data: [], error: null },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(makeConfig({}), makeSupabaseWith(query), makeLogger());
    const r = await svc.check({ ...baseSignal, assetClass: 'eu_equity' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_recent_sl');
  });

  it('no portfolioId → pass no_portfolio_id', async () => {
    const svc = new Qw8BoostPostSlService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, portfolioId: null });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_portfolio_id');
  });

  it('supabase not ready → fail-open pass supabase_not_ready', async () => {
    const svc = new Qw8BoostPostSlService(
      makeConfig({}),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('supabase_not_ready');
  });

  it('aucune ligne récente SL → pass no_recent_sl', async () => {
    const query: QueryShape = {
      resolveWith: { data: [], error: null },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(makeConfig({}), makeSupabaseWith(query), makeLogger());
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_recent_sl');
    expect(query.capturedCalls[0].table).toBe('lisa_positions');
    expect(query.capturedCalls[0].filters.eq_status).toBe('closed_stop');
    expect(query.capturedCalls[0].filters.eq_symbol).toBe('AAPL.US');
  });

  it('SL récent < 30min → modify boost_post_sl avec multiplier 1.5 + logger appelé', async () => {
    const logger = makeLogger();
    const query: QueryShape = {
      resolveWith: {
        data: [{ id: 'p999', exit_timestamp: '2026-05-20T15:15:00Z' }],
        error: null,
      },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(makeConfig({}), makeSupabaseWith(query), logger);
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('modify');
    expect(r.reason).toBe('boost_post_sl');
    expect(r.multiplier).toBe(1.5);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_8',
      decision: 'modify',
      reason: 'boost_post_sl',
      wouldHavePassedWithoutFlag: true,
    });
  });

  it('Supabase erreur → fail-open pass db_error_fail_open', async () => {
    const query: QueryShape = {
      resolveWith: { data: null, error: { message: 'connection lost' } },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(
      makeConfig({}),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('db_error_fail_open');
  });

  it('config QW_8_MULTIPLIER=2.0 → utilise 2.0 sur match', async () => {
    const query: QueryShape = {
      resolveWith: {
        data: [{ id: 'p1', exit_timestamp: '2026-05-20T15:20:00Z' }],
        error: null,
      },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(
      makeConfig({ QW_8_MULTIPLIER: '2.0' }),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(2.0);
  });

  it('config QW_8_MULTIPLIER hors bornes (5.0) → fallback 1.5', async () => {
    const query: QueryShape = {
      resolveWith: {
        data: [{ id: 'p1', exit_timestamp: '2026-05-20T15:20:00Z' }],
        error: null,
      },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(
      makeConfig({ QW_8_MULTIPLIER: '5.0' }),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const r = await svc.check(baseSignal);
    expect(r.multiplier).toBe(1.5);
  });

  it('config QW_8_WINDOW_MIN=15 → cutoff 15 min', async () => {
    const query: QueryShape = {
      resolveWith: { data: [], error: null },
      capturedCalls: [],
    };
    const svc = new Qw8BoostPostSlService(
      makeConfig({ QW_8_WINDOW_MIN: '15' }),
      makeSupabaseWith(query),
      makeLogger(),
    );
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await svc.check(baseSignal);
    const expectedCutoff = new Date(now - 15 * 60_000).toISOString();
    expect(query.capturedCalls[0].filters.gte_exit_timestamp).toBe(expectedCutoff);
  });

  it('config QW_8_TARGET_CLASSES=us_equity_large seulement → eu_equity bloqué', async () => {
    const svc = new Qw8BoostPostSlService(
      makeConfig({ QW_8_TARGET_CLASSES: 'us_equity_large' }),
      makeSupabaseNotReady(),
      makeLogger(),
    );
    const r = await svc.check({ ...baseSignal, assetClass: 'eu_equity' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('class_not_eligible');
  });
});
