import { ConfigService } from '@nestjs/config';
import { Qw14aFridayEuBoostService } from '../qw-14a-friday-eu-boost.service';
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

describe('Qw14aFridayEuBoostService', () => {
  it('eu_equity Friday 08:30 UTC → modify x1.3', () => {
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), makeLogger());
    // Vendredi 22 mai 2026, 08:30 UTC (= 10:30 Paris, dow Paris = 5)
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.3);
    expect(r.reason).toBe('friday_eu_boost_x1.3');
  });

  it('eu_equity Monday 08:30 UTC → pass (not_friday_paris)', () => {
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), makeLogger());
    // Lundi 18 mai 2026
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-18T08:30:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('not_friday_paris');
  });

  it('us_equity_large Friday 14h UTC → pass (not_eu_class)', () => {
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-22T14:00:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('not_eu_class');
  });

  it('eu_equity Friday + QW14A_FRIDAY_EU_BOOST_ENABLED=false → pass disabled', () => {
    const svc = new Qw14aFridayEuBoostService(
      makeConfig({ QW14A_FRIDAY_EU_BOOST_ENABLED: 'false' }),
      makeLogger(),
    );
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('disabled');
  });

  it('eu_equity Friday avec QW14A_FRIDAY_EU_MULT=1.5 → multiplier 1.5', () => {
    const svc = new Qw14aFridayEuBoostService(
      makeConfig({ QW14A_FRIDAY_EU_MULT: '1.5' }),
      makeLogger(),
    );
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.5);
  });

  it('eu_equity Friday avec QW14A_FRIDAY_EU_MULT=abc → fallback 1.3', () => {
    const svc = new Qw14aFridayEuBoostService(
      makeConfig({ QW14A_FRIDAY_EU_MULT: 'abc' }),
      makeLogger(),
    );
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.3);
  });

  it('eu_equity Friday avec QW14A_FRIDAY_EU_MULT=3.0 hors range → fallback 1.3', () => {
    const svc = new Qw14aFridayEuBoostService(
      makeConfig({ QW14A_FRIDAY_EU_MULT: '3.0' }),
      makeLogger(),
    );
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.3);
  });

  it('eu_equity invalid timestamp → pass invalid_timestamp', () => {
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: 'garbage',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('invalid_timestamp');
  });

  it('observability — logs decision modify avec shadow flag', () => {
    const logger = makeLogger();
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), logger);
    svc.check({ symbol: 'MC.PA', assetClass: 'eu_equity', timestamp: '2026-05-22T08:30:00Z' });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      qwId: 'QW_14A',
      decision: 'modify',
      wouldHavePassedWithoutFlag: true,
    });
  });

  it('observability — pas de log sur pass', () => {
    const logger = makeLogger();
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), logger);
    svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: '2026-05-22T14:00:00Z' });
    expect(logger.calls).toHaveLength(0);
  });

  it('getDowParis Paris boundary case (samedi UTC = vendredi Paris tard le soir)', () => {
    const svc = new Qw14aFridayEuBoostService(makeConfig({}), makeLogger());
    // Vendredi 22 mai 22:30 UTC = vendredi 22 mai 24:30 (= samedi 00:30) Paris
    // C'est désormais samedi → dow=6
    const r = svc.check({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T22:30:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('not_friday_paris');
  });
});
