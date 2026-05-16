import { ConfigService } from '@nestjs/config';
import { Qw47LseSkipService } from '../qw-47-lse-skip.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}

describe('Qw47LseSkipService', () => {
  it('symbol .LSE → block', () => {
    const svc = new Qw47LseSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'SEE.LSE', assetClass: 'eu_equity', timestamp: 'now' }).decision,
    ).toBe('block');
  });

  it('symbol .L (PAS .LSE) → pass', () => {
    const svc = new Qw47LseSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'AAL.L', assetClass: 'eu_equity', timestamp: 'now' }).decision,
    ).toBe('pass');
  });

  it('symbol .PA → pass', () => {
    const svc = new Qw47LseSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'MC.PA', assetClass: 'eu_equity', timestamp: 'now' }).decision,
    ).toBe('pass');
  });

  it('flag disabled → pass', () => {
    const svc = new Qw47LseSkipService(
      makeConfig({ QW47_LSE_SKIP_ENABLED: 'false' }),
      makeLogger(),
    );
    expect(
      svc.check({ symbol: 'SEE.LSE', assetClass: 'eu_equity', timestamp: 'now' }).decision,
    ).toBe('pass');
  });

  it('case insensitive .lse', () => {
    const svc = new Qw47LseSkipService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'see.lse', assetClass: 'eu_equity', timestamp: 'now' }).decision,
    ).toBe('block');
  });
});
