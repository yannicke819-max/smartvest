/**
 * P18d — Unit tests for EU session-aware exchange gating in TopGainersScannerService.
 *
 * Three scenarios required by issue #81:
 *   1. EU exchanges scanned only during cac40/dax40/ftse100 session windows
 *   2. EU exchanges skipped when all 3 EU sessions are closed
 *   3. fetchAllCandidates returns merged US+EU+ASIA candidates without duplicates
 *      (dedup by symbol+exchange tuple)
 *   + bonus: detectAssetClass returns 'eu_equity' for LSE/XETRA/PA tickers
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';
import { ScannerLlmRouterService } from '../services/scanner-llm-router.service';
import { detectAssetClass } from '@smartvest/ai-analyst';

// ── Stubs ──────────────────────────────────────────────────────────────────

const supabaseFromMock = jest.fn();
const mockSupabase = { getClient: () => ({ from: supabaseFromMock }) } as any;
const mockLisa = {} as any;
const mockDecisionLog = {} as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = { getTicker24h: jest.fn().mockResolvedValue(null) } as any;
const mockScheduler = {
  getCronJob: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
  addCronJob: jest.fn(),
} as any;
const mockMtf = {} as any;
const mockLlmRouter = { isEnabled: jest.fn().mockReturnValue(false), call: jest.fn() } as any;

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

function makeService(): TopGainersScannerService {
  mockConfig.get.mockImplementation((key: string) => {
    if (key === 'SCAN_INTERVAL_MINUTES') return '15';
    if (key === 'EODHD_API_KEY') return 'test-key';
    return undefined;
  });
  return new TopGainersScannerService(
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: "REJECT", rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any, { enrich: (i: any) => i.candidate } as any, { evaluate: (i: any) => i.candidate } as any, { getCandles: () => Promise.resolve(null) } as any,
  );
}

/**
 * Helper — mocks the Supabase chain `.from(...).select(...).in(...)`
 * used by loadEuSessionWindows().
 */
function mockEuWatchlists(rows: Array<{ name: string; session_open_utc: string | null; session_close_utc: string | null }>) {
  const inMock = jest.fn().mockResolvedValue({ data: rows, error: null });
  const selectMock = jest.fn().mockReturnValue({ in: inMock });
  supabaseFromMock.mockImplementation((table: string) => {
    if (table === 'watchlist_universe') return { select: selectMock };
    return { select: jest.fn() };
  });
  return { selectMock, inMock };
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  supabaseFromMock.mockReset();
  jest.clearAllMocks();
});

// ── 1. detectAssetClass returns 'eu_equity' (sanity, taxonomy already exists) ─

describe('detectAssetClass — eu_equity (sanity)', () => {
  it('returns eu_equity for LSE / XETRA / PA / AMS', () => {
    expect(detectAssetClass('AIR.PA', 'PA')).toBe('eu_equity');
    expect(detectAssetClass('SAP.DE', 'XETRA')).toBe('eu_equity');
    expect(detectAssetClass('SHEL.L', 'LSE')).toBe('eu_equity');
    expect(detectAssetClass('ASML.AS', 'AMS')).toBe('eu_equity');
  });
});

// ── 2. Session gating — EU exchanges scanned during session ────────────────

describe('fetchAllCandidates — EU session gating', () => {
  function captureFetchedExchanges(): { capturedUrls: string[] } {
    const capturedUrls: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => '',
      } as unknown as Response;
    });
    return { capturedUrls };
  }

  function exchangesQueried(urls: string[]): Set<string> {
    const exchanges = new Set<string>();
    for (const url of urls) {
      // P19s+ : exchanges sont maintenant UPPERCASE dans le filtre EODHD
      const m = decodeURIComponent(url).match(/\["exchange","=","([A-Za-z]+)"\]/);
      if (m) exchanges.add(m[1].toUpperCase());
    }
    return exchanges;
  }

  it('scans EU exchanges (LSE/XETRA/PA/SW/MI/MC/BME/AS/AMS) during cac40 session', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'dax40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const { capturedUrls } = captureFetchedExchanges();

    const svc = makeService();
    // 10:00 UTC — all 3 EU sessions are open
    await svc.fetchAllCandidates(new Date('2026-04-29T10:00:00Z'));

    const exchanges = exchangesQueried(capturedUrls);
    // EU exchanges
    expect(exchanges.has('LSE')).toBe(true);
    expect(exchanges.has('XETRA')).toBe(true);
    expect(exchanges.has('PA')).toBe(true);
    expect(exchanges.has('AMS')).toBe(true);
    // Non-EU still scanned (P20a: T = Tokyo, corrected from TSE)
    expect(exchanges.has('US')).toBe(true);
    expect(exchanges.has('T')).toBe(true);
  });

  it('skips EU exchanges when all 3 EU sessions closed (e.g. 22:00 UTC)', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'dax40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const { capturedUrls } = captureFetchedExchanges();

    const svc = makeService();
    // 22:00 UTC — all EU sessions closed (US after-hours)
    await svc.fetchAllCandidates(new Date('2026-04-29T22:00:00Z'));

    const exchanges = exchangesQueried(capturedUrls);
    // EU exchanges NOT queried
    expect(exchanges.has('LSE')).toBe(false);
    expect(exchanges.has('XETRA')).toBe(false);
    expect(exchanges.has('PA')).toBe(false);
    expect(exchanges.has('SW')).toBe(false);
    expect(exchanges.has('MI')).toBe(false);
    expect(exchanges.has('MC')).toBe(false);
    expect(exchanges.has('BME')).toBe(false);
    expect(exchanges.has('AS')).toBe(false);
    expect(exchanges.has('AMS')).toBe(false);
    // Non-EU still scanned (US 24/7, Asia depending on hours)
    expect(exchanges.has('US')).toBe(true);
  });

  it('scans EU when only ftse100 is open (e.g. 16:15 UTC, after Paris/Frankfurt close)', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'dax40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const { capturedUrls } = captureFetchedExchanges();

    const svc = makeService();
    // 16:15 UTC — only ftse100 still in session
    await svc.fetchAllCandidates(new Date('2026-04-29T16:15:00Z'));

    const exchanges = exchangesQueried(capturedUrls);
    // EU exchanges scanned (because ≥1 EU session is active)
    expect(exchanges.has('LSE')).toBe(true);
    expect(exchanges.has('XETRA')).toBe(true);
  });

  it('falls back to 07:00-17:00 UTC envelope when DB query returns empty', async () => {
    mockEuWatchlists([]);  // no rows returned
    const { capturedUrls } = captureFetchedExchanges();

    const svc = makeService();
    // 10:00 UTC — within fallback envelope [07:00, 17:00]
    await svc.fetchAllCandidates(new Date('2026-04-29T10:00:00Z'));

    const exchanges = exchangesQueried(capturedUrls);
    expect(exchanges.has('LSE')).toBe(true);
    expect(exchanges.has('XETRA')).toBe(true);
    expect(exchanges.has('PA')).toBe(true);
  });

  it('falls back to envelope and skips EU at 22:00 UTC even if DB empty', async () => {
    mockEuWatchlists([]);
    const { capturedUrls } = captureFetchedExchanges();

    const svc = makeService();
    await svc.fetchAllCandidates(new Date('2026-04-29T22:00:00Z'));

    const exchanges = exchangesQueried(capturedUrls);
    expect(exchanges.has('LSE')).toBe(false);
    expect(exchanges.has('XETRA')).toBe(false);
    expect(exchanges.has('PA')).toBe(false);
  });
});

// ── 3. getActiveEuWatchlists exposes the active list ────────────────────────

describe('getActiveEuWatchlists', () => {
  it('returns names of EU watchlists currently in session', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'dax40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const svc = makeService();
    const active = await svc.getActiveEuWatchlists(new Date('2026-04-29T10:00:00Z'));
    expect(active.sort()).toEqual(['cac40', 'dax40', 'ftse100']);
  });

  it('returns empty array when no EU session is active', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const svc = makeService();
    const active = await svc.getActiveEuWatchlists(new Date('2026-04-29T22:00:00Z'));
    expect(active).toEqual([]);
  });

  it('returns only ftse100 between 15:30 and 16:30 UTC', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'dax40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
      { name: 'ftse100', session_open_utc: '08:00:00', session_close_utc: '16:30:00' },
    ]);
    const svc = makeService();
    const active = await svc.getActiveEuWatchlists(new Date('2026-04-29T16:00:00Z'));
    expect(active).toEqual(['ftse100']);
  });
});

// ── 4. Dedup of merged candidates by (symbol, exchange) ─────────────────────

describe('fetchAllCandidates — merge dedup', () => {
  it('deduplicates same symbol+exchange returned twice across sources', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
    ]);
    // Mock fetch returns the same AAPL symbol on US for every EODHD call.
    // This simulates a hypothetical EODHD bug where a row appears twice.
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      callCount++;
      const isUs = decodeURIComponent(url).includes('"exchange","=","US"');
      const data = isUs ? [
        { code: 'AAPL', last_price: 180, refund_1d_p: 5.2, volume: 2_000_000, avgvol_50d: 1_500_000, market_capitalization: 3e12 },
      ] : [];
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' } as unknown as Response;
    });

    const svc = makeService();
    const candidates = await svc.fetchAllCandidates(new Date('2026-04-29T10:00:00Z'));

    // AAPL@US should appear exactly once even though fetch returned it.
    const aaplRows = candidates.filter((c) => c.symbol === 'AAPL' && c.exchange === 'US');
    expect(aaplRows.length).toBe(1);
    expect(callCount).toBeGreaterThan(0);
  });

  it('keeps same symbol on different exchanges (no false dedup)', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
    ]);
    // Hypothetical scenario: a cross-listed ADR appears on US AND XETRA
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const decoded = decodeURIComponent(url);
      let data: any[] = [];
      if (decoded.includes('"exchange","=","US"')) {
        data = [{ code: 'SAP', last_price: 200, refund_1d_p: 4.0, volume: 500_000, avgvol_50d: 400_000, market_capitalization: 2e11 }];
      } else if (decoded.includes('"exchange","=","XETRA"')) {
        data = [{ code: 'SAP.DE', last_price: 195, refund_1d_p: 3.8, volume: 800_000, avgvol_50d: 600_000, market_capitalization: 2e11 }];
      }
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' } as unknown as Response;
    });

    const svc = makeService();
    const candidates = await svc.fetchAllCandidates(new Date('2026-04-29T10:00:00Z'));

    const sapRows = candidates.filter((c) => c.symbol.startsWith('SAP'));
    expect(sapRows.length).toBe(2);  // Different (symbol, exchange) tuples
    const exchanges = sapRows.map((c) => c.exchange).sort();
    expect(exchanges).toEqual(['US', 'XETRA']);
  });

  it('merges US + EU + Asia candidates and assigns correct asset classes', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
    ]);
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const decoded = decodeURIComponent(url);
      let data: any[] = [];
      if (decoded.includes('"exchange","=","US"')) {
        data = [{ code: 'NVDA', last_price: 800, refund_1d_p: 6.0, volume: 50_000_000, avgvol_50d: 40_000_000, market_capitalization: 2e12 }];
      } else if (decoded.includes('"exchange","=","PA"')) {
        data = [{ code: 'AIR.PA', last_price: 150, refund_1d_p: 4.2, volume: 1_000_000, avgvol_50d: 800_000, market_capitalization: 1e11 }];
      } else if (decoded.includes('"exchange","=","T"')) {
        // P20a: Tokyo uses code 'T' (suffix .T), not 'TSE'
        data = [{ code: '7203', last_price: 2500, refund_1d_p: 5.5, volume: 5_000_000, avgvol_50d: 4_000_000, market_capitalization: 3e11 }];
      }
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' } as unknown as Response;
    });

    const svc = makeService();
    const candidates = await svc.fetchAllCandidates(new Date('2026-04-29T10:00:00Z'));

    const symbols = candidates.map((c) => c.symbol);
    expect(symbols).toContain('NVDA');
    expect(symbols).toContain('AIR.PA');
    // P20a: screener returns bare code '7203', exchange 'T' (not 'TSE')
    expect(symbols).toContain('7203');

    // Verify each candidate gets the correct asset class via detectAssetClass
    const nvda = candidates.find((c) => c.symbol === 'NVDA')!;
    const air = candidates.find((c) => c.symbol === 'AIR.PA')!;
    const toyota = candidates.find((c) => c.symbol === '7203')!;
    expect(detectAssetClass(nvda.symbol, nvda.exchange, nvda.marketCap)).toBe('us_equity_large');
    expect(detectAssetClass(air.symbol, air.exchange)).toBe('eu_equity');
    expect(detectAssetClass(toyota.symbol, toyota.exchange)).toBe('asia_equity');
  });
});
