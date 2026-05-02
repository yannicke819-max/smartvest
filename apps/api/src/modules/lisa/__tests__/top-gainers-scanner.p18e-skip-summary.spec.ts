/**
 * P18e — Tests for TopGainersScanner aggregated cycle skip-summary log.
 *
 * Bug observed in Fly logs 09:14–09:15 UTC : N lines `[top-gainers] <T> no
 * persistence data → skip` per cycle, polluting the log stream.
 *
 * P18e replaces them with ONE line per cycle :
 *   `[top-gainers] cycle skip-summary: scanned=N, retained=R, skipped_no_persistence=S (sample: A, B, C)`
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';
import { ScannerLlmRouterService } from '../services/scanner-llm-router.service';
import type { TopGainerCandidate, TopGainerAssetClass } from '@smartvest/ai-analyst';

// ── Stubs ────────────────────────────────────────────────────────────────

const supabaseFromMock = jest.fn();
const mockSupabase = { getClient: () => ({ from: supabaseFromMock }) } as any;
const mockLisa = {
  approveProposal: jest.fn().mockResolvedValue({ openedPositions: [] }),
} as any;
const mockDecisionLog = {} as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = { getTicker24h: jest.fn().mockResolvedValue(null) } as any;
const mockScheduler = {
  getCronJob: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
  addCronJob: jest.fn(),
} as any;
const mockMtf = { analyzeBatch: jest.fn() } as any;
const mockLlmRouter = { isEnabled: jest.fn().mockReturnValue(false), call: jest.fn() } as any;

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

beforeEach(() => {
  logSpy.mockClear();
  warnSpy.mockClear();
  supabaseFromMock.mockReset();
  mockMtf.analyzeBatch.mockReset();
});

function makeService(): TopGainersScannerService {
  mockConfig.get.mockImplementation((key: string) => {
    if (key === 'SCAN_INTERVAL_MINUTES') return '15';
    return undefined;
  });
  return new TopGainersScannerService(
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: "REJECT", rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any,
  );
}

/**
 * Mock the chained Supabase calls inside scanPortfolio:
 *   getClient().from('lisa_positions').select(...).eq(...).eq(...) → openPositions
 *   getClient().from('lisa_session_configs').select(...).eq(...).maybeSingle() → cfgRow
 */
function mockScanPortfolioSupabase(openPositions: any[] = []) {
  supabaseFromMock.mockImplementation((table: string) => {
    if (table === 'lisa_positions') {
      const eq2 = jest.fn().mockResolvedValue({ data: openPositions, error: null });
      const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
      const select = jest.fn().mockReturnValue({ eq: eq1 });
      return { select };
    }
    if (table === 'lisa_session_configs') {
      const maybeSingle = jest.fn().mockResolvedValue({ data: { gainers_min_persistence_score: null, gainers_min_path_efficiency: null }, error: null });
      const eq = jest.fn().mockReturnValue({ maybeSingle });
      const select = jest.fn().mockReturnValue({ eq });
      return { select };
    }
    return { select: jest.fn() };
  });
}

function makeCandidate(symbol: string): TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass } {
  return {
    symbol,
    exchange: 'US',
    close: 100,
    high: 105,
    changePct: 5,
    volume: 1_000_000,
    avgVol50d: 500_000,
    marketCap: 1e10,
    score: 0.7,
    assetClass: 'us_equity_large',
  };
}

// ── 1. Aggregated cycle log replaces per-symbol spam ────────────────────────

describe('TopGainersScanner — cycle skip-summary log', () => {
  it('emits ONE aggregated log line when ALL candidates have no persistence (was N lines)', async () => {
    mockScanPortfolioSupabase();
    // analyzeBatch returns empty Map → no candidate has persistence
    mockMtf.analyzeBatch.mockResolvedValue(new Map());

    const top = [
      makeCandidate('AAA'),
      makeCandidate('BBB'),
      makeCandidate('CCC'),
    ];
    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', '11111111-1111-1111-1111-111111111111', top);

    // Legacy per-symbol spam must not appear
    const legacySpam = logSpy.mock.calls.filter((c) =>
      /no persistence data → skip/.test(String(c[0])),
    );
    expect(legacySpam.length).toBe(0);

    // Aggregated log IS emitted, exactly once
    const aggregate = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[top-gainers] cycle skip-summary:'),
    );
    expect(aggregate.length).toBe(1);
    const msg = String(aggregate[0][0]);
    expect(msg).toContain('scanned=3');
    expect(msg).toContain('skipped_no_persistence=3');
    expect(msg).toContain('(sample: AAA');
  });

  it('does NOT emit the aggregated log when 0 candidates were skipped for no-persistence', async () => {
    mockScanPortfolioSupabase();
    // All candidates have persistence
    mockMtf.analyzeBatch.mockResolvedValue(new Map([
      ['AAA', { persistenceScore: 0.83, persistenceCount: '5/6', availableCount: 6, tf1m: 0.01, tf5m: 0.02, tf10m: 0.03, tf15m: 0.04, tf30m: 0.05, tf1h: 0.06, pathQuality: { overallEfficiency: 0.8, overallSmoothness: 'smooth' } }],
    ]));
    // approveProposal returns 0 opens (rejected by gates) so we don't end up in INSERT path
    mockLisa.approveProposal.mockResolvedValue({ openedPositions: [] });

    const top = [makeCandidate('AAA')];
    const svc = makeService();
    await (svc as any).scanPortfolio('user-1', '11111111-1111-1111-1111-111111111111', top);

    const aggregate = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[top-gainers] cycle skip-summary:'),
    );
    expect(aggregate.length).toBe(0);
  });

  it('counter `getSkippedNoPersistenceCounter` increments correctly across cycles', async () => {
    mockScanPortfolioSupabase();
    mockMtf.analyzeBatch.mockResolvedValue(new Map());

    const svc = makeService();
    expect(svc.getSkippedNoPersistenceCounter()).toBe(0);

    // Cycle 1 — 2 skipped
    await (svc as any).scanPortfolio('u', 'p1', [makeCandidate('A'), makeCandidate('B')]);
    expect(svc.getSkippedNoPersistenceCounter()).toBe(2);

    // Cycle 2 — 3 skipped
    await (svc as any).scanPortfolio('u', 'p2', [makeCandidate('X'), makeCandidate('Y'), makeCandidate('Z')]);
    expect(svc.getSkippedNoPersistenceCounter()).toBe(5);
  });

  it('truncates sample to first 5 symbols even if 50 are skipped', async () => {
    mockScanPortfolioSupabase();
    mockMtf.analyzeBatch.mockResolvedValue(new Map());

    const top = Array.from({ length: 50 }, (_, i) => makeCandidate(`T${i}`));
    const svc = makeService();
    await (svc as any).scanPortfolio('u', 'p', top);

    const aggregate = logSpy.mock.calls.find((c) =>
      String(c[0]).includes('[top-gainers] cycle skip-summary:'),
    );
    expect(aggregate).toBeDefined();
    const msg = String(aggregate![0]);
    expect(msg).toContain('skipped_no_persistence=50');
    // Sample should contain first 5 (T0..T4) and not all 50
    expect(msg).toMatch(/sample: T0, T1, T2, T3, T4/);
    expect(msg).not.toContain('T49');
  });
});
