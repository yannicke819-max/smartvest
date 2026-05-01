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

  it('passes exchange INSIDE the filters array (UPPERCASE post P19s+), not as a separate query param', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('us', 'test-key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);

    // Must NOT have `&exchange=` query param
    expect(decoded).not.toMatch(/[?&]exchange=/);
    // P19s+ : MUST have ["exchange","=","US"] inside the filters array (UPPERCASE)
    expect(decoded).toContain('["exchange","=","US"]');
  });

  it('P19s+ — UPPERCASES exchange code (e.g. xetra → XETRA), required by EODHD non-US', async () => {
    // P19s+ (30/04/2026) reverse l'ancienne attente lowercase. Audit prod 24h :
    // 100% des candidats étaient US car les exchanges non-US étaient passés
    // en lowercase et EODHD retournait 0 row silencieusement.
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('xetra', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["exchange","=","XETRA"]');
    expect(decoded).not.toContain('"xetra"');
  });

  it('uses refund_1d_p for US (NOT change_p) as the daily-change filter field', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["refund_1d_p",">",3]');
    // change_p must NOT appear as a filter field key for US
    expect(decoded).not.toMatch(/\["change_p","[<>=]"/);
  });

  it('P19o.4 — does NOT include adjusted_close as filter field (not in EODHD spec)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).not.toMatch(/\["adjusted_close","[<>=]"/);
    expect(decoded).not.toMatch(/\["close","[<>=]"/);
  });

  it('P19s — does NOT include avgvol_50d nor avgvol_200d (rejected by EODHD validator)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19s (29/04/2026) — Live curl confirmed both avgvol_50d AND avgvol_200d
    // trigger `filters.X.field invalid` 422 on EODHD screener. Doc was wrong.
    // Volume filtering moved to post-fetch in mapEodhdRow / evaluateTopGainerCandidate.
    expect(decoded).not.toContain('avgvol_50d');
    expect(decoded).not.toContain('avgvol_200d');
  });

  it('requires market_capitalization > 50M (still valid filter per EODHD spec)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('["market_capitalization",">",50000000]');
  });

  it('P19s — does NOT include sort or order param (Laravel validator rejects on non-US)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // P19s — Live Fly logs 18:53 UTC : 100% of non-US exchanges (TSE/HK/KO/SS
    // /SZ/TO/AS/NSE/BSE) returned HTTP 422 with `sort.0.direction required`.
    // EODHD validator expects nested array form. Drop sort entirely — we
    // already sort client-side in the snapshot endpoint by changePct desc.
    expect(decoded).not.toMatch(/[?&]sort=/);
    expect(decoded).not.toMatch(/[?&]order=/);
  });

  it('P19s — bumps limit from 20 to 100 (max per spec) to compensate dropped sort', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('US', 'test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    // Limit 100 = doc max. Compensates dropped sort: even if EODHD's natural
    // order isn't changePct desc, we capture 5x more candidates so the
    // client-side sort still surfaces the real top gainers.
    expect(decoded).toContain('limit=100');
    expect(decoded).not.toContain('limit=20');
  });

  it('P19s++ HOTFIX — non-US exchanges build URL with UPPERCASE + NO 1d return filter', async () => {
    // P19s++ (30/04/2026 08:10 UTC) — `change_p` n'est PAS un valid filter
    // field per EODHD doc (c'est le nom dans la RÉPONSE seulement). Ça
    // causait HTTP 422 sur LSE/MC/KO/HK :
    //     {"errors":{"filters.1.field":["The selected filters.1.field is invalid."]}}
    // Fix : DROP le filter 1d return pour non-US, post-filter client-side.
    const svc = makeService();
    // P20a: corrected EODHD codes — T (Tokyo), SHG (Shanghai), SHE (Shenzhen)
    const exchanges = ['T', 'HK', 'KO', 'SHG', 'SHE', 'TO', 'AS', 'NSE', 'BSE', 'AU'];
    for (const ex of exchanges) {
      capturedUrl = undefined;
      await (svc as any).fetchEodhdScreener(ex, 'test-key');
      expect(capturedUrl).toBeDefined();
      const decoded = decodeURIComponent(capturedUrl!);
      // Exchange UPPERCASE
      expect(decoded).toContain(`["exchange","=","${ex}"]`);
      // P19s++ : pas de filter 1d return (ni change_p, ni refund_1d_p)
      expect(decoded).not.toMatch(/\["change_p","[<>=]"/);
      expect(decoded).not.toMatch(/\["refund_1d_p","[<>=]"/);
      // market_cap conservé (valid filter)
      expect(decoded).toContain('["market_capitalization",">",50000000]');
      expect(decoded).not.toMatch(/[?&]sort=/);
      expect(decoded).not.toContain('avgvol_50d');
    }
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

// ── P20a — Exchange code registry snapshot ─────────────────────────────────
// Guards that corrected EODHD codes (SHG/SHE/T) are in NON_EU_EXCHANGES
// and that legacy codes (SS/SZ/TSE) are gone.
// Source: vendor/eodhd-claude-skills/.../exchanges-list.md
describe('P20a — NON_EU_EXCHANGES registry correctness', () => {
  // Access the exported constant indirectly via the URL built by fetchEodhdScreener.
  const realFetch = global.fetch;
  let capturedUrls: string[];

  beforeEach(() => {
    capturedUrls = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url as string);
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    });
  });
  afterEach(() => { global.fetch = realFetch; });

  function makeServiceWithApiKey(): TopGainersScannerService {
    mockConfig.get.mockImplementation((key: string) => {
      if (key === 'SCAN_INTERVAL_MINUTES') return '15';
      if (key === 'EODHD_API_KEY') return 'test-key';
      return undefined;
    });
    return new TopGainersScannerService(
      mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter,
    );
  }

  it('uses corrected EODHD codes SHG (Shanghai) and SHE (Shenzhen)', async () => {
    const svc = makeServiceWithApiKey();
    capturedUrls = [];
    await (svc as any).fetchEodhdScreener('SHG', 'test-key');
    await (svc as any).fetchEodhdScreener('SHE', 'test-key');
    const decoded = capturedUrls.map((u) => decodeURIComponent(u));
    expect(decoded[0]).toContain('["exchange","=","SHG"]');
    expect(decoded[1]).toContain('["exchange","=","SHE"]');
  });

  it('uses corrected EODHD code T (Tokyo) not TSE', async () => {
    const svc = makeServiceWithApiKey();
    capturedUrls = [];
    await (svc as any).fetchEodhdScreener('T', 'test-key');
    const decoded = decodeURIComponent(capturedUrls[0]!);
    expect(decoded).toContain('["exchange","=","T"]');
    expect(decoded).not.toContain('"TSE"');
  });

  it('does NOT include legacy codes SS, SZ, TSE in non-EU exchange list', async () => {
    // Simulate a full fetchAllCandidates to capture which exchanges are queried.
    const supabaseMock = {
      getClient: () => ({
        from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
      }),
    } as any;
    const svc = new TopGainersScannerService(
      supabaseMock, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter,
    );
    capturedUrls = [];
    // fetchAllCandidates without EU (EU sessions closed)
    await (svc as any).fetchAllCandidates(new Date('2026-05-01T22:00:00Z'));
    const queried = capturedUrls.map((u) => {
      const m = decodeURIComponent(u).match(/"exchange","=","([^"]+)"/);
      return m ? m[1] : null;
    }).filter(Boolean);
    expect(queried).not.toContain('SS');
    expect(queried).not.toContain('SZ');
    expect(queried).not.toContain('TSE');
    expect(queried).toContain('SHG');
    expect(queried).toContain('SHE');
    expect(queried).toContain('T');
  });
});
