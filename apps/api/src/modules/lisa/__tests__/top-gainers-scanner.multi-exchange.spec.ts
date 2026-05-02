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
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any,
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

  it('passes UPPERCASE exchange + change_p for non-US (LSE) to EODHD screener', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('lse', 'test_key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);
    // Exchange filter doit contenir "LSE" (UPPERCASE), pas "lse"
    expect(decoded).toContain('"LSE"');
    expect(decoded).not.toContain('"lse"');
    // P19s++ HOTFIX : pas de filter 1d return pour non-US (rejected as
    // invalid filter field by EODHD validator). Post-filter client-side.
    expect(decoded).not.toContain('refund_1d_p');
    expect(decoded).not.toContain('change_p');
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

  it('handles already-uppercase input (idempotent) — XETRA passes through', async () => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener('XETRA', 'test_key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('"XETRA"');
    // P19s++ : pas de filter 1d return pour non-US
    expect(decoded).not.toContain('refund_1d_p');
    expect(decoded).not.toContain('change_p');
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
  ])('non-US exchange "%s" sent as "%s" without 1d return filter (post-filter client-side)', async (input, expected) => {
    const svc = makeService();
    await (svc as any).fetchEodhdScreener(input, 'test_key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain(`"${expected}"`);
    // P19s++ : pas de filter 1d return (rejected by EODHD validator pour non-US)
    expect(decoded).not.toContain('refund_1d_p');
    expect(decoded).not.toContain('change_p');
    // market_capitalization filter conservé
    expect(decoded).toContain('market_capitalization');
  });
});
