import { ConfigService } from '@nestjs/config';
import { Qw27PathEffFloorService } from '../qw-27-path-eff-floor.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}

describe('Qw27PathEffFloorService', () => {
  const svc = new Qw27PathEffFloorService(makeConfig({}), makeLogger());

  it.each<[string, number, 'pass' | 'block']>([
    ['eu_equity', 0.59, 'block'],
    ['eu_equity', 0.6, 'pass'],
    ['us_equity_large', 0.5, 'block'],
    ['us_equity_small_mid', 0.5, 'block'],
    ['crypto_major', 0.5, 'block'],
    ['asia_equity', 0.29, 'block'],
    ['asia_equity', 0.31, 'pass'],
  ])('%s pathEff=%f → %s', (cls, pathEff, expected) => {
    const r = svc.check({ symbol: 'X', assetClass: cls, timestamp: 'now', pathEff });
    expect(r.decision).toBe(expected);
  });

  it('pathEff null → pass (caller mechanical-trading n a pas la métrique)', () => {
    const r = svc.check({ symbol: 'X', assetClass: 'eu_equity', timestamp: 'now', pathEff: null });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('path_eff_unknown');
  });

  it('classe inconnue → pass', () => {
    const r = svc.check({ symbol: 'EURUSD', assetClass: 'fx_major', timestamp: 'now', pathEff: 0.01 });
    expect(r.decision).toBe('pass');
  });
});
