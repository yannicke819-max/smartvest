import { ConfigService } from '@nestjs/config';
import { Qw1SessionFilterService } from '../qw-1-session-filter.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

function makeLogger(): QwDecisionLoggerService & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    log: (entry: unknown) => {
      calls.push(entry);
    },
    calls,
  } as unknown as QwDecisionLoggerService & { calls: unknown[] };
}

describe('Qw1SessionFilterService', () => {
  describe('us_equity_large — Règle D : skip 14-16h UTC absolu', () => {
    it.each<[string, string, 'block' | 'pass']>([
      ['14h UTC Wednesday', '2026-05-20T14:30:00Z', 'block'],
      ['15h UTC Wednesday', '2026-05-20T15:45:00Z', 'block'],
      ['14h UTC FRIDAY (pas d exception)', '2026-05-22T14:30:00Z', 'block'],
      ['13h UTC Wednesday', '2026-05-20T13:30:00Z', 'pass'],
      ['16h UTC Wednesday', '2026-05-20T16:00:00Z', 'pass'],
    ])('%s → %s', (_label, ts, expected) => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      const result = svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: ts });
      expect(result.decision).toBe(expected);
    });
  });

  describe('eu_equity — exception Friday', () => {
    it('8h UTC Monday → block', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      expect(
        svc.check({ symbol: 'MC.PA', assetClass: 'eu_equity', timestamp: '2026-05-18T08:30:00Z' }).decision,
      ).toBe('block');
    });

    it('8h UTC Friday → pass (exception)', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      expect(
        svc.check({ symbol: 'MC.PA', assetClass: 'eu_equity', timestamp: '2026-05-22T08:15:00Z' }).decision,
      ).toBe('pass');
    });

    it('9h UTC Monday → pass (outside skip window)', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      expect(
        svc.check({ symbol: 'MC.PA', assetClass: 'eu_equity', timestamp: '2026-05-18T09:30:00Z' }).decision,
      ).toBe('pass');
    });
  });

  describe('asia_equity — skip 1-2h UTC', () => {
    it('1h UTC → block', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      expect(
        svc.check({ symbol: '005930.KO', assetClass: 'asia_equity', timestamp: '2026-05-20T01:30:00Z' }).decision,
      ).toBe('block');
    });

    it('3h UTC → pass', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      expect(
        svc.check({ symbol: '005930.KO', assetClass: 'asia_equity', timestamp: '2026-05-20T03:30:00Z' }).decision,
      ).toBe('pass');
    });
  });

  describe('flag disabled', () => {
    it('pass everything when QW_1_SESSION_FILTER=false', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'false' }),
        makeLogger(),
      );
      const result = svc.check({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        timestamp: '2026-05-20T14:30:00Z',
      });
      expect(result.decision).toBe('pass');
      expect(result.reason).toBe('flag_disabled');
    });
  });

  describe('observability — Règle E', () => {
    it('log block decision in qw_decision_log', () => {
      const logger = makeLogger();
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        logger,
      );
      svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: '2026-05-20T14:30:00Z' });
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]).toMatchObject({
        qwId: 'QW_1',
        decision: 'block',
        wouldHavePassedWithoutFlag: true,
      });
    });

    it('do not log on pass', () => {
      const logger = makeLogger();
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        logger,
      );
      svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: '2026-05-20T13:00:00Z' });
      expect(logger.calls).toHaveLength(0);
    });
  });

  describe('unknown class', () => {
    it('pass when no rule applies', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      const result = svc.check({
        symbol: 'EURUSD.FOREX',
        assetClass: 'fx_major',
        timestamp: '2026-05-20T14:30:00Z',
      });
      expect(result.decision).toBe('pass');
      expect(result.reason).toBe('no_rule_for_class');
    });
  });

  describe('invalid timestamp', () => {
    it('pass safely on garbage timestamp', () => {
      const svc = new Qw1SessionFilterService(
        makeConfig({ QW_1_SESSION_FILTER: 'true' }),
        makeLogger(),
      );
      const result = svc.check({
        symbol: 'AAPL',
        assetClass: 'us_equity_large',
        timestamp: 'not-a-date',
      });
      expect(result.decision).toBe('pass');
      expect(result.reason).toBe('invalid_timestamp');
    });
  });
});
