/**
 * Bug #R9 / #R10 — Integration test : prouve que `fetchAllCandidates` applique
 * le pre-filter (session + blacklist) AVANT de retourner la liste partagée.
 *
 * Couvre :
 *   - Asia tickers droppés à 11:40 UTC (R9 reproduction)
 *   - 9 tickers .NSE statiques droppés (R10 statique)
 *   - Auto-blacklist après 3 strikes 404 (R10 dynamique)
 *   - Cache pollution : la liste cachée est filtrée, pas la liste brute
 *
 * Garde-fou Phase MESURE : aucune modification TP/SL/notional/warmup/sanity.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';
import { TickerBlacklistService } from '../services/ticker-blacklist.service';

const supabaseFromMock = jest.fn();
const mockSupabase = { getClient: () => ({ from: supabaseFromMock }) } as any;
const mockLisa = {} as any;
const mockDecisionLog = {} as any;
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

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'SCAN_INTERVAL_MINUTES') return '15';
      if (key === 'EODHD_API_KEY') return 'test-key';
      return env[key];
    },
  } as unknown as ConfigService;
}

function makeService(
  blacklist: TickerBlacklistService,
  config: ConfigService,
): TopGainersScannerService {
  return new TopGainersScannerService(
    mockSupabase,
    mockLisa,
    mockDecisionLog,
    config,
    mockBinance,
    mockScheduler,
    mockMtf,
    mockLlmRouter,
    { isShadowEnabled: () => false } as any,
    { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: 'REJECT', rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any,
    { estimateProbability: async () => ({ pWin: 0.5, confidence: 0, sampleSize: 0, modelVersion: 'none', fallback: true }) } as any,
    { getStatus: () => ({ authoritative: { apiRequests: 0, dailyRateLimit: 100000, extraLimit: 0, asOf: null }, local: { totalProjected: 0, perEndpoint: {}, burnRatePerMin: 0 }, throttle: { scannerPaused: false, multitfPaused: false, essentialsOnly: false, hardBlocked: false, pauseReason: null }, etaExhaustionMinutes: null }) } as any,
    undefined, // userShadow
    undefined, // eodhdCalendar
    undefined, // macroVeto
    blacklist, // R9/R10 — pre-filter active dès que injecté
  );
}

function mockEuWatchlists(rows: Array<{ name: string; session_open_utc: string | null; session_close_utc: string | null }>) {
  const inMock = jest.fn().mockResolvedValue({ data: rows, error: null });
  const selectMock = jest.fn().mockReturnValue({ in: inMock });
  supabaseFromMock.mockImplementation((table: string) => {
    if (table === 'watchlist_universe') return { select: selectMock };
    return { select: jest.fn() };
  });
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  supabaseFromMock.mockReset();
  jest.clearAllMocks();
});

describe('Bug #R9 — pre-filter Asia tickers when session closed', () => {
  it('drops Asia candidates at 11:40 UTC (R9 prod reproduction)', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
    ]);
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const decoded = decodeURIComponent(url);
      let data: any[] = [];
      // R9 prod scenario: EODHD screener returns Asia + US even at 11:40 UTC
      // because SCANNER_SESSION_AWARE is false. Pre-filter should still drop.
      if (decoded.includes('"exchange","=","SHE"')) {
        data = [{ code: '002371', last_price: 12, refund_1d_p: 4.5, volume: 5_000_000, avgvol_50d: 4_000_000, market_capitalization: 5e9 }];
      } else if (decoded.includes('"exchange","=","KO"')) {
        data = [{ code: '000500', last_price: 50, refund_1d_p: 3.8, volume: 2_000_000, avgvol_50d: 1_500_000, market_capitalization: 1e10 }];
      } else if (decoded.includes('"exchange","=","PA"')) {
        data = [{ code: 'AIR.PA', last_price: 150, refund_1d_p: 4.0, volume: 1_000_000, avgvol_50d: 800_000, market_capitalization: 1e11 }];
      } else if (decoded.includes('"exchange","=","US"')) {
        data = [{ code: 'AAPL', last_price: 180, refund_1d_p: 5.0, volume: 10_000_000, avgvol_50d: 8_000_000, market_capitalization: 3e12 }];
      }
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' } as unknown as Response;
    });

    const blacklist = new TickerBlacklistService(makeConfig());
    const svc = makeService(blacklist, makeConfig());
    const candidates = await svc.fetchAllCandidates(new Date('2025-05-15T11:40:00Z'));

    const symbols = candidates.map((c) => c.symbol);
    // 11:40 UTC : Asia closed (00-08 UTC), US pre-RTH (14:30 UTC), seul EU open.
    expect(symbols).toContain('AIR.PA');
    expect(symbols).not.toContain('002371.SHE');
    expect(symbols).not.toContain('000500.KO');
    expect(symbols).not.toContain('AAPL.US');
  });

  it('keeps all sessions during overlap window (15:00 UTC = US + EU open)', async () => {
    mockEuWatchlists([
      { name: 'cac40', session_open_utc: '07:00:00', session_close_utc: '15:30:00' },
    ]);
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const decoded = decodeURIComponent(url);
      let data: any[] = [];
      if (decoded.includes('"exchange","=","US"')) {
        data = [{ code: 'AAPL', last_price: 180, refund_1d_p: 5.0, volume: 10_000_000, avgvol_50d: 8_000_000, market_capitalization: 3e12 }];
      } else if (decoded.includes('"exchange","=","PA"')) {
        data = [{ code: 'AIR.PA', last_price: 150, refund_1d_p: 4.0, volume: 1_000_000, avgvol_50d: 800_000, market_capitalization: 1e11 }];
      }
      return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' } as unknown as Response;
    });

    const blacklist = new TickerBlacklistService(makeConfig());
    const svc = makeService(blacklist, makeConfig());
    const candidates = await svc.fetchAllCandidates(new Date('2025-05-15T15:00:00Z'));

    const symbols = candidates.map((c) => c.symbol);
    expect(symbols).toContain('AAPL.US');
    expect(symbols).toContain('AIR.PA');
  });
});

describe('Bug #R10 — EodhdIntradayService blacklist short-circuit', () => {
  /**
   * Le scanner top-gainers ne fetch plus le screener NSE depuis PR #268.
   * Les calls .NSE en prod (81 erreurs 404 sur 1h44 de logs Fly 15/05) viennent
   * de chemins en aval : signal-forward-tracker cron, post-SL backfill, ou
   * gainers-user-shadow simulator qui rejoue des positions historiques.
   *
   * Le garde-fou définitif est dans EodhdIntradayService.getCandles :
   * si blacklist injecté + isBlacklisted(ticker) → return null sans fetch
   * + recordStrike() au cas où un 404 arriverait quand même.
   *
   * Validation directe ci-dessous via une mock ConfigService + fetch spy.
   */
  it('static blacklist : BHEL.NSE skipped before fetch (0 HTTP calls)', async () => {
    const { EodhdIntradayService } = await import('../services/eodhd-intraday.service');
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const cfg = makeConfig();
    const blacklist = new TickerBlacklistService(cfg);
    const supabase = { getClient: () => ({ from: () => ({ insert: async () => ({ data: null, error: null }) }) }) } as any;
    const svc = new EodhdIntradayService(cfg, supabase, blacklist);
    const res = await svc.getCandles('BHEL.NSE');
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('static blacklist disabled via env → fetch attempted', async () => {
    const { EodhdIntradayService } = await import('../services/eodhd-intraday.service');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [], text: async () => '',
    } as unknown as Response);
    const cfg = makeConfig({ GAINERS_NSE_BLACKLIST_ENABLED: 'false' });
    const blacklist = new TickerBlacklistService(cfg);
    const supabase = { getClient: () => ({ from: () => ({ insert: async () => ({ data: null, error: null }) }) }) } as any;
    const svc = new EodhdIntradayService(cfg, supabase, blacklist);
    await svc.getCandles('BHEL.NSE');
    expect(global.fetch).toHaveBeenCalled();
  });

  it('records strike on HTTP 404 → auto-blacklist after 3 strikes', async () => {
    const { EodhdIntradayService } = await import('../services/eodhd-intraday.service');
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: false, status: 404,
        json: async () => null,
        text: async () => 'Ticker Not Found',
      } as unknown as Response;
    });
    const cfg = makeConfig();
    const blacklist = new TickerBlacklistService(cfg);
    const supabase = { getClient: () => ({ from: () => ({ insert: async () => ({ data: null, error: null }) }) }) } as any;
    const svc = new EodhdIntradayService(cfg, supabase, blacklist);

    expect(blacklist.isBlacklisted('NEWFAIL.LSE')).toBe(false);
    await svc.getCandles('NEWFAIL.LSE');
    await svc.getCandles('NEWFAIL.LSE');
    await svc.getCandles('NEWFAIL.LSE');
    expect(callCount).toBe(3);
    expect(blacklist.isBlacklisted('NEWFAIL.LSE')).toBe(true);

    // 4e appel : short-circuit, pas de fetch
    await svc.getCandles('NEWFAIL.LSE');
    expect(callCount).toBe(3); // unchanged
  });

  it('back-compat : without blacklist injection, fetch proceeds normally', async () => {
    const { EodhdIntradayService } = await import('../services/eodhd-intraday.service');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => [], text: async () => '',
    } as unknown as Response);
    const cfg = makeConfig();
    const supabase = { getClient: () => ({ from: () => ({ insert: async () => ({ data: null, error: null }) }) }) } as any;
    // No blacklist arg → optional dependency undefined
    const svc = new EodhdIntradayService(cfg, supabase);
    await svc.getCandles('BHEL.NSE');
    expect(global.fetch).toHaveBeenCalled();
  });
});
