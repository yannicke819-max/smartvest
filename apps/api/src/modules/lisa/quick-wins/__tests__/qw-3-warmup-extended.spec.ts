import { ConfigService } from '@nestjs/config';
import { Qw3WarmupExtendedService } from '../qw-3-warmup-extended.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe('Qw3WarmupExtendedService', () => {
  const svc = new Qw3WarmupExtendedService(makeConfig({}));

  describe('getWarmupMin par classe', () => {
    it.each<[string, number]>([
      ['asia_equity', 15],
      ['eu_equity', 30],
      ['us_equity_large', 30],
      ['us_equity_small_mid', 30],
      ['crypto_major', 30],
    ])('%s → %d min', (cls, expected) => {
      expect(svc.getWarmupMin(cls)).toBe(expected);
    });

    it('classe inconnue → 15 (default conservateur)', () => {
      expect(svc.getWarmupMin('fx_major')).toBe(15);
    });
  });

  describe('shouldBlockSlClose', () => {
    it('us_equity_large age 20min pnl -1% → block (sous fenêtre 30min)', () => {
      expect(svc.shouldBlockSlClose('us_equity_large', 20, -0.01)).toBe(true);
    });

    it('us_equity_large age 31min pnl -1% → pass (fenêtre dépassée)', () => {
      expect(svc.shouldBlockSlClose('us_equity_large', 31, -0.01)).toBe(false);
    });

    it('us_equity_large age 20min pnl -5% → pass (perte catastrophique, on honore)', () => {
      expect(svc.shouldBlockSlClose('us_equity_large', 20, -0.05)).toBe(false);
    });

    it('asia_equity age 20min pnl -1% → pass (fenêtre 15min déjà dépassée)', () => {
      expect(svc.shouldBlockSlClose('asia_equity', 20, -0.01)).toBe(false);
    });

    it('asia_equity age 10min pnl -1% → block (sous fenêtre 15min)', () => {
      expect(svc.shouldBlockSlClose('asia_equity', 10, -0.01)).toBe(true);
    });
  });

  it('env override fenêtre asia', () => {
    const svc2 = new Qw3WarmupExtendedService(makeConfig({ QW3_WARMUP_MIN_ASIA: '20' }));
    expect(svc2.getWarmupMin('asia_equity')).toBe(20);
  });
});
