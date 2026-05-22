/**
 * Panier or/énergie fixe — proxies equity .US toujours scannés.
 *
 * Le screener EODHD ne remonte un ticker que s'il fait déjà +3%/jour, donc une
 * tendance macro lente (or, pétrole) reste invisible du scan. Le panier fixe
 * (GLD/USO/XLE/GDX/NEM/GOLD/XOM/CVX) est fetché via le endpoint real-time batch
 * pour être évalué chaque cycle, soumis aux mêmes gates (aucun bypass).
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService, GAINERS_FIXED_BASKET, GAINERS_LEVERAGED_PROXIES } from '../services/top-gainers-scanner.service';

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

function makeService(configImpl?: (key: string) => unknown): TopGainersScannerService {
  mockConfig.get.mockImplementation(configImpl ?? ((key: string) => (key === 'SCAN_INTERVAL_MINUTES' ? '15' : undefined)));
  return new TopGainersScannerService(
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: 'REJECT', rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any,
    { estimateProbability: async () => ({ pWin: 0.5, confidence: 0, sampleSize: 0, modelVersion: 'none', fallback: true }) } as any,
    { getStatus: () => ({ authoritative: { apiRequests: 0, dailyRateLimit: 100000, extraLimit: 0, asOf: null }, local: { totalProjected: 0, perEndpoint: {}, burnRatePerMin: 0 }, throttle: { scannerPaused: false, multitfPaused: false, essentialsOnly: false, hardBlocked: false, pauseReason: null }, etaExhaustionMinutes: null }) } as any,
  );
}

describe('fetchFixedBasket — gold/energy proxies', () => {
  const realFetch = global.fetch;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    capturedUrl = undefined;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => GAINERS_FIXED_BASKET.map((e, i) => ({
          code: e.symbol,
          close: 100 + i,
          high: 102 + i,
          change_p: 1.2, // hausse douce < seuil equity → REJECT attendu en aval
          volume: 5_000_000,
        })),
        text: async () => '',
      } as unknown as Response;
    });
  });

  afterEach(() => { global.fetch = realFetch; });

  it('builds a single batch real-time URL (first symbol in path + s= for the rest)', async () => {
    const svc = makeService();
    await (svc as any).fetchFixedBasket('test-key');
    expect(capturedUrl).toBeDefined();
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('/real-time/GLD.US?');
    expect(decoded).toContain('fmt=json');
    // les 7 autres symboles passent par s=
    expect(decoded).toMatch(/[?&]s=USO\.US,XLE\.US,GDX\.US,NEM\.US,GOLD\.US,XOM\.US,CVX\.US/);
    // un seul appel HTTP
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('maps each row to a candidate with approx mcap/avgVol50d from the basket meta', async () => {
    const svc = makeService();
    const candidates = await (svc as any).fetchFixedBasket('test-key');
    expect(candidates).toHaveLength(GAINERS_FIXED_BASKET.length);
    const gld = candidates.find((c: any) => c.symbol === 'GLD.US');
    expect(gld).toBeDefined();
    expect(gld.exchange).toBe('US');
    expect(gld.marketCap).toBe(76_000_000_000);
    expect(gld.avgVol50d).toBe(7_000_000);
    expect(gld.assetClass).toBe('us_equity_large'); // mcap >= 10B
    // USO ~1.5B → small-mid
    const uso = candidates.find((c: any) => c.symbol === 'USO.US');
    expect(uso.assetClass).toBe('us_equity_small_mid');
  });

  it('returns [] when GAINERS_FIXED_BASKET_ENABLED=false (kill switch)', async () => {
    const svc = makeService((key: string) => (key === 'GAINERS_FIXED_BASKET_ENABLED' ? 'false' : undefined));
    const candidates = await (svc as any).fetchFixedBasket('test-key');
    expect(candidates).toEqual([]);
    expect((global.fetch as jest.Mock)).not.toHaveBeenCalled();
  });

  it('ignores unexpected symbols returned by the API (not in the basket)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { code: 'GLD.US', close: 100, high: 101, change_p: 2, volume: 1_000_000 },
        { code: 'SPY.US', close: 500, high: 501, change_p: 1, volume: 1_000_000 }, // hors panier
      ],
      text: async () => '',
    } as unknown as Response);
    const svc = makeService();
    const candidates = await (svc as any).fetchFixedBasket('test-key');
    expect(candidates.map((c: any) => c.symbol)).toEqual(['GLD.US']);
  });

  it('returns [] on HTTP error without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 402, text: async () => '{"error":"limit"}',
    } as unknown as Response);
    const svc = makeService();
    await expect((svc as any).fetchFixedBasket('test-key')).resolves.toEqual([]);
  });

  it('does NOT include leveraged proxies by default (env OFF)', async () => {
    const svc = makeService();
    await (svc as any).fetchFixedBasket('test-key');
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).not.toContain('NUGT.US');
    expect(decoded).not.toContain('GUSH.US');
  });

  it('includes leveraged proxies when GAINERS_LEVERAGED_PROXIES_ENABLED=true', async () => {
    const combined = [...GAINERS_FIXED_BASKET, ...GAINERS_LEVERAGED_PROXIES];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => combined.map((e, i) => ({
          code: e.symbol, close: 100 + i, high: 102 + i, change_p: 4.5, volume: 5_000_000,
        })),
        text: async () => '',
      } as unknown as Response;
    });
    const svc = makeService((key: string) =>
      key === 'GAINERS_LEVERAGED_PROXIES_ENABLED' ? 'true' : undefined,
    );
    const candidates = await (svc as any).fetchFixedBasket('test-key');
    expect(candidates).toHaveLength(combined.length);
    const decoded = decodeURIComponent(capturedUrl!);
    expect(decoded).toContain('NUGT.US');
    expect(decoded).toContain('GUSH.US');
    expect(candidates.find((c: any) => c.symbol === 'NUGT.US')).toBeDefined();
  });
});
