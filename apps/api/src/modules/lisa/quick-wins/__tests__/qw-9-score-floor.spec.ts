import { ConfigService } from '@nestjs/config';
import { Qw9ScoreFloorService } from '../qw-9-score-floor.service';
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

describe('Qw9ScoreFloorService', () => {
  describe('default floors par classe', () => {
    const svc = new Qw9ScoreFloorService(makeConfig({}), makeLogger());
    it.each<[string, number, 'pass' | 'block']>([
      ['asia_equity', 0.94, 'block'],
      ['asia_equity', 0.96, 'pass'],
      ['eu_equity', 0.94, 'block'],
      ['eu_equity', 0.95, 'pass'],
      ['us_equity_large', 0.79, 'block'],
      ['us_equity_large', 0.80, 'pass'],
      ['us_equity_small_mid', 0.90, 'block'],
      ['us_equity_small_mid', 0.95, 'pass'],
      ['crypto_major', 0.60, 'block'],
      ['crypto_major', 0.66, 'pass'],
    ])('%s score=%f → %s', (cls, score, expected) => {
      const r = svc.check({ symbol: 'X', assetClass: cls, timestamp: 'now', score });
      expect(r.decision).toBe(expected);
    });
  });

  it('score null → pass (data manquante)', () => {
    const svc = new Qw9ScoreFloorService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'X', assetClass: 'crypto_major', timestamp: 'now', score: null }).decision,
    ).toBe('pass');
  });

  it('classe inconnue → pass', () => {
    const svc = new Qw9ScoreFloorService(makeConfig({}), makeLogger());
    expect(
      svc.check({ symbol: 'EURUSD', assetClass: 'fx_major', timestamp: 'now', score: 0.1 }).decision,
    ).toBe('pass');
  });

  it('env override prend le pas', () => {
    const svc = new Qw9ScoreFloorService(
      makeConfig({ QW9_SCORE_MIN_CRYPTO: '0.9' }),
      makeLogger(),
    );
    expect(
      svc.check({ symbol: 'BTC', assetClass: 'crypto_major', timestamp: 'now', score: 0.7 }).decision,
    ).toBe('block');
  });

  it('logs block avec shadow flag', () => {
    const logger = makeLogger();
    const svc = new Qw9ScoreFloorService(makeConfig({}), logger);
    svc.check({ symbol: 'BTC', assetClass: 'crypto_major', timestamp: 'now', score: 0.3 });
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_9',
      decision: 'block',
      reason: 'score_below_floor',
      wouldHavePassedWithoutFlag: true,
    });
  });
});
