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

  it('P19o.4 — does NOT include adjusted_close as filter field (not in EODHD spec)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19o.4 (29/04/2026) — `adjusted_close` is response-only per official
    // stock-screener-data.md ; not in Supported Filter Fields list. Le seuil
    // price >= 2 est désormais un POST-filter dans mapEodhdRow.
    expect(decoded).not.toMatch(/\["adjusted_close","[<>=]"/);
    expect(decoded).not.toMatch(/\["close","[<>=]"/);
  });

  it('P19o.4 — uses avgvol_50d (NOT avgvol_200d, which is not in EODHD spec)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19o.4 — la doc officielle liste UNIQUEMENT `avgvol_50d` comme champ
    // filter valide. `avgvol_200d` était silently ignored par EODHD.
    expect(decoded).toContain('["avgvol_50d",">",500000]');
    expect(decoded).not.toContain('avgvol_200d');
  });

  it('requires market_capitalization > 50M (P19o, exclude nano-caps OTC-style)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["market_capitalization",">",50000000]');
  });

  it('P19o.4 — uses canonical sort+order syntax (NOT field.desc shorthand)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19o.4 — Spec officielle stock-screener-data.md :
    //   sort  : Field to sort by (e.g., market_capitalization, name)
    //   order : Sort order: 'a' (ascending) or 'd' (descending)
    // Notre `sort=refund_1d_p.desc` non-standard pouvait être silently ignored
    // → top 20 par défaut alphabétique au lieu de top gainers desc.
    expect(decoded).toContain('sort=refund_1d_p&order=d');
    expect(decoded).not.toContain('sort=refund_1d_p.desc');
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

  it('P19o.4 — post-filter rejects rows with adjusted_close < 2 (penny stocks)', () => {
    const svc = makeService();
    const pennyRow = { code: 'PENNY', adjusted_close: 1.50, refund_1d_p: 12.5, avgvol_50d: 600_000, market_capitalization: 60_000_000 } as any;
    expect((svc as any).mapEodhdRow(pennyRow, 'US')).toBeNull();
  });

  it('P19o.4 — post-filter accepts rows with adjusted_close >= 2', () => {
    const svc = makeService();
    const row = { code: 'OK', adjusted_close: 2.01, refund_1d_p: 4.0, avgvol_50d: 600_000, market_capitalization: 60_000_000 } as any;
    expect((svc as any).mapEodhdRow(row, 'US')).not.toBeNull();
  });

  it('P19o.4 — post-filter still rejects close <= 0 (defensive baseline)', () => {
    const svc = makeService();
    const row = { code: 'BAD', adjusted_close: 0, refund_1d_p: 5 } as any;
    expect((svc as any).mapEodhdRow(row, 'US')).toBeNull();
  });
});
