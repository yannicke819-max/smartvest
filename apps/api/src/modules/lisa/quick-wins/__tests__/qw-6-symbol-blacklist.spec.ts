import { ConfigService } from '@nestjs/config';
import { Qw6SymbolBlacklistService } from '../qw-6-symbol-blacklist.service';
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

describe('Qw6SymbolBlacklistService', () => {
  describe('default blacklist (CGNX, PODD, ORA, QCOM, ST, PRU)', () => {
    let svc: Qw6SymbolBlacklistService;
    beforeEach(() => {
      svc = new Qw6SymbolBlacklistService(makeConfig({}), makeLogger());
    });

    it.each(['CGNX', 'PODD', 'ORA', 'QCOM', 'ST', 'PRU'])('blocks %s', (sym) => {
      const r = svc.check({ symbol: sym, assetClass: 'us_equity_large', timestamp: '2026-05-20T10:00:00Z' });
      expect(r.decision).toBe('block');
      expect(r.reason).toBe('blacklist_static');
    });

    it('blocks suffixed variants (CGNX.US → CGNX)', () => {
      expect(
        svc.check({ symbol: 'CGNX.US', assetClass: 'us_equity_large', timestamp: '2026-05-20T10:00:00Z' })
          .decision,
      ).toBe('block');
    });

    it('passes AAPL (not in list)', () => {
      expect(
        svc.check({ symbol: 'AAPL', assetClass: 'us_equity_large', timestamp: '2026-05-20T10:00:00Z' })
          .decision,
      ).toBe('pass');
    });

    it('is case-insensitive', () => {
      expect(
        svc.check({ symbol: 'cgnx', assetClass: 'us_equity_large', timestamp: '2026-05-20T10:00:00Z' })
          .decision,
      ).toBe('block');
    });
  });

  describe('custom blacklist via env', () => {
    it('overrides default', () => {
      const svc = new Qw6SymbolBlacklistService(
        makeConfig({ QW_6_SYMBOL_BLACKLIST: 'TSLA,NVDA' }),
        makeLogger(),
      );
      expect(svc.check({ symbol: 'TSLA', assetClass: 'us_equity_large', timestamp: 'now' }).decision).toBe(
        'block',
      );
      expect(svc.check({ symbol: 'CGNX', assetClass: 'us_equity_large', timestamp: 'now' }).decision).toBe(
        'pass',
      );
    });

    it('empty string disables', () => {
      const svc = new Qw6SymbolBlacklistService(
        makeConfig({ QW_6_SYMBOL_BLACKLIST: '' }),
        makeLogger(),
      );
      expect(svc.check({ symbol: 'CGNX', assetClass: 'us_equity_large', timestamp: 'now' }).decision).toBe(
        'pass',
      );
    });
  });

  describe('observability', () => {
    it('logs on block with shadow flag', () => {
      const logger = makeLogger();
      const svc = new Qw6SymbolBlacklistService(makeConfig({}), logger);
      svc.check({ symbol: 'CGNX', assetClass: 'us_equity_large', timestamp: '2026-05-20T10:00:00Z' });
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]).toMatchObject({
        qwId: 'QW_6',
        decision: 'block',
        reason: 'blacklist_static',
        wouldHavePassedWithoutFlag: true,
      });
    });
  });
});
