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
const mockEodhd = { getCandles: jest.fn(), getCandlesViaTicks: jest.fn() } as any;
const mockYahoo = { getCandles: jest.fn() } as any;
const mockCache = { read: jest.fn(), write: jest.fn().mockResolvedValue(true) } as any;

beforeEach(() => {
  mockBinance.getKlines.mockReset();
  mockEodhd.getCandles.mockReset();
  // P19o.3 — getCandlesViaTicks default null so tests covering only intraday→cache
  // path don't need to mock it explicitly. Tests covering the tick-data fallback
  // override per-test.
  mockEodhd.getCandlesViaTicks.mockReset().mockResolvedValue(null);
  mockYahoo.getCandles.mockReset();
  mockCache.read.mockReset();
  mockCache.write.mockReset().mockResolvedValue(true);
});

const mockConfig = { get: jest.fn().mockReturnValue(undefined) } as any;

function makeService() {
  return new MultiTimeframePersistenceService(mockBinance, mockEodhd, mockYahoo, mockCache, mockConfig);
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

  it('Yahoo null → EODHD 1m insufficient → EODHD 5m OK → returns coverage="eodhd"', async () => {
    // P19v — chain order : yahoo → eodhd 1m → eodhd 5m → ticks → cache → none
    // 1m returns insufficient (13 candles) → falls back to 5m → coverage='eodhd'
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? null : fakeEodhdSeries(),
    );
    const svc = makeService();
    const result = await svc.analyzeBatch([
      { symbol: 'AAPL', exchange: 'US', currentPrice: 100 },
    ]);
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('eodhd');
    expect(mockYahoo.getCandles).toHaveBeenCalledTimes(1);
    // Both 1m and 5m attempts (1m null → 5m fallback)
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(2);
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

  it('Yahoo throw → caught, EODHD 5m next (1m insufficient at 13 candles)', async () => {
    mockYahoo.getCandles.mockRejectedValue(new Error('network'));
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? null : fakeEodhdSeries(),
    );
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

  // ── P19o.3 — Tick-data fallback (entre EODHD intraday et cache) ────────────

  it('P19o.3 — Yahoo null + EODHD 1m null + EODHD 5m null → tick-data OK → coverage="eodhd_ticks"', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(null);  // both 1m and 5m return null
    mockEodhd.getCandlesViaTicks.mockResolvedValue(fakeEodhdSeries());
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    const persist = result.get('AAPL');
    expect(persist).toBeDefined();
    expect(persist!.coverage).toBe('eodhd_ticks');
    // P19v — chain now tries 1m AND 5m before falling to ticks
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(2);
    expect(mockEodhd.getCandlesViaTicks).toHaveBeenCalledTimes(1);
    expect(mockCache.read).not.toHaveBeenCalled();
    expect(mockCache.write).toHaveBeenCalledTimes(1);
    expect(mockCache.write.mock.calls[0][1]).toBe('eodhd_ticks');
  });

  it('P19o.3 — Yahoo null + EODHD intraday null + ticks null → falls through to cache', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(null);
    mockEodhd.getCandlesViaTicks.mockResolvedValue(null);
    mockCache.read.mockResolvedValue(fakeCachedSeries(7 * 60 * 1000));
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('cache_stale');
    expect(mockEodhd.getCandlesViaTicks).toHaveBeenCalledTimes(1);
    expect(mockCache.read).toHaveBeenCalledTimes(1);
  });

  it('P19o.3 — EODHD 5m intraday OK skips tick-data (intraday wins, no extra API call)', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? null : fakeEodhdSeries(),
    );
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    expect(result.get('AAPL')!.coverage).toBe('eodhd');
    expect(mockEodhd.getCandlesViaTicks).not.toHaveBeenCalled();
  });

  // ── P19v — EODHD 1m natif comme primaire (résout tf1m=null sur equities) ────

  it('P19v — Yahoo null + EODHD 1m OK (≥60 candles) → coverage="eodhd_1m" with native tf1m', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    // 65 candles 1m simulant un fetch EODHD intraday 1m réussi.
    const base = Math.floor(Date.parse('2026-04-29T13:00:00Z') / 1000);
    const oneMinCandles = Array.from({ length: 65 }, (_, i) => ({
      timestamp: base + i * 60,
      open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1,
      close: 100 + i * 0.1, volume: 5000,
    }));
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? { candles: oneMinCandles } : null,
    );

    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 106.4 }]);
    const persist = result.get('AAPL');
    expect(persist).toBeDefined();
    expect(persist!.coverage).toBe('eodhd_1m');
    // tf1m est désormais POPULÉ (vs null pré-P19v)
    expect(persist!.tf1m).not.toBeNull();
    expect(persist!.availableCount).toBe(6); // tous les 6 TFs dispos
    // Seul le 1m call (5m never tried since 1m succeeded)
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(1);
    expect(mockEodhd.getCandlesViaTicks).not.toHaveBeenCalled();
    expect(mockCache.write.mock.calls[0][1]).toBe('eodhd_1m');
  });

  it('P19v — EODHD 1m insufficient (<60 candles) → falls back to 5m → coverage="eodhd"', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    // Only 30 candles 1m — insufficient for tf1h calc
    const base = Math.floor(Date.parse('2026-04-29T13:00:00Z') / 1000);
    const shortOneMin = Array.from({ length: 30 }, (_, i) => ({
      timestamp: base + i * 60,
      open: 100, high: 100, low: 100, close: 100, volume: 1000,
    }));
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? { candles: shortOneMin } : fakeEodhdSeries(),
    );

    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    const persist = result.get('AAPL');
    expect(persist!.coverage).toBe('eodhd');
    expect(mockEodhd.getCandles).toHaveBeenCalledTimes(2);
  });

  it('P19v — Yahoo OK skips EODHD 1m + 5m + ticks (yahoo primaire wins)', async () => {
    mockYahoo.getCandles.mockResolvedValue(fakeYahooCandles());
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    expect(result.get('AAPL')!.coverage).toBe('yahoo');
    expect(mockEodhd.getCandles).not.toHaveBeenCalled();
    expect(mockEodhd.getCandlesViaTicks).not.toHaveBeenCalled();
  });

  it('P19v — EODHD 1m exactly 60 candles OK (boundary)', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    const base = Math.floor(Date.parse('2026-04-29T13:00:00Z') / 1000);
    const exact60 = Array.from({ length: 60 }, (_, i) => ({
      timestamp: base + i * 60,
      open: 100 + i * 0.05, high: 101, low: 99,
      close: 100 + i * 0.05, volume: 1000,
    }));
    mockEodhd.getCandles.mockImplementation(async (_t: string, interval: string) =>
      interval === '1m' ? { candles: exact60 } : null,
    );
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 102.95 }]);
    expect(result.get('AAPL')!.coverage).toBe('eodhd_1m');
  });

  it('P19o.3 — getCandlesViaTicks throw → caught, falls through to cache', async () => {
    mockYahoo.getCandles.mockResolvedValue(null);
    mockEodhd.getCandles.mockResolvedValue(null);
    mockEodhd.getCandlesViaTicks.mockRejectedValue(new Error('ticks API timeout'));
    mockCache.read.mockResolvedValue(fakeCachedSeries(3 * 60 * 1000));
    const svc = makeService();
    const result = await svc.analyzeBatch([{ symbol: 'AAPL', exchange: 'US', currentPrice: 100 }]);
    expect(result.get('AAPL')!.coverage).toBe('cache_stale');
  });
});
