/**
 * P18e — Tests for log throttling + market pre-filter + counters.
 *
 * Three regression scenarios (issue from Fly logs 09:14:46–09:15:03 UTC) :
 *   1. 50 unsupported / no-data tickers in one batch → ONE aggregated log line
 *      (not 50 per-symbol debug lines)
 *   2. Pre-filter unsupported equity exchange (e.g. "TO" Toronto, "NSE" India)
 *      → no EODHD call + counter increment
 *   3. Counters cumulatives `noIntradayCounter` and
 *      `skippedUnsupportedMarketCounter` are correct after multiple batches
 */

import { Logger } from '@nestjs/common';
import { MultiTimeframePersistenceService } from '../services/multi-tf-persistence.service';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockBinance = {
  toBinanceSymbol: jest.fn().mockImplementation((s: string) => s),
  getKlines: jest.fn(),
} as any;

const mockEodhd = {
  getCandles: jest.fn(),
  // P19o.3 — tick-data fallback méthode ajoutée. Default null pour tests P18e
  // qui couvrent la fallback chain mais ne testent pas spécifiquement les ticks.
  getCandlesViaTicks: jest.fn().mockResolvedValue(null),
} as any;

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

beforeEach(() => {
  logSpy.mockClear();
  debugSpy.mockClear();
  warnSpy.mockClear();
  mockBinance.getKlines.mockReset();
  mockEodhd.getCandles.mockReset();
  mockEodhd.getCandlesViaTicks.mockReset().mockResolvedValue(null);
  mockYahoo.getCandles.mockReset();
  mockYahoo.getCandles.mockResolvedValue(null);  // P19a default — Yahoo fails unless overriden
});

// P19a — Yahoo fallback added as 3rd ctor arg. Mock null-default is set in
// the global beforeEach so individual tests can override BEFORE makeService.
const mockYahoo = {
  getCandles: jest.fn(),
} as any;
// P19i — IntradayCacheService injecté en 4e arg. Tests P18e n'utilisent
// pas le cache, donc mock no-op (read returns null, write returns false).
const mockIntradayCache = {
  read: jest.fn().mockResolvedValue(null),
  write: jest.fn().mockResolvedValue(false),
} as any;

const mockConfig = { get: jest.fn().mockReturnValue(undefined) } as any;

function makeService(): MultiTimeframePersistenceService {
  return new MultiTimeframePersistenceService(mockBinance, mockEodhd, mockYahoo, mockIntradayCache, mockConfig, { getStatus: () => ({ throttle: { multitfPaused: false } }) } as any);
}

// ── 1. Aggregated log — single line for N misses ─────────────────────────────

describe('analyzeBatch — log throttling', () => {
  it('emits ONE aggregated log line for 50 tickers without intraday data (was 50 debug lines)', async () => {
    // All EODHD calls return null/empty → no data
    mockEodhd.getCandles.mockResolvedValue(null);

    const candidates = Array.from({ length: 50 }, (_, i) => ({
      symbol: `TICK${i}`,
      exchange: 'US',
      currentPrice: 100,
    }));

    const svc = makeService();
    const result = await svc.analyzeBatch(candidates);

    expect(result.size).toBe(0);
    // Find the aggregated log line
    const aggregateLogs = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[mtf-persist] no intraday coverage for'),
    );
    expect(aggregateLogs.length).toBe(1);
    const logMsg = String(aggregateLogs[0][0]);
    expect(logMsg).toContain('50 ticker(s)');
    expect(logMsg).toContain('sample:');
    // Counter should reflect all 50 misses
    expect(svc.getNoIntradayCounter()).toBe(50);
  });

  it('does not emit the aggregated log when batch has 0 misses', async () => {
    // Return a valid candle series for every call
    const fakeCandles = Array.from({ length: 13 }, (_, i) => ({
      datetime: `2026-04-29 ${String(9 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}:00`,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
    }));
    mockEodhd.getCandles.mockResolvedValue({ candles: fakeCandles });

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 105 },
    ]);

    const aggregateLogs = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[mtf-persist] no intraday'),
    );
    expect(aggregateLogs.length).toBe(0);
  });

  it('emits no per-symbol "no eodhd intraday" debug spam (was 1 line per ticker)', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'AAA', exchange: 'US', currentPrice: 100 },
      { symbol: 'BBB', exchange: 'US', currentPrice: 200 },
      { symbol: 'CCC', exchange: 'US', currentPrice: 300 },
    ]);

    // The legacy spam pattern was: `[mtf-persist] <symbol> no eodhd intraday`
    // It must NEVER appear (replaced by the aggregated log line).
    const allCalls = [
      ...logSpy.mock.calls,
      ...debugSpy.mock.calls,
      ...warnSpy.mock.calls,
    ];
    const legacySpam = allCalls.filter((c) =>
      /\[mtf-persist\] (AAA|BBB|CCC) no eodhd intraday/.test(String(c[0])),
    );
    expect(legacySpam.length).toBe(0);

    // The aggregate log IS expected (single line for all 3)
    const aggregateLog = logSpy.mock.calls.filter((c) =>
      /\[mtf-persist\] no intraday coverage for/.test(String(c[0])),
    );
    expect(aggregateLog.length).toBe(1);
  });
});

// ── 2. P19a — Yahoo fallback chain (EODHD primaire → Yahoo fallback) ────────

describe('analyzeBatch — P19a Yahoo fallback chain', () => {
  it('calls EODHD for ALL exchanges (no pre-filter) — Yahoo invoked when EODHD returns null', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);
    mockYahoo.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'SHOP', exchange: 'TO', currentPrice: 100 },        // Toronto
      { symbol: 'RELIANCE', exchange: 'NSE', currentPrice: 200 },   // India
      { symbol: '199820', exchange: 'KO', currentPrice: 50 },       // Korea KOSPI
    ]);

    // P19v — EODHD called twice per ticker (1m primary + 5m fallback) when both null
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(6);
    // Yahoo fallback invoked for all 3 (yahoo is primary in P19i chain)
    expect(mockYahoo.getCandles).toHaveBeenCalledTimes(3);
    // Counter stays at 0 (no pre-filter anymore — every ticker is tried)
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
    // 3 tickers ended up with no coverage
    expect(svc.getNoIntradayCounter()).toBe(3);
  });

  it('P19i — uses Yahoo result with coverage="yahoo" — Yahoo PRIMAIRE (P19i reordered)', async () => {
    const baseTime = Date.parse('2026-04-29T09:00:00.000Z');
    const fakeCandles = Array.from({ length: 13 }, (_, i) => ({
      datetime: new Date(baseTime + i * 5 * 60_000).toISOString(),
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000,
    }));
    mockYahoo.getCandles.mockResolvedValue(fakeCandles);

    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: '199820', exchange: 'KO', currentPrice: 105 },
    ]);

    expect(mockYahoo.getCandles).toHaveBeenCalledTimes(1);
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    const persist = result.get('199820');
    expect(persist).toBeDefined();
    expect(persist!.coverage).toBe('yahoo');
  });

  it('P19i — does NOT call EODHD when Yahoo already provides intraday (yahoo primaire wins)', async () => {
    const baseTime = Date.parse('2026-04-29T09:00:00.000Z');
    const fakeYahooCandles = Array.from({ length: 13 }, (_, i) => ({
      datetime: new Date(baseTime + i * 5 * 60_000).toISOString(),
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000,
    }));
    mockYahoo.getCandles.mockResolvedValue(fakeYahooCandles);

    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 180 },
    ]);

    expect(mockYahoo.getCandles).toHaveBeenCalledTimes(1);
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('yahoo');
  });

  it('crypto bypasses both EODHD and Yahoo (uses Binance with coverage="binance")', async () => {
    mockBinance.getKlines.mockResolvedValue([]);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'BTCUSDT', exchange: 'BINANCE', currentPrice: 65000 },
    ]);

    expect(mockBinance.getKlines).toHaveBeenCalledTimes(1);
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    expect(mockYahoo.getCandles).not.toHaveBeenCalled();
  });

  it('emits "yahoo fallback used" structured log when at least 1 ticker uses Yahoo', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);
    const fakeCandles = Array.from({ length: 13 }, (_, i) => ({
      datetime: `2026-04-29T1${i % 10}:0${(i * 5) % 60}:00.000Z`,
      open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    mockYahoo.getCandles.mockResolvedValue(fakeCandles);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: '199820', exchange: 'KO', currentPrice: 105 },
      { symbol: '006340', exchange: 'KO', currentPrice: 200 },
    ]);

    const yahooLog = logSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('[mtf-persist] yahoo fallback used for'),
    );
    expect(yahooLog).toBeDefined();
    expect(String(yahooLog![0])).toContain('2 ticker(s)');
  });
});

// ── 3. Counters cumulative across batches ───────────────────────────────────

describe('counters', () => {
  it('noIntradayCounter is cumulative across multiple batches', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([{ symbol: 'A', exchange: 'US', currentPrice: 100 }]);
    expect(svc.getNoIntradayCounter()).toBe(1);
    await svc.analyzeBatch([
      { symbol: 'B', exchange: 'US', currentPrice: 100 },
      { symbol: 'C', exchange: 'US', currentPrice: 100 },
    ]);
    expect(svc.getNoIntradayCounter()).toBe(3);
  });

  it('skippedUnsupportedMarketCounter stays at 0 since P19a (no pre-filter)', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);
    const svc = makeService();
    await svc.analyzeBatch([{ symbol: 'X', exchange: 'TO', currentPrice: 100 }]);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
    await svc.analyzeBatch([
      { symbol: 'Y', exchange: 'NSE', currentPrice: 100 },
      { symbol: 'Z', exchange: 'BSE', currentPrice: 100 },
    ]);
    // P19a — counter preserved for back-compat metric API but never increments
    // (every market is now tried via EODHD then Yahoo fallback chain).
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
  });

  it('resetCounters() clears noIntradayCounter', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'A', exchange: 'US', currentPrice: 100 },
      { symbol: 'B', exchange: 'TO', currentPrice: 100 },
    ]);
    expect(svc.getNoIntradayCounter()).toBe(2);
    svc.resetCounters();
    expect(svc.getNoIntradayCounter()).toBe(0);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
  });
});
