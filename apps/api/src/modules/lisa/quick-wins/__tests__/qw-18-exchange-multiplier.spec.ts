import { ConfigService } from '@nestjs/config';
import { Qw18ExchangeMultiplierService } from '../qw-18-exchange-multiplier.service';
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

describe('Qw18ExchangeMultiplierService', () => {
  it('passes non-asia classes', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    expect(svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: 'now' }).decision).toBe(
      'pass',
    );
  });

  it('asia .SHE → modify ×1.5', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '600519.SHE',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: 1.8,
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(1.5);
    expect(r.exchange).toBe('.SHE');
  });

  it('asia .KQ with score >= 1.2 → modify ×0.7', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '059120.KQ',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: 1.5,
    });
    expect(r.decision).toBe('modify');
    expect(r.multiplier).toBe(0.7);
  });

  it('asia .KQ with score < 1.2 → block (Règle B)', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '059120.KQ',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: 0.9,
    });
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('kq_score_below_min');
  });

  it('asia .KQ with null score → block (defensive)', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '059120.KQ',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: null,
    });
    expect(r.decision).toBe('block');
  });

  it('asia .KO (no rule) → pass', () => {
    const svc = new Qw18ExchangeMultiplierService(makeConfig({}), makeLogger());
    const r = svc.check({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: 2.0,
    });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('no_rule_for_suffix');
  });

  it('configurable QW_18_KQ_SCORE_MIN', () => {
    const svc = new Qw18ExchangeMultiplierService(
      makeConfig({ QW_18_KQ_SCORE_MIN: '2.0' }),
      makeLogger(),
    );
    const r = svc.check({
      symbol: '059120.KQ',
      assetClass: 'asia_equity',
      timestamp: 'now',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
  });
});
