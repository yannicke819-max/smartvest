import { ConfigService } from '@nestjs/config';
import { QuickWinsPipelineService } from '../quick-wins-pipeline.service';
import { Qw1SessionFilterService } from '../qw-1-session-filter.service';
import { Qw4RegimeFilterService } from '../qw-4-regime-filter.service';
import { Qw6SymbolBlacklistService } from '../qw-6-symbol-blacklist.service';
import { Qw9ScoreFloorService } from '../qw-9-score-floor.service';
import { Qw11AssetClassGateService } from '../qw-11-asset-class-gate.service';
import { Qw14aFridayEuBoostService } from '../qw-14a-friday-eu-boost.service';
import { Qw15FirstTradeBoostService } from '../qw-15-first-trade-boost.service';
import { Qw17RepeatSymbolCapService } from '../qw-17-repeat-symbol-cap.service';
import { Qw18ExchangeMultiplierService } from '../qw-18-exchange-multiplier.service';
import { Qw27PathEffFloorService } from '../qw-27-path-eff-floor.service';
import { Qw46AsiaDowSkipService } from '../qw-46-asia-dow-skip.service';
import { Qw47LseSkipService } from '../qw-47-lse-skip.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';
import type { LisaCircuitBreakerService } from '../../services/circuit-breaker.service';

function makeConfig(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}
function makeLogger(): QwDecisionLoggerService {
  return { log: () => undefined } as unknown as QwDecisionLoggerService;
}
function makeSupabaseNoop(): SupabaseService {
  return {
    isReady: () => false,
    getClient: () => {
      throw new Error('not ready');
    },
  } as unknown as SupabaseService;
}
function makeCircuitBreakerInactive(): LisaCircuitBreakerService {
  return {
    isActive: () => Promise.resolve(false),
    autoResetIfNewDay: () => Promise.resolve(),
  } as unknown as LisaCircuitBreakerService;
}
function makeCircuitBreakerActive(): LisaCircuitBreakerService {
  return {
    isActive: () => Promise.resolve(true),
    autoResetIfNewDay: () => Promise.resolve(),
  } as unknown as LisaCircuitBreakerService;
}

function makePipeline(
  envOverrides: Record<string, string> = {},
  cb: LisaCircuitBreakerService = makeCircuitBreakerInactive(),
): QuickWinsPipelineService {
  const env: Record<string, string> = {
    QUICK_WINS_PIPELINE_ENABLED: 'true',
    QW_1_SESSION_FILTER: 'true',
    ...envOverrides,
  };
  const cfg = makeConfig(env);
  const logger = makeLogger();
  const supabase = makeSupabaseNoop();
  return new QuickWinsPipelineService(
    cfg,
    cb,
    new Qw1SessionFilterService(cfg, logger),
    new Qw4RegimeFilterService(cfg, supabase, logger),
    new Qw6SymbolBlacklistService(cfg, logger),
    new Qw9ScoreFloorService(cfg, logger),
    new Qw11AssetClassGateService(cfg, logger),
    new Qw15FirstTradeBoostService(cfg, supabase, logger),
    new Qw17RepeatSymbolCapService(cfg, supabase, logger),
    new Qw18ExchangeMultiplierService(cfg, logger),
    new Qw27PathEffFloorService(cfg, logger),
    new Qw46AsiaDowSkipService(cfg, logger),
    new Qw47LseSkipService(cfg, logger),
    new Qw14aFridayEuBoostService(cfg, logger),
  );
}

describe('QuickWinsPipelineService — cascade unifiée PR-1+PR-3+PR-4', () => {
  it('master flag disabled → always pass with empty trace', async () => {
    const pipeline = makePipeline({ QUICK_WINS_PIPELINE_ENABLED: 'false' });
    const r = await pipeline.evaluate({
      symbol: 'CGNX',
      assetClass: 'us_equity_small_mid',
      timestamp: '2026-05-20T14:30:00Z',
    });
    expect(r.decision).toBe('pass');
    expect(r.qwTrace).toHaveLength(0);
  });

  it('circuit breaker actif → block immédiat sans cascade', async () => {
    const pipeline = makePipeline({}, makeCircuitBreakerActive());
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T16:00:00Z',
      portfolioId: '58439d86-3f20-4a60-82a4-307f3f252bc2',
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('CIRCUIT_BREAKER');
    }
    expect(r.qwTrace).toHaveLength(1);
  });

  it('QW#1 us_large 14h UTC → block (QW#46/47 ne s’appliquent pas)', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T14:30:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_1');
    }
  });

  it('QW#46 asia jeudi → block avant QW#1', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: '005930.KO',
      assetClass: 'asia_equity',
      // jeudi 21 mai 2026 (UTC = jeudi Paris)
      timestamp: '2026-05-21T05:00:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_46');
    }
  });

  it('QW#47 .LSE → block tôt dans la cascade', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'SEE.LSE',
      assetClass: 'eu_equity',
      timestamp: '2026-05-20T10:00:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_47');
    }
  });

  it('QW#9 score floor crypto 0.65 — score 0.5 → block', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'BTCUSDT',
      assetClass: 'crypto_major',
      timestamp: '2026-05-20T10:00:00Z',
      score: 0.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_9');
    }
  });

  it('QW#27 path_eff floor 0.6 eu — pathEff 0.4 → block', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-20T10:00:00Z',
      score: 1.5,
      pathEff: 0.4,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_27');
    }
  });

  it('passes all gates → pass result with empty modifications', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T16:00:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('pass');
  });

  it('QW#18 .SHE applies sizing multiplier 1.5 when all upstream pass', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: '600519.SHE',
      assetClass: 'asia_equity',
      // lundi (dow=1, hors skip QW#46 4,5)
      timestamp: '2026-05-18T05:00:00Z',
      score: 2.0,
    });
    expect(r.decision).toBe('modify');
    if (r.decision === 'modify') {
      expect(r.sizingMultiplier).toBe(1.5);
      expect(r.modifications[0]).toContain('QW_18');
    }
  });

  it('QW#11 blocks us_equity_small_mid avant QW#17', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_small_mid',
      timestamp: '2026-05-20T16:00:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_11');
    }
  });

  it('QW#6 blacklist fires after session passes', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'CGNX',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T16:00:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_6');
    }
  });

  it('eu_equity Friday 08h UTC → multiplier final inclut ×1.3 (QW#14A appliqué)', async () => {
    const pipeline = makePipeline();
    // Vendredi 22 mai 2026 08:30 UTC = vendredi 10:30 Paris (dow=5)
    // QW#1 exception eu_friday_pass laisse passer, QW#14A boost ×1.3 ensuite.
    const r = await pipeline.evaluate({
      symbol: 'MC.PA',
      assetClass: 'eu_equity',
      timestamp: '2026-05-22T08:30:00Z',
      score: 1.5,
    });
    expect(r.decision).toBe('modify');
    if (r.decision === 'modify') {
      expect(r.sizingMultiplier).toBeCloseTo(1.3, 10);
      expect(r.modifications.some((m) => m.includes('QW_14A'))).toBe(true);
    }
  });
});
