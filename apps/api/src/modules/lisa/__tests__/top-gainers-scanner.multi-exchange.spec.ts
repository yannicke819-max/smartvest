/**
 * P19s+ (30/04/2026) — Regression tests for multi-exchange EODHD screener.
 *
 * Bug observed in prod : audit gainers_persistence_log 24h = 21 299 candidats
 * sur 105 tickers uniques, **100 % US**. 0 ticker non-US, aucun suffixe
 * `.PA`/`.L`/`.DE`/`.HK`/`.T`/.
 *
 * Root cause :
 *   1) `exchange` était passé en lowercase. EODHD screener exige UPPERCASE
 *      pour tous codes autres que 'us'. Les requêtes LSE/PA/TSE/HK/AU
 *      renvoyaient 0 silencieusement (masqué par .catch(() => [])).
 *   2) Le filtre `refund_1d_p` n'existe que côté US. Les exchanges EU/Asie
 *      utilisent `change_p`. Sans ce changement, le filtre EODHD éliminait
 *      100 % des résultats non-US.
 *
 * These tests intercept `global.fetch` and assert :
 *   - exchange envoyé en UPPERCASE
 *   - changeField = 'refund_1d_p' pour US, 'change_p' pour non-US
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';

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
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: "REJECT", rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any,
    { estimateProbability: async () => ({ pWin: 0.5, confidence: 0, sampleSize: 0, modelVersion: "none", fallback: true }) } as any,
    { getStatus: () => ({ authoritative: { apiRequests: 0, dailyRateLimit: 100000, extraLimit: 0, asOf: null }, local: { totalProjected: 0, perEndpoint: {}, burnRatePerMin: 0 }, throttle: { scannerPaused: false, multitfPaused: false, essentialsOnly: false, hardBlocked: false, pauseReason: null }, etaExhaustionMinutes: null }) } as any,
  );
}

describe('fetchEodhdScreener — multi-exchange UPPERCASE + changeField (P19s+ regression guard)', () => {
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

  it('passes UPPERCASE exchange + refund_1d_p>3 filter + sort desc for non-US (LSE) (post-01/06 fix)', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('lse', 'test_key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('"LSE"');
    expect(decoded).not.toContain('"lse"');
    // Audit 01/06 : refund_1d_p filtrable+sortable sur tous exchanges (test live).
    expect(decoded).toContain('["refund_1d_p",">",3]');
    expect(decoded).not.toContain('"change_p"');
    expect(decoded).toMatch(/[?&]sort=refund_1d_p\.desc/);
  });

  it('passes UPPERCASE exchange + refund_1d_p for US to EODHD screener', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('us', 'test_key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);
    // Exchange filter doit contenir "US"
    expect(decoded).toContain('"US"');
    expect(decoded).not.toContain('"us"');
    // refund_1d_p est un valid filter field UNIQUEMENT pour US (validé prod)
    expect(decoded).toContain('refund_1d_p');
    expect(decoded).not.toContain('change_p');
  });

  it('handles already-uppercase input (idempotent) — XETRA passes through with new filter+sort', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('XETRA', 'test_key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('"XETRA"');
    expect(decoded).toContain('["refund_1d_p",">",3]');
    expect(decoded).not.toContain('"change_p"');
    expect(decoded).toMatch(/[?&]sort=refund_1d_p\.desc/);
  });

  it.each([
    ['pa', 'PA'],   // Euronext Paris
    ['t', 'T'],     // Tokyo
    ['hk', 'HK'],   // Hong Kong
    ['ko', 'KO'],   // Korea KOSPI
    ['au', 'AU'],   // Australia
    ['to', 'TO'],   // Toronto
    ['as', 'AS'],   // Amsterdam
    ['nse', 'NSE'], // India NSE
  ])('non-US exchange "%s" sent as "%s" with refund_1d_p>3 filter + sort desc (post-01/06 fix)', async (input, expected) => {
    // Audit 01/06/2026 — `refund_1d_p` filtrable+sortable sur Asia exchanges
    // confirmé live (KO/KQ/SHG/SHE/NSE/TW). Hypothèse historique P19s++ "non-US
    // sans données refund_1d_p" était fausse. Sans sort+filter, le scanner
    // ratait 82% des EODHD top gainers (4/22 hit rate observé).
    // change_p reste interdit (filter field invalide, c'est le nom de la réponse).
    const svc = makeService();
    await (svc as any).fetchEodhdScreener(input, 'test_key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain(`"${expected}"`);
    expect(decoded).toContain('["refund_1d_p",">",3]');
    expect(decoded).not.toContain('"change_p"');
    expect(decoded).toMatch(/[?&]sort=refund_1d_p\.desc/);
    expect(decoded).toContain('market_capitalization');
  });
});
