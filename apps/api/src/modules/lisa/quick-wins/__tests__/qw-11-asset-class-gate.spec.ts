import { ConfigService } from '@nestjs/config';
import { Qw11AssetClassGateService } from '../qw-11-asset-class-gate.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { log: (e: unknown) => calls.push(e), calls } as unknown as QwDecisionLoggerService & {
    calls: unknown[];
  };
}

describe('Qw11AssetClassGateService', () => {
  it('default: blocks us_equity_small_mid', () => {
    const svc = new Qw11AssetClassGateService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: 'now' }).decision,
    ).toBe('block');
  });

  it('default: passes us_equity_large', () => {
    const svc = new Qw11AssetClassGateService(makeConfig({}), makeLogger());
    expect(svc.check({ symbol: 'X', assetClass: 'us_equity_large', timestamp: 'now' }).decision).toBe(
      'pass',
    );
  });

  it('custom env: pause multiple classes', () => {
    const svc = new Qw11AssetClassGateService(
      makeConfig({ PAUSED_ASSET_CLASSES: 'crypto_major,asia_equity' }),
      makeLogger(),
    );
    expect(svc.check({ symbol: 'BTC', assetClass: 'crypto_major', timestamp: 'now' }).decision).toBe(
      'block',
    );
    expect(svc.check({ symbol: 'X.KO', assetClass: 'asia_equity', timestamp: 'now' }).decision).toBe(
      'block',
    );
    expect(
      svc.check({ symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: 'now' }).decision,
    ).toBe('pass');
  });

  it('empty env: no class paused', () => {
    const svc = new Qw11AssetClassGateService(
      makeConfig({ PAUSED_ASSET_CLASSES: '' }),
      makeLogger(),
    );
    expect(
      svc.check({ symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: 'now' }).decision,
    ).toBe('pass');
  });

  it('logs block with shadow flag', () => {
    const logger = makeLogger();
    const svc = new Qw11AssetClassGateService(makeConfig({}), logger);
    svc.check({ symbol: 'X', assetClass: 'us_equity_small_mid', timestamp: 'now' });
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_11',
      decision: 'block',
      reason: 'class_paused',
      wouldHavePassedWithoutFlag: true,
    });
  });
});
