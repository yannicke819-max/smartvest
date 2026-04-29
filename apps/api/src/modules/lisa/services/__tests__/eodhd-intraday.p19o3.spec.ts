/**
 * P19o.3 (29/04/2026) — Tests pour le tick-data fallback (`/api/ticks/{SYMBOL}`).
 *
 * Use case : quand `/api/intraday` retourne un array vide même après widening
 * de la fenêtre (P19o), on tente l'endpoint tick-by-tick et on aggrège les
 * trades en bars OHLCV pour reconstruire une CandleSeries utilisable par le
 * gate persistence.
 *
 * Couvre les cas :
 *   1. URL construite correctement avec from/to en SECONDES Unix (per doc EODHD)
 *   2. Aggrégation correcte ticks → OHLCV bars (open/high/low/close/volume)
 *   3. Conversion timestamp ms → s pour bucket key
 *   4. Suffix mapping appliqué (.SS → .SHG, etc.)
 *   5. Limit clamp [1, 10000] (max EODHD)
 *   6. HTTP errors → null silently
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdIntradayService } from '../eodhd-intraday.service';
import { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function makeService(envMap: Record<string, string | undefined> = { EODHD_API_KEY: 'test-key' }) {
  const config = { get: jest.fn((k: string) => envMap[k]) } as unknown as ConfigService;
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }) }),
  } as unknown as SupabaseService;
  return new EodhdIntradayService(config, supabase);
}

describe('EodhdIntradayService — P19o.3 getTickData', () => {
  it('builds URL with /api/ticks/{symbol}, fmt=json, from/to in seconds', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    const fromUnix = 1_700_000_000;
    const toUnix = 1_700_086_400;
    await svc.getTickData('ATER.US', fromUnix, toUnix, 500);

    expect(capturedUrl).toContain('https://eodhd.com/api/ticks/ATER.US');
    const u = new URL(capturedUrl);
    expect(u.searchParams.get('fmt')).toBe('json');
    expect(u.searchParams.get('from')).toBe(String(fromUnix));
    expect(u.searchParams.get('to')).toBe(String(toUnix));
    expect(u.searchParams.get('limit')).toBe('500');
    expect(u.searchParams.get('api_token')).toBe('test-key');
  });

  it('clamps limit to [1, 10000]', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    await svc.getTickData('ATER.US', 1, 2, 50_000);
    expect(new URL(capturedUrl).searchParams.get('limit')).toBe('10000');

    await svc.getTickData('ATER.US', 1, 2, 0);
    expect(new URL(capturedUrl).searchParams.get('limit')).toBe('1');
  });

  it('normalizes Shanghai .SS → .SHG in tick URL', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [] };
    });

    await svc.getTickData('600519.SS', 1, 2, 100);
    expect(capturedUrl).toContain('600519.SHG');
    expect(capturedUrl).not.toMatch(/600519\.SS\?/);
  });

  it('parses tick rows correctly (price, volume, datetime, mkt, sl, seq)', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1704888000000, datetime: '2025-01-10 09:30:00', price: 185.25, volume: 500, mkt: 'Q', sl: '@', seq: 1 },
        { timestamp: 1704888001000, datetime: '2025-01-10 09:30:01', price: 185.30, volume: 200, mkt: 'T', sl: ' ', seq: 2 },
      ],
    });

    const ticks = await svc.getTickData('AAPL.US', 1, 2, 100);
    expect(ticks).toHaveLength(2);
    expect(ticks![0]).toEqual({
      timestamp: 1704888000000,
      datetime: '2025-01-10 09:30:00',
      price: 185.25,
      volume: 500,
      mkt: 'Q',
      sl: '@',
      seq: 1,
    });
  });

  it('filters out ticks with price <= 0 or timestamp <= 0 (defensive)', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1704888000000, price: 100, volume: 10, seq: 1 },
        { timestamp: 0, price: 100, volume: 10, seq: 2 },              // bad ts
        { timestamp: 1704888002000, price: 0, volume: 10, seq: 3 },    // bad price
        { timestamp: 1704888003000, price: 101, volume: 0, seq: 4 },   // valid (zero volume OK)
      ],
    });

    const ticks = await svc.getTickData('AAPL.US', 1, 2, 100);
    expect(ticks).toHaveLength(2);
    expect(ticks!.map((t) => t.seq)).toEqual([1, 4]);
  });

  it('returns null on HTTP error', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"forbidden"}',
    });

    const ticks = await svc.getTickData('AAPL.US', 1, 2, 100);
    expect(ticks).toBeNull();
  });

  it('returns null when no API key configured', async () => {
    const svc = makeService({ EODHD_API_KEY: undefined });
    (global as any).fetch = jest.fn();

    const ticks = await svc.getTickData('AAPL.US', 1, 2, 100);
    expect(ticks).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});

describe('EodhdIntradayService — P19o.3 getCandlesViaTicks', () => {
  it('aggregates ticks into 5m OHLCV bars (single bucket)', async () => {
    const svc = makeService();
    // 5 ticks dans le même bucket de 5min : 09:30:00 → 09:34:59 UTC
    // bucket = floor(ts_ms / 300_000)
    const tBaseMs = 1704888000000; // 2025-01-10 14:30:00 UTC
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: tBaseMs + 0,      price: 100.0, volume: 100, seq: 1 },  // open
        { timestamp: tBaseMs + 30_000, price: 102.5, volume: 200, seq: 2 },  // new high
        { timestamp: tBaseMs + 60_000, price: 99.5,  volume: 150, seq: 3 },  // new low
        { timestamp: tBaseMs + 120_000, price: 101.0, volume: 50,  seq: 4 },
        { timestamp: tBaseMs + 240_000, price: 100.8, volume: 80,  seq: 5 }, // close
      ],
    });

    const series = await svc.getCandlesViaTicks('AAPL.US', '5m', 20);
    expect(series).not.toBeNull();
    expect(series!.candles).toHaveLength(1);
    const bar = series!.candles[0];
    expect(bar.open).toBe(100.0);
    expect(bar.high).toBe(102.5);
    expect(bar.low).toBe(99.5);
    expect(bar.close).toBe(100.8);
    expect(bar.volume).toBe(100 + 200 + 150 + 50 + 80);
  });

  it('aggregates ticks across multiple 5m buckets', async () => {
    const svc = makeService();
    const tBaseMs = 1704888000000;
    const fiveMinMs = 5 * 60 * 1000;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        // Bucket 1
        { timestamp: tBaseMs + 0,      price: 100, volume: 50,  seq: 1 },
        { timestamp: tBaseMs + 60_000, price: 105, volume: 50,  seq: 2 },
        // Bucket 2 (5 min plus tard)
        { timestamp: tBaseMs + fiveMinMs + 0,      price: 104, volume: 30, seq: 3 },
        { timestamp: tBaseMs + fiveMinMs + 60_000, price: 107, volume: 70, seq: 4 },
        // Bucket 3
        { timestamp: tBaseMs + 2 * fiveMinMs, price: 106, volume: 100, seq: 5 },
      ],
    });

    const series = await svc.getCandlesViaTicks('AAPL.US', '5m', 20);
    expect(series).not.toBeNull();
    expect(series!.candles).toHaveLength(3);
    expect(series!.candles[0].open).toBe(100);
    expect(series!.candles[0].close).toBe(105);
    expect(series!.candles[1].open).toBe(104);
    expect(series!.candles[1].close).toBe(107);
    expect(series!.candles[1].high).toBe(107);
    expect(series!.candles[2].volume).toBe(100);
    // Bars sorted ascending by timestamp
    expect(series!.candles[0].timestamp).toBeLessThan(series!.candles[1].timestamp);
    expect(series!.candles[1].timestamp).toBeLessThan(series!.candles[2].timestamp);
  });

  it('handles defensive timestamp-in-seconds case (some endpoints differ)', async () => {
    const svc = makeService();
    // Si on reçoit ts en secondes (< 1e11), on doit convertir en ms avant bucket
    const tBaseSec = 1704888000;
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: tBaseSec,       price: 100, volume: 10, seq: 1 },
        { timestamp: tBaseSec + 100, price: 101, volume: 20, seq: 2 },
      ],
    });

    const series = await svc.getCandlesViaTicks('AAPL.US', '5m', 20);
    expect(series).not.toBeNull();
    expect(series!.candles).toHaveLength(1);
    expect(series!.candles[0].open).toBe(100);
    expect(series!.candles[0].close).toBe(101);
  });

  it('slices to last N bars', async () => {
    const svc = makeService();
    const tBaseMs = 1704888000000;
    const fiveMinMs = 5 * 60 * 1000;
    // 50 buckets dispersés
    const ticks = Array.from({ length: 50 }, (_, i) => ({
      timestamp: tBaseMs + i * fiveMinMs,
      price: 100 + i,
      volume: 10,
      seq: i + 1,
    }));
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ticks,
    });

    const series = await svc.getCandlesViaTicks('AAPL.US', '5m', 13);
    expect(series).not.toBeNull();
    expect(series!.candles).toHaveLength(13);
    // Les 13 derniers bars (bars 38 à 50)
    expect(series!.candles[0].open).toBe(100 + 37);
    expect(series!.candles[12].open).toBe(100 + 49);
  });

  it('returns null when tick API returns empty array (eg. ticker not covered)', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const series = await svc.getCandlesViaTicks('UNKNOWN.US', '5m', 13);
    expect(series).toBeNull();
  });

  it('returns null when tick API errors out', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"ticker not found"}',
    });

    const series = await svc.getCandlesViaTicks('UNKNOWN.US', '5m', 13);
    expect(series).toBeNull();
  });
});
