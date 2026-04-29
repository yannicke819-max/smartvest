/**
 * P19i — Tests pour la nouvelle fallback chain MTF :
 *   Yahoo (primaire) → EODHD (fallback) → IntradayCache (stale) → null
 *
 * Critique car l'utilisateur a observé en prod (29/04 15:30) que Yahoo
 * retournait 429 sur 100% des tickers depuis l'IP Fly. La chain doit basculer
 * proprement sur EODHD, puis sur le cache Supabase si EODHD aussi KO.
 */

import { Logger } from '@nestjs/common';
import { MultiTimeframePersistenceService } from '../services/multi-tf-persistence.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const mockBinance = { getKlines: jest.fn(), toBinanceSymbol: jest.fn().mockImplementation((s: string) => s) } as any;
const mockEodhd = { getCandles: jest.fn() } as any;
const mockYahoo = { getCandles: jest.fn() } as any;
const mockCache = { read: jest.fn(), write: jest.fn().mockResolvedValue(true) } as any;

beforeEach(() => {
  mockBinance.getKlines.mockReset();
  mockEodhd.getCandles.mockReset();
  mockYahoo.getCandles.mockReset();
  mockCache.read.mockReset();
  mockCache.write.mockReset().mockResolvedValue(true);
});

function makeService() {
  return new MultiTimeframePersistenceService(mockBinance, mockEodhd, mockYahoo, mockCache);
}

function fakeYahooCandles(n = 13) {
  const base = Date.parse('2026-04-29T09:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    datetime: new Date(base + i * 5 * 60_000).toISOString(),
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000,
  }));
}

function fakeEodhdSeries(n = 13) {
  const base = Math.floor(Date.parse('2026-04-29T09:00:00Z') / 1000);
  return {
    candles: Array.from({ length: n }, (_, i) => ({
      timestamp: base + i * 300,
      open: 200 + i, high: 201 + i, low: 199 + i, close: 200 + i, volume: 500,
    })),
  };
}

function fakeCachedSeries(ageMs = 5 * 60 * 1000, n = 13) {
  const base = Math.floor(Date.parse('2026-04-29T08:30:00Z') / 1000);
  return {
    symbol: 'AAPL',
    source: 'yahoo' as const,
    fetchedAt: Date.now() - ageMs,
    ageMs,
    candles: Array.from({ length: n }, (_, i) => ({
      timestamp: base + i * 300,
      open: 50 + i, high: 51 + i, low: 49 + i, close: 50 + i, volume: 100,
    })),
  };
}

describe('MTF P19i — fallback chain Yahoo → EODHD → cache → null', () => {
  it('Yahoo OK → returns coverage="yahoo", EODHD/cache NOT called, write-on-success cache', async () => {
    mockYahoo.getCandles.mockResolvedValue(fakeYahooCandles());
    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
    ]);
    const persist = result.get('AAPL');
    expect(persist).toBeDefined();
    expect(persist!.coverage).toBe('yahoo');
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    expect(mockCache.read).not.toHaveBeenCalled();
    // Write-on-success
    expect(mockCache.write).toHaveBeenCalledTimes(1);
    expect(mockCache.write.mock.calls[0][1]).toBe('yahoo');
  });

  it('Yahoo null → EODHD OK → returns coverage="eodhd", cache NOT read, write-on-success', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(fakeEodhdSeries());
    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
    ]);
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('eodhd');
    expect(mockYahoo.getCandles).toHaveBeenCalledTimes(1);
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(1);
    expect(mockCache.read).not.toHaveBeenCalled();
    expect(mockCache.write).toHaveBeenCalledTimes(1);
    expect(mockCache.write.mock.calls[0][1]).toBe('eodhd');
  });

  it('Yahoo + EODHD null → cache hit < 15 min → returns coverage="cache_stale" + cacheAgeMs', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(null);
    const cached = fakeCachedSeries(7 * 60 * 1000); // 7 min ago
    mockCache.read.mockResolvedValue(cached);
    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
    ]);
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('cache_stale');
    expect(persist!.cacheAgeMs).toBe(7 * 60 * 1000);
    expect(mockCache.read).toHaveBeenCalledTimes(1);
  });

  it('Yahoo + EODHD null + no cache → no entry in result map', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(null);
    mockCache.read.mockResolvedValue(null);
    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
    ]);
    expect(result.has('AAPL')).toBe(false);
  });

  it('Crypto BTC primary path : Binance → write cache as binance source', async () => {
    const baseTime = Date.parse('2026-04-29T09:00:00.000Z');
    mockBinance.getKlines.mockResolvedValue(
      Array.from({ length: 61 }, (_, i) => ({
        openTime: baseTime + i * 60_000,
        closeTime: baseTime + i * 60_000 + 60_000,
        open: 65000 + i, high: 65100 + i, low: 64900 + i, close: 65000 + i, volume: 10,
      })),
    );
    const svc = makeService();
    await svc.analyzeBatch([{ symbol: 'BTCUSDT', exchange: 'BINANCE', currentPrice: 65000 }]);
    expect(mockCache.write).toHaveBeenCalled();
    expect(mockCache.write.mock.calls[0][1]).toBe('binance');
    // Yahoo + EODHD never called for crypto
    expect(mockYahoo.getCandles).not.toHaveBeenCalled();
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
  });

  it('Yahoo throw → caught, EODHD next', async () => {
    mockYahoo.getCandles.mockRejectedValue(new Error('network'));
    mockEodhd.getCandles.mockResolvedValue(fakeEodhdSeries());
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    expect(result.get('AAPL')!.coverage).toBe('eodhd');
  });

  it('Cache write failure does NOT block return value', async () => {
    mockYahoo.getCandles.mockResolvedValue(fakeYahooCandles());
    mockCache.write.mockResolvedValue(false); // simulate Supabase down
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    expect(result.get('AAPL')!.coverage).toBe('yahoo'); // service stays usable
  });
});
