import { ConfigService } from '@nestjs/config';
import { Qw15FirstTradeBoostService } from '../qw-15-first-trade-boost.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}

function makeSupabaseWithCount(count: number | null): SupabaseService {
  return {
    isReady: () => true,
    getClient: () => ({
      from: (_table: string) => ({
        select: (_cols: string, _opts: unknown) => ({
          eq: (_c: string, _v: string) => ({
            eq: (_c2: string, _v2: string) => ({
              gte: (_c3: string, _v3: string) => Promise.resolve({ count, error: null }),
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

const PORTFOLIO_ID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

describe('Qw15FirstTradeBoostService', () => {
  it('classe non boostable (us_equity_large) → pass', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseWithCount(0),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: 'now',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('class_not_boostable');
  });

  it('asia + first trade du jour → modify x1.15', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseWithCount(0),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: '2026-05-19T05:00:00Z',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.15);
    expect(r.reason).toBe('first_trade_boost');
  });

  it('crypto + first trade → modify x1.15', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseWithCount(0),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: 'BTCUSDT',
      assetClass: 'crypto_major',
      timestamp: '2026-05-19T05:00:00Z',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.15);
  });

  it('asia + repeat trade (count > 0) → pass', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseWithCount(3),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: '2026-05-19T05:00:00Z',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('not_first_trade_of_day');
  });

  it('portfolioId manquant → pass', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseWithCount(0),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: 'now',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('portfolio_id_missing');
  });

  it('Supabase not ready → pass', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({}),
      makeSupabaseNoop(),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: 'now',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('pass');
  });

  it('env override multiplier', async () => {
    const svc = new Qw15FirstTradeBoostService(
      makeConfig({ QW15_FIRST_TRADE_BOOST_ASIA: '1.30' }),
      makeSupabaseWithCount(0),
      makeLogger(),
    );
    const r = await svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: '2026-05-19T05:00:00Z',
      portfolioId: PORTFOLIO_ID,
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.3);
  });
});
