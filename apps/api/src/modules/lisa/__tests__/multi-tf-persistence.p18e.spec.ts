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
});

function makeService(): MultiTimeframePersistenceService {
  return new MultiTimeframePersistenceService(mockBinance, mockEodhd);
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
      String(c[0]).includes('[mtf-persist] no intraday for'),
    );
    expect(aggregateLogs.length).toBe(1);
    const logMsg = String(aggregateLogs[0][0]);
    expect(logMsg).toContain('50 tickers');
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
      String(c[0]).startsWith('[mtf-persist] no intraday for'),
    );
    expect(aggregateLog.length).toBe(1);
  });
});

// ── 2. Market pre-filter ─────────────────────────────────────────────────────

describe('analyzeBatch — market pre-filter', () => {
  it('does NOT call EODHD for tickers from unsupported exchanges (TO, NSE, BSE)', async () => {
    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'SHOP', exchange: 'TO', currentPrice: 100 }, // Toronto — unsupported
      { symbol: 'RELIANCE', exchange: 'NSE', currentPrice: 200 },
      { symbol: 'TCS', exchange: 'BSE', currentPrice: 3500 },
    ]);

    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(3);
  });

  it('DOES call EODHD for supported equity exchanges (US, LSE, XETRA, PA, TSE, HK)', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
      { symbol: 'SHEL', exchange: 'LSE', currentPrice: 25 },
      { symbol: 'SAP', exchange: 'XETRA', currentPrice: 200 },
      { symbol: 'AIR', exchange: 'PA', currentPrice: 150 },
      { symbol: '7203', exchange: 'TSE', currentPrice: 2500 },
      { symbol: '0700', exchange: 'HK', currentPrice: 350 },
    ]);

    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(6);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
  });

  it('crypto tickers (BINANCE / *USDT) bypass the equity pre-filter', async () => {
    mockBinance.getKlines.mockResolvedValue([]);  // no klines → no data

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'BTCUSDT', exchange: 'BINANCE', currentPrice: 65000 },
      { symbol: 'ETHUSDT', exchange: 'BINANCE', currentPrice: 3500 },
    ]);

    expect(mockBinance.getKlines).toHaveBeenCalledTimes(2);
    // Crypto did NOT increment unsupported-market counter
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
  });

  it('mixes supported equity + unsupported equity + crypto in one batch correctly', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);
    mockBinance.getKlines.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 180 },         // supported equity
      { symbol: 'SHOP', exchange: 'TO', currentPrice: 100 },          // unsupported
      { symbol: 'BTCUSDT', exchange: 'BINANCE', currentPrice: 65000 }, // crypto
      { symbol: 'TCS', exchange: 'BSE', currentPrice: 3500 },          // unsupported
    ]);

    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(1);  // only AAPL
    expect(mockBinance.getKlines).toHaveBeenCalledTimes(1); // only BTCUSDT
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(2); // SHOP + TCS
    expect(svc.getNoIntradayCounter()).toBe(2);  // AAPL + BTCUSDT (both null)
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

  it('skippedUnsupportedMarketCounter is cumulative across multiple batches', async () => {
    const svc = makeService();
    await svc.analyzeBatch([{ symbol: 'X', exchange: 'TO', currentPrice: 100 }]);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(1);
    await svc.analyzeBatch([
      { symbol: 'Y', exchange: 'NSE', currentPrice: 100 },
      { symbol: 'Z', exchange: 'BSE', currentPrice: 100 },
    ]);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(3);
  });

  it('resetCounters() clears both', async () => {
    mockEodhd.getCandles.mockResolvedValue(null);

    const svc = makeService();
    await svc.analyzeBatch([
      { symbol: 'A', exchange: 'US', currentPrice: 100 },
      { symbol: 'B', exchange: 'TO', currentPrice: 100 },
    ]);
    expect(svc.getNoIntradayCounter()).toBe(1);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(1);
    svc.resetCounters();
    expect(svc.getNoIntradayCounter()).toBe(0);
    expect(svc.getSkippedUnsupportedMarketCounter()).toBe(0);
  });
});
