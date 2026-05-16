import { ConfigService } from '@nestjs/config';
import { Qw17RepeatSymbolCapService } from '../qw-17-repeat-symbol-cap.service';
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
function makeSupabaseNoop(): SupabaseService {
  return {
    isReady: () => false,
    getClient: () => {
      throw new Error('not ready');
    },
  } as unknown as SupabaseService;
}

describe('Qw17RepeatSymbolCapService', () => {
  it('us_equity_small_mid cap 1: 1st pass, 2nd block', async () => {
    const svc = new Qw17RepeatSymbolCapService(makeConfig({}), makeSupabaseNoop(), makeLogger());
    const sig = { symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: '2026-05-20T15:00:00Z' };
    expect((await svc.check(sig)).decision).toBe('pass');
    expect((await svc.check(sig)).decision).toBe('block');
  });

  it('asia_equity cap 4: 4 pass, 5th block', async () => {
    const svc = new Qw17RepeatSymbolCapService(makeConfig({}), makeSupabaseNoop(), makeLogger());
    const sig = { symbol: '005930.KO', assetClass: 'asia_equity', timestamp: '2026-05-20T05:00:00Z' };
    for (let i = 0; i < 4; i++) {
      expect((await svc.check(sig)).decision).toBe('pass');
    }
    expect((await svc.check(sig)).decision).toBe('block');
  });

  it('unknown class → pass', async () => {
    const svc = new Qw17RepeatSymbolCapService(makeConfig({}), makeSupabaseNoop(), makeLogger());
    const r = await svc.check({
      symbol: 'EURUSD',
      assetClass: 'fx_major',
      timestamp: '2026-05-20T10:00:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_cap_for_class');
  });

  it('different symbols same class share separate counters', async () => {
    const svc = new Qw17RepeatSymbolCapService(makeConfig({}), makeSupabaseNoop(), makeLogger());
    expect(
      (await svc.check({ symbol: 'A', assetClass: 'us_equity_small_mid', timestamp: '2026-05-20T15:00:00Z' }))
        .decision,
    ).toBe('pass');
    expect(
      (await svc.check({ symbol: 'B', assetClass: 'us_equity_small_mid', timestamp: '2026-05-20T15:00:00Z' }))
        .decision,
    ).toBe('pass');
    expect(
      (await svc.check({ symbol: 'A', assetClass: 'us_equity_small_mid', timestamp: '2026-05-20T15:00:00Z' }))
        .decision,
    ).toBe('block');
  });

  it('logs block with cap details', async () => {
    const logger = makeLogger();
    const svc = new Qw17RepeatSymbolCapService(makeConfig({}), makeSupabaseNoop(), logger);
    const sig = { symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: '2026-05-20T15:00:00Z' };
    await svc.check(sig);
    await svc.check(sig);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_17',
      decision: 'block',
      reason: 'repeat_cap_reached',
      wouldHavePassedWithoutFlag: true,
    });
  });
});
