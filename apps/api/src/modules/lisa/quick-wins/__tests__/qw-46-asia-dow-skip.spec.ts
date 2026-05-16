import { ConfigService } from '@nestjs/config';
import { Qw46AsiaDowSkipService } from '../qw-46-asia-dow-skip.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}

describe('Qw46AsiaDowSkipService', () => {
  it('asia equity jeudi Paris → block', () => {
    const svc = new Qw46AsiaDowSkipService(makeConfig({}), makeLogger());
    // jeudi 21 mai 2026 11:00 UTC → 13:00 Paris jeudi (dow=4)
    const r = svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: '2026-05-21T11:00:00Z',
    });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('asia_thursday_friday_skip');
  });

  it('asia equity vendredi Paris → block', () => {
    const svc = new Qw46AsiaDowSkipService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: '2026-05-22T11:00:00Z',
    });
    expect(r.decision).toBe('block');
  });

  it('asia equity lundi/mardi/mercredi Paris → pass', () => {
    const svc = new Qw46AsiaDowSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: '2026-05-18T05:00:00Z' }).decision,
    ).toBe('pass'); // lundi
    expect(
      svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: '2026-05-19T05:00:00Z' }).decision,
    ).toBe('pass'); // mardi
    expect(
      svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: '2026-05-20T05:00:00Z' }).decision,
    ).toBe('pass'); // mercredi
  });

  it('non-asia jeudi → pass', () => {
    const svc = new Qw46AsiaDowSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: '2026-05-21T11:00:00Z' })
        .decision,
    ).toBe('pass');
  });

  it('env override skip uniquement lundi', () => {
    const svc = new Qw46AsiaDowSkipService(
      makeConfig({ QW46_ASIA_SKIP_DOW: '1' }),
      makeLogger(),
    );
    expect(
      svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: '2026-05-18T05:00:00Z' }).decision,
    ).toBe('block');
    expect(
      svc.check({ symbol: 'X', assetClass: 'asia_equity', timestamp: '2026-05-21T05:00:00Z' }).decision,
    ).toBe('pass');
  });
});
