import { ConfigService } from '@nestjs/config';
import { QuickWinsPipelineService } from '../quick-wins-pipeline.service';
import { Qw1SessionFilterService } from '../qw-1-session-filter.service';
import { Qw6SymbolBlacklistService } from '../qw-6-symbol-blacklist.service';
import { Qw11AssetClassGateService } from '../qw-11-asset-class-gate.service';
import { Qw17RepeatSymbolCapService } from '../qw-17-repeat-symbol-cap.service';
import { Qw18ExchangeMultiplierService } from '../qw-18-exchange-multiplier.service';
import type { QwDecisionLoggerService } from '../qw-decision-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

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

function makePipeline(envOverrides: Record<string, string> = {}): QuickWinsPipelineService {
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
    new Qw1SessionFilterService(cfg, logger),
    new Qw6SymbolBlacklistService(cfg, logger),
    new Qw11AssetClassGateService(cfg, logger),
    new Qw17RepeatSymbolCapService(cfg, supabase, logger),
    new Qw18ExchangeMultiplierService(cfg, logger),
  );
}

describe('QuickWinsPipelineService', () => {
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

  it('cascade short-circuits on first block (QW#1 fires before QW#6)', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'CGNX',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T14:30:00Z',
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_1');
    }
    expect(r.qwTrace).toHaveLength(1);
  });

  it('passes all gates → pass result with empty modifications', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      timestamp: '2026-05-20T16:00:00Z',
    });
    expect(r.decision).toBe('pass');
  });

  it('QW#18 .SHE applies sizing multiplier 1.5 when all upstream pass', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: '600519.SHE',
      assetClass: 'asia_equity',
      timestamp: '2026-05-20T05:00:00Z',
      score: 2.0,
    });
    expect(r.decision).toBe('modify');
    if (r.decision === 'modify') {
      expect(r.sizingMultiplier).toBe(1.5);
      expect(r.modifications[0]).toContain('QW_18');
    }
  });

  it('QW#11 blocks us_equity_small_mid before reaching QW#17', async () => {
    const pipeline = makePipeline();
    const r = await pipeline.evaluate({
      symbol: 'AAPL',
      assetClass: 'us_equity_small_mid',
      timestamp: '2026-05-20T16:00:00Z',
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
    });
    expect(r.decision).toBe('block');
    if (r.decision === 'block') {
      expect(r.blockedBy).toBe('QW_6');
    }
  });
});
