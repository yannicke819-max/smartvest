/**
 * P18c — Regression tests for the EODHD screener URL construction.
 *
 * Bug observed in prod (29/04/2026): every exchange returned HTTP 422
 * because the URL had:
 *   - `exchange` as a separate query param (must be inside `filters` array)
 *   - `change_p` as a filter field (must be `refund_1d_p`)
 *   - `close` as a filter field (must be `adjusted_close`)
 *
 * These tests intercept `global.fetch` and assert the URL contains the
 * correct EODHD filter format so the bug cannot regress silently.
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';
import { ScannerLlmRouterService } from '../services/scanner-llm-router.service';

// ── Stubs ──────────────────────────────────────────────────────────────────
const mockSupabase = { getClient: jest.fn() } as any;
const mockLisa = {} as any;
const mockDecisionLog = {} as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = {} as any;
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
  mockConfig.get.mockImplementation((key: string) => (key === 'SCAN_INTERVAL_MINUTES' ? '15' : undefined));
  return new TopGainersScannerService(
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter,
  );
}

describe('fetchEodhdScreener — URL construction (P18c regression guard)', () => {
  const realFetch = global.fetch;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    capturedUrl = undefined;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => '',
      } as unknown as Response;
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('passes exchange INSIDE the filters array (lowercase), not as a separate query param', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);

    // Must NOT have `&exchange=` query param
    expect(decoded).not.toMatch(/[?&]exchange=/);
    // MUST have ["exchange","=","us"] inside the filters array (lowercase)
    expect(decoded).toContain('["exchange","=","us"]');
  });

  it('lowercases exchange code (e.g. XETRA → xetra)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('XETRA', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["exchange","=","xetra"]');
    expect(decoded).not.toContain('XETRA');
  });

  it('uses refund_1d_p (NOT change_p) as the daily-change filter field', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["refund_1d_p",">",3]');
    // change_p must NOT appear as a filter field key
    expect(decoded).not.toMatch(/\["change_p","[<>=]"/);
  });

  it('uses adjusted_close (NOT close) as the price filter field — P19o threshold $2', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19o (29/04/2026) — bumped from $1 to $2 to exclude penny stocks
    // that EODHD intraday returns empty for.
    expect(decoded).toContain('["adjusted_close",">",2]');
    expect(decoded).not.toMatch(/\["close","[<>=]"/);
  });

  it('uses avgvol_200d > 500_000 (P19o tightened from 100k) for liquidity guarantee', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19o (29/04/2026) — issue #107 : avgvol > 100k laissait passer micro-caps
    // (BIYA, ATER, SBLX...) sans coverage intraday EODHD. Bump à 500k = trades
    // fiables.
    expect(decoded).toContain('["avgvol_200d",">",500000]');
    expect(decoded).not.toContain('"avgvol_200d",">",100000');
  });

  it('requires market_capitalization > 50M (P19o, exclude nano-caps OTC-style)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["market_capitalization",">",50000000]');
  });

  it('sorts by refund_1d_p.desc (NOT change_p.desc)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('sort=refund_1d_p.desc');
    expect(decoded).not.toContain('sort=change_p.desc');
  });

  it('logs HTTP error body at warn level for diagnostic (was debug, now warn)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"error":"invalid filter field: change_p"}',
    } as unknown as Response);
    const svc = makeService();
    const result = await (svc as any).fetchEodhdScreener('US', 'test-key');
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const lastCall = warnSpy.mock.calls.find((c) => String(c[0]).includes('HTTP 422'));
    expect(lastCall).toBeDefined();
    expect(String(lastCall![0])).toContain('invalid filter field');
  });
});

describe('mapEodhdRow — accepts both filter-form and legacy field names', () => {
  it('reads refund_1d_p (preferred) when present', () => {
    const svc = makeService();
    const row = { code: 'AAPL', last_price: 180, refund_1d_p: 4.2, volume: 1000 } as any;
    const result = (svc as any).mapEodhdRow(row, 'US');
    expect(result.changePct).toBe(4.2);
  });

  it('falls back to change_p when refund_1d_p is missing (legacy response shape)', () => {
    const svc = makeService();
    const row = { code: 'AAPL', last_price: 180, change_p: 3.7, volume: 1000 } as any;
    const result = (svc as any).mapEodhdRow(row, 'US');
    expect(result.changePct).toBe(3.7);
  });

  it('reads adjusted_close (preferred) when present', () => {
    const svc = makeService();
    const row = { code: 'AAPL', adjusted_close: 175, refund_1d_p: 2.1 } as any;
    const result = (svc as any).mapEodhdRow(row, 'US');
    expect(result.close).toBe(175);
  });

  it('falls back to last_price when adjusted_close is missing', () => {
    const svc = makeService();
    const row = { code: 'AAPL', last_price: 178, refund_1d_p: 2.1 } as any;
    const result = (svc as any).mapEodhdRow(row, 'US');
    expect(result.close).toBe(178);
  });
});
