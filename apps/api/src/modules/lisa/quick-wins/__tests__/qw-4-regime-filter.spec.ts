import { ConfigService } from '@nestjs/config';
import { Qw4RegimeFilterService } from '../qw-4-regime-filter.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}

function makeSupabaseWithVol(values: Array<number | null>): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from: (_table: string) => ({
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            gte: (_col2: string, _val2: string) => ({
              limit: (_n: number) =>
                Promise.resolve({
                  data: values.map((v) => ({ change_pct_1m: v })),
                  error: null,
                }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseService;
}

function makeSupabaseNoop(): SupabaseService {
  return {
    isReady: () => false,
    getClient: () => {
      throw new Error('not ready');
    },
  } as unknown as SupabaseService;
}

describe('Qw4RegimeFilterService', () => {
  it('non-asia → pass', async () => {
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseWithVol([1, 2, 3]),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: 'now',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('not_asia_class');
  });

  it('asia + vol in range [1.4, 2.0] → pass', async () => {
    // stddev of [1,2,3,4,5] = sqrt(2) ≈ 1.414  → in range
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseWithVol([1, 2, 3, 4, 5]),
      makeLogger(),
    );
    const r = await svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: 'now' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toMatch(/regime_in_range/);
  });

  it('asia + vol < 1.4 → block', async () => {
    // very low spread → small stddev
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseWithVol([1, 1, 1, 1, 1.1, 1.05]),
      makeLogger(),
    );
    const r = await svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: 'now' });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('regime_extreme_vol');
  });

  it('asia + vol > 2.0 → block', async () => {
    // wide spread → high stddev
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseWithVol([-10, -5, 0, 5, 10]),
      makeLogger(),
    );
    const r = await svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: 'now' });
    expect(r.decision).toBe('block');
  });

  it('asia + data <5 → pass (fail-open)', async () => {
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseWithVol([1, 2]),
      makeLogger(),
    );
    const r = await svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: 'now' });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('regime_data_insufficient');
  });

  it('Supabase not ready → pass', async () => {
    const svc = new Qw4RegimeFilterService(
      makeConfig({}),
      makeSupabaseNoop(),
      makeLogger(),
    );
    const r = await svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: 'now' });
    expect(r.decision).toBe('pass');
  });
});
