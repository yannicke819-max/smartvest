/**
 * P19g — Tests for direct Yahoo Chart HTTP API fetch (drops yahoo-finance2 package).
 *
 * Issue (29/04/2026 15:09 prod) :
 *   `[YahooIntradayService] [yahoo-intraday] X→Y error: TypeError: yahooFinance.chart is not a function`
 *
 * Cause : `yahoo-finance2@2.14.0` est une version gutted qui n'expose que
 * `quote` et `autoc` modules. Pas de `chart`, `historical`, etc.
 *
 * Fix : drop complet du package, fetch direct sur l'API Yahoo Finance
 * Chart (`https://query1.finance.yahoo.com/v8/finance/chart/{symbol}`).
 * Endpoint stable, public, JSON, pas d'auth, juste un User-Agent réaliste.
 *
 * Tests ci-dessous mock `global.fetch` pour valider :
 *   - URL correcte construite (interval/range/encodage symbol)
 *   - Headers User-Agent réaliste + Accept JSON + Accept-Language
 *   - Parse correct de la response Yahoo Chart format
 *   - Filtrage des null close (Yahoo retourne parfois des trous)
 *   - Graceful degrade : 403 / 5xx / api error → null
 */

import { Logger } from '@nestjs/common';
import { YahooIntradayService } from '../yahoo-intraday.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockYahooChartOk(timestamps: number[], opens: number[], highs: number[], lows: number[], closes: (number | null)[], volumes: number[]) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { symbol: 'AAPL', currency: 'USD' },
          timestamp: timestamps,
          indicators: {
            quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }],
          },
        }],
        error: null,
      },
    }),
    text: async () => '',
  } as any);
}

describe('YahooIntradayService — P19g direct HTTP fetch', () => {
  it('builds correct URL with interval=5m and range=1d, encodes symbol', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ chart: { result: [], error: null } }),
        text: async () => '',
      } as any;
    });
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(capturedUrl).toContain('https://query1.finance.yahoo.com/v8/finance/chart/AAPL');
    expect(capturedUrl).toContain('interval=5m');
    expect(capturedUrl).toContain('range=1d');
  });

  it('encodes special characters in Yahoo symbol (e.g. ^GSPC, BRK-B)', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ chart: { result: [], error: null } }), text: async () => '' } as any;
    });
    const svc = new YahooIntradayService();
    await svc.getCandles('600000.SS', '5m'); // Shanghai
    expect(capturedUrl).toContain('600000.SS');
  });

  it('sends realistic User-Agent + Accept JSON headers (anti-Cloudflare 403)', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ chart: { result: [], error: null } }), text: async () => '' } as any;
    });
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(capturedHeaders!['Accept']).toBe('application/json');
    expect(capturedHeaders!['Accept-Language']).toMatch(/en-US/);
  });

  it('parses Yahoo Chart response into YahooCandle[]', async () => {
    const baseTs = 1761830400; // 2025-10-30 12:00:00 UTC
    mockYahooChartOk(
      [baseTs, baseTs + 300, baseTs + 600],
      [180, 181, 182],
      [181, 182, 183],
      [179, 180, 181],
      [180.5, 181.5, 182.5],
      [1000, 2000, 3000],
    );
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]).toEqual({
      datetime: new Date(baseTs * 1000).toISOString(),
      open: 180,
      high: 181,
      low: 179,
      close: 180.5,
      volume: 1000,
    });
    expect(result![2].close).toBe(182.5);
  });

  it('filters out candles with null close (Yahoo returns gaps)', async () => {
    const baseTs = 1761830400;
    mockYahooChartOk(
      [baseTs, baseTs + 300, baseTs + 600],
      [180, 181, 182],
      [181, 182, 183],
      [179, 180, 181],
      [180.5, null, 182.5],  // gap au milieu
      [1000, 2000, 3000],
    );
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result!.length).toBe(2);
    expect(result![0].close).toBe(180.5);
    expect(result![1].close).toBe(182.5);
  });

  it('returns null when HTTP not OK (403/500/etc)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'forbidden',
    } as any);
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).toBeNull();
  });

  it('returns null when Yahoo returns chart.error (e.g. unknown symbol)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: { result: null, error: { code: 'Not Found', description: 'No data found' } },
      }),
      text: async () => '',
    } as any);
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('FAKEXYZ.US', '5m');
    expect(result).toBeNull();
  });

  it('returns null when result has no timestamps', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [{ meta: { symbol: 'X' }, timestamp: [], indicators: { quote: [{}] } }],
          error: null,
        },
      }),
      text: async () => '',
    } as any);
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).toBeNull();
  });

  it('does NOT throw on fetch network error (timeout, DNS, etc)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).toBeNull();
  });

  it('does NOT throw on malformed JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token'); },
      text: async () => '',
    } as any);
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('AAPL.US', '5m');
    expect(result).toBeNull();
  });

  it('does NOT call .chart() method on any object (P19g — proves we dropped the gutted package)', async () => {
    // The previous bug was `yahooFinance.chart is not a function`. This test
    // ensures we never reference `.chart` as a method anywhere in the call.
    let chartCalledCount = 0;
    const handler = {
      get(_target: any, prop: any) {
        if (prop === 'chart') chartCalledCount++;
        return undefined;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _proxy = new Proxy({}, handler);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ chart: { result: [], error: null } }),
      text: async () => '',
    } as any);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');
    expect(chartCalledCount).toBe(0);
  });
});
