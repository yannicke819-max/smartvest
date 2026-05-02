/**
 * P18 — Unit tests for the 3 LLM call sites wired into TopGainersScannerService.
 *
 * Tests the three private helpers via (service as any) cast:
 *   - analyzeSignal  : signal validation per candidate
 *   - rankCandidates : LLM re-ranking of top-N batch
 *   - generateThesis : thesis text generation for a position
 *
 * Each call site is tested for 3 scenarios:
 *   A. Router disabled (SCANNER_LLM_ROUTER_ENABLED=false) → deterministic fallback
 *   B. Router enabled, LLM succeeds → parsed LLM response used
 *   C. Router enabled, LLM fails (throw) → deterministic fallback (resilience)
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';
import { ScannerLlmRouterService } from '../services/scanner-llm-router.service';

// ── Minimal stubs for constructor dependencies ──────────────────────────────

const mockSupabase = { getClient: jest.fn() } as any;
const mockLisa = {} as any;
const mockDecisionLog = {} as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = {} as any;
const mockScheduler = { getCronJob: jest.fn().mockImplementation(() => { throw new Error('not found'); }), addCronJob: jest.fn() } as any;
const mockMtf = {} as any;

// Suppress logger output in tests
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeLlmRouter(isEnabled: boolean, callImpl?: jest.Mock): ScannerLlmRouterService {
  return {
    isEnabled: jest.fn().mockReturnValue(isEnabled),
    call: callImpl ?? jest.fn(),
  } as unknown as ScannerLlmRouterService;
}

function makeService(llmRouter: ScannerLlmRouterService): TopGainersScannerService {
  mockConfig.get.mockImplementation((key: string) => {
    if (key === 'SCAN_INTERVAL_MINUTES') return '15';
    return undefined;
  });
  return new TopGainersScannerService(
    mockSupabase,
    mockLisa,
    mockDecisionLog,
    mockConfig,
    mockBinance,
    mockScheduler,
    mockMtf,
    llmRouter,
    { isShadowEnabled: () => false } as any,
  );
}

const baseCand = {
  symbol: 'BTCUSDT',
  exchange: 'BINANCE',
  assetClass: 'crypto' as const,
  changePct: 5.3,
  close: 65000,
  high: 66000,
  volume: 1_000_000,
  avgVol50d: 900_000,
  marketCap: 0,
  score: 0.82,
};

const basePersistence = {
  symbol: 'BTCUSDT',
  persistenceScore: 0.83,
  persistenceCount: '5/6',
  availableCount: 6,
  tf1m: 0.002,
  tf5m: 0.018,
  tf10m: 0.031,
  tf15m: 0.044,
  tf30m: 0.062,
  tf1h: 0.091,
  pathQuality: { overallEfficiency: 0.75, overallSmoothness: 'smooth' as const },
};

// ── analyzeSignal ────────────────────────────────────────────────────────────

describe('analyzeSignal', () => {
  it('A: returns deterministic fallback when router is disabled', async () => {
    const svc = makeService(makeLlmRouter(false));
    const result = await (svc as any).analyzeSignal(baseCand, basePersistence);
    expect(result.pass).toBe(true);
    expect(result.signal_quality).toBe(1.0);
    expect(result.reason).toBe('deterministic_fallback');
  });

  it('B: returns parsed LLM response when router is enabled and call succeeds', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: JSON.stringify({ pass: true, signal_quality: 0.87, reason: 'strong multi-TF persistence' }),
      providerId: 'gemini-flash-lite',
      costUsd: 0.00011,
      latencyMs: 800,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).analyzeSignal(baseCand, basePersistence);
    expect(result.pass).toBe(true);
    expect(result.signal_quality).toBe(0.87);
    expect(result.reason).toBe('strong multi-TF persistence');
    expect(callMock).toHaveBeenCalledTimes(1);
    const callArg = callMock.mock.calls[0][0];
    expect(callArg.temperature).toBe(0.1);
    expect(callArg.maxTokens).toBe(128);
    expect(JSON.parse(callArg.user).symbol).toBe('BTCUSDT');
    expect(JSON.parse(callArg.user).persistenceScore).toBe(0.83);
  });

  it('B: sets pass=false when LLM returns signal_quality < 0.4', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: JSON.stringify({ pass: false, signal_quality: 0.22, reason: 'thin volume + spike pattern' }),
      providerId: 'gemini-flash-lite',
      costUsd: 0.00009,
      latencyMs: 650,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).analyzeSignal(baseCand, basePersistence);
    expect(result.pass).toBe(false);
    expect(result.signal_quality).toBe(0.22);
  });

  it('C: falls back to deterministic pass=true when LLM call throws', async () => {
    const callMock = jest.fn().mockRejectedValue(new Error('AllProvidersFailedError'));
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).analyzeSignal(baseCand, basePersistence);
    expect(result.pass).toBe(true);
    expect(result.reason).toBe('deterministic_fallback');
  });

  it('C: falls back when LLM returns invalid JSON', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: 'not valid json !!',
      providerId: 'gemini-flash-lite',
      costUsd: 0.00001,
      latencyMs: 300,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).analyzeSignal(baseCand, basePersistence);
    expect(result.pass).toBe(true);
    expect(result.reason).toBe('deterministic_fallback');
  });
});

// ── rankCandidates ───────────────────────────────────────────────────────────

const candA = { ...baseCand, symbol: 'BTCUSDT', score: 0.82 };
const candB = { ...baseCand, symbol: 'ETHUSDT', exchange: 'BINANCE', score: 0.76 };
const candC = { ...baseCand, symbol: 'SOLUSDT', exchange: 'BINANCE', score: 0.71 };

describe('rankCandidates', () => {
  it('A: returns same order when router is disabled', async () => {
    const svc = makeService(makeLlmRouter(false));
    const result = await (svc as any).rankCandidates([candA, candB, candC]);
    expect(result.map((c: typeof candA) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('A: returns same order when only 1 candidate (no LLM needed)', async () => {
    const callMock = jest.fn();
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).rankCandidates([candA]);
    expect(result).toEqual([candA]);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('B: re-orders candidates according to LLM response', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: JSON.stringify(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']),
      providerId: 'gemini-flash-lite',
      costUsd: 0.00013,
      latencyMs: 900,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).rankCandidates([candA, candB, candC]);
    expect(result.map((c: typeof candA) => c.symbol)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
  });

  it('B: appends unknown symbols from LLM at end (graceful gap fill)', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: JSON.stringify(['BTCUSDT']),  // LLM omits ETHUSDT and SOLUSDT
      providerId: 'gemini-flash-lite',
      costUsd: 0.00010,
      latencyMs: 700,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).rankCandidates([candA, candB, candC]);
    expect(result[0].symbol).toBe('BTCUSDT');
    // Missing symbols are appended in original order
    const remaining = result.slice(1).map((c: typeof candA) => c.symbol);
    expect(remaining).toContain('ETHUSDT');
    expect(remaining).toContain('SOLUSDT');
  });

  it('C: returns deterministic order when LLM throws', async () => {
    const callMock = jest.fn().mockRejectedValue(new Error('timeout'));
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).rankCandidates([candA, candB, candC]);
    expect(result.map((c: typeof candA) => c.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });
});

// ── generateThesis ───────────────────────────────────────────────────────────

describe('generateThesis', () => {
  it('A: returns deterministic fallback when router is disabled', async () => {
    const svc = makeService(makeLlmRouter(false));
    const result = await (svc as any).generateThesis(baseCand);
    expect(result.summary).toContain('BTCUSDT');
    expect(result.summary).toContain('+5.3%');
    expect(result.category).toBe('flow_timing');
    expect(result.conviction_score).toBe(7);
  });

  it('B: returns parsed LLM thesis when router is enabled and call succeeds', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'BTCUSDT breaks ATH with 5.3% surge on high volume',
        category: 'technical_breakout',
        conviction_score: 9,
      }),
      providerId: 'gemini-flash-lite',
      costUsd: 0.00012,
      latencyMs: 750,
      fallbackUsed: false,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).generateThesis(baseCand);
    expect(result.summary).toBe('BTCUSDT breaks ATH with 5.3% surge on high volume');
    expect(result.category).toBe('technical_breakout');
    expect(result.conviction_score).toBe(9);
    const callArg = callMock.mock.calls[0][0];
    expect(callArg.temperature).toBe(0.2);
    expect(callArg.maxTokens).toBe(128);
    expect(JSON.parse(callArg.user).symbol).toBe('BTCUSDT');
  });

  it('C: falls back to deterministic template when LLM throws', async () => {
    const callMock = jest.fn().mockRejectedValue(new Error('AllProvidersFailedError'));
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).generateThesis(baseCand);
    expect(result.summary).toContain('TopGainer BTCUSDT');
    expect(result.category).toBe('flow_timing');
    expect(result.conviction_score).toBe(7);
  });

  it('C: falls back when LLM returns malformed JSON', async () => {
    const callMock = jest.fn().mockResolvedValue({
      content: '{"summary":"incomplete',
      providerId: 'gpt-4.1-nano',
      costUsd: 0.00005,
      latencyMs: 400,
      fallbackUsed: true,
    });
    const svc = makeService(makeLlmRouter(true, callMock));
    const result = await (svc as any).generateThesis(baseCand);
    expect(result.summary).toContain('TopGainer BTCUSDT');
    expect(result.category).toBe('flow_timing');
  });
});
