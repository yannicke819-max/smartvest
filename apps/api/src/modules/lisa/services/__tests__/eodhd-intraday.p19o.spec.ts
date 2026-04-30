/**
 * P19o (29/04/2026) — Tests pour la fenêtre intraday élargie + le fallback
 * `/api/real-time` quand l'intraday retourne empty array.
 *
 * Issue #107 : micro-caps illiquides (BIYA, ATER, SBLX, OMCL...) renvoyaient
 * un array vide sur `/api/intraday/{ticker}.US` car la fenêtre from/to était
 * de 2.16h seulement (count*interval*2 avec count=13, interval=300s).
 *
 * Fix P19o : windowForInterval renvoie 1d / 5d / 30d selon l'interval, ce qui
 * couvre overnight + weekends + tickers à trades sparses.
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

describe('EodhdIntradayService — P19o window widening', () => {
  it('windowForInterval returns 2d / 5d / 30d for 1m / 5m / 1h (1m bumped 24h→48h in P19r)', () => {
    const svc = makeService();
    const fn = (svc as any).windowForInterval.bind(svc);
    // P19r — 1m window bumped 24h → 48h to capture last asia/NSE/AU session
    expect(fn('1m')).toBe(48 * 3600);
    expect(fn('5m')).toBe(5 * 24 * 3600);
    expect(fn('1h')).toBe(30 * 24 * 3600);
  });

  it('5m getCandles uses a from/to window of ≥ 5 days (was 2.16h pre-P19o)', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      };
    });

    await svc.getCandles('ATER.US', '5m', 13);

    expect(capturedUrl).toContain('https://eodhd.com/api/intraday/ATER.US');
    const u = new URL(capturedUrl);
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    expect(Number.isFinite(from) && Number.isFinite(to)).toBe(true);
    const windowSec = to - from;
    // ≥ 5 days = 432_000s, with -1s tolerance for clock skew between Date.now() calls
    expect(windowSec).toBeGreaterThanOrEqual(5 * 24 * 3600 - 1);
    // And not absurdly larger (sanity)
    expect(windowSec).toBeLessThanOrEqual(5 * 24 * 3600 + 60);
  });

  it('1m getCandles uses a 2-day window (P19r)', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    await svc.getCandles('AAPL.US', '1m', 60);

    const u = new URL(capturedUrl);
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    // P19r — 1m window bumped 24h → 48h
    expect(to - from).toBeGreaterThanOrEqual(48 * 3600 - 1);
    expect(to - from).toBeLessThanOrEqual(48 * 3600 + 60);
  });

  it('1h getCandles uses a 30-day window', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    await svc.getCandles('SHOP.TO', '1h', 24);

    const u = new URL(capturedUrl);
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    expect(to - from).toBeGreaterThanOrEqual(30 * 24 * 3600 - 1);
    expect(to - from).toBeLessThanOrEqual(30 * 24 * 3600 + 60);
  });

  it('still slices to the last N candles after fetching a wide window', async () => {
    const svc = makeService();
    // Génère 500 candles bidons sur un range de 5 jours
    const now = Math.floor(Date.now() / 1000);
    const fakeCandles = Array.from({ length: 500 }, (_, i) => ({
      timestamp: now - (499 - i) * 300,
      open: 100 + i * 0.1,
      high: 101 + i * 0.1,
      low: 99 + i * 0.1,
      close: 100 + i * 0.1,
      volume: 1000,
    }));
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeCandles,
      text: async () => JSON.stringify(fakeCandles),
    });

    const series = await svc.getCandles('AAPL.US', '5m', 20);
    expect(series).not.toBeNull();
    expect(series!.candles.length).toBe(20);
    // Les 20 dernières candles (les plus récentes)
    expect(series!.candles[series!.candles.length - 1].timestamp).toBe(now);
  });
});

describe('EodhdIntradayService — P19o getQuote real-time fallback', () => {
  it('returns price + changePct from /api/real-time on 200 OK', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'ATER.US',
          timestamp: 1735000000,
          open: 0.95,
          high: 1.10,
          low: 0.92,
          close: 1.05,
          volume: 1_500_000,
          change: 0.10,
          change_p: 10.5,
        }),
      };
    });

    const quote = await svc.getQuote('ATER.US');
    expect(capturedUrl).toContain('https://eodhd.com/api/real-time/ATER.US');
    expect(capturedUrl).toContain('fmt=json');
    expect(quote).toEqual({ price: 1.05, changePct: 10.5, timestamp: 1735000000 });
  });

  it('normalizes Shanghai .SS → .SHG in the real-time URL', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: '600519.SHG', close: 1800, change_p: 2.1, timestamp: 1735000000 }),
      };
    });

    await svc.getQuote('600519.SS');
    expect(capturedUrl).toContain('600519.SHG');
    expect(capturedUrl).not.toContain('600519.SS?');
  });

  it('returns null when the API returns an error status', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    });

    const quote = await svc.getQuote('ATER.US');
    expect(quote).toBeNull();
  });

  it('returns null when no API key is configured', async () => {
    const svc = makeService({ EODHD_API_KEY: undefined });
    (global as any).fetch = jest.fn();

    const quote = await svc.getQuote('ATER.US');
    expect(quote).toBeNull();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('returns null when close is missing or zero (defensive)', async () => {
    const svc = makeService();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 'X', close: 0, change_p: 0 }),
    });

    const quote = await svc.getQuote('X.US');
    expect(quote).toBeNull();
  });
});
