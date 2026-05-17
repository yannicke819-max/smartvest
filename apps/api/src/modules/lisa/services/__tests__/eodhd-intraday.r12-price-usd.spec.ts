/**
 * Bug #R12 — Test that EodhdIntradayService.logCall records `price_usd`.
 *
 * Pre-R12 prod state (16/05/2026) : 180 751 intraday calls / 14 jours, 0 %
 * `price_usd` non-null. Cause : the `logCall` payload omitted `price_usd`
 * AND the success log was emitted BEFORE the response was parsed.
 *
 * Fix verified ici :
 *   - non-empty response → INSERT row with `price_usd` = dernière candle close
 *   - empty response (HTTP 200, []) → row with `price_usd` = null, success=true
 *   - HTTP 404 → row with `price_usd` = null, success=false
 *   - ticks endpoint (`getCandlesViaTicks`) idem (dernière tick price)
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdIntradayService } from '../eodhd-intraday.service';
import { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function makeServiceWithCapture() {
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'EODHD_API_KEY') return 'test-key';
      if (k === 'EODHD_WEEKEND_FILTER_ENABLED') return 'false';
      return undefined;
    }),
  } as unknown as ConfigService;
  const inserted: Array<Record<string, unknown>> = [];
  const insertMock = jest.fn().mockImplementation((row: Record<string, unknown>) => {
    inserted.push(row);
    return Promise.resolve({ error: null });
  });
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: insertMock }) }),
  } as unknown as SupabaseService;
  return { svc: new EodhdIntradayService(config, supabase), inserted };
}

async function flushAsync() {
  // fire-and-forget log uses Promise microtask — flush twice to be safe
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('Bug #R12 — EodhdIntradayService logs price_usd', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('getCandles success → INSERT row carries price_usd = last close', async () => {
    const { svc, inserted } = makeServiceWithCapture();
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
        { timestamp: 1_700_000_300, open: 100.5, high: 102, low: 100, close: 101.75, volume: 1500 },
      ],
      text: async () => '',
    });

    const res = await svc.getCandles('AAPL.US', '5m', 20);
    await flushAsync();

    expect(res).not.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      called_by: 'intraday',
      success: true,
      status_code: 200,
      price_usd: 101.75,
    });
  });

  it('getCandles empty response → INSERT row with price_usd=null + success=true', async () => {
    const { svc, inserted } = makeServiceWithCapture();
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '[]',
    });

    const res = await svc.getCandles('AAPL.US', '5m');
    await flushAsync();

    expect(res).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      called_by: 'intraday',
      success: true,
      status_code: 200,
      price_usd: null,
    });
  });

  it('getCandles HTTP 404 → INSERT row with price_usd=null + success=false', async () => {
    const { svc, inserted } = makeServiceWithCapture();
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => null,
      text: async () => 'Not Found',
    });

    const res = await svc.getCandles('FAKE.US', '5m');
    await flushAsync();

    expect(res).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      called_by: 'intraday',
      success: false,
      status_code: 404,
      price_usd: null,
    });
  });

  it('getCandlesViaTicks success → INSERT row carries price_usd = last tick price', async () => {
    const { svc, inserted } = makeServiceWithCapture();
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1_700_000_000_000, price: 100.5, volume: 100, seq: 1 },
        { timestamp: 1_700_000_000_100, price: 101.25, volume: 200, seq: 2 },
      ],
      text: async () => '',
    });

    const fromTs = Math.floor(Date.now() / 1000) - 3600;
    const toTs = Math.floor(Date.now() / 1000);
    const res = await svc.getCandlesViaTicks('AAPL.US', '5m', 5, { fromTs, toTs });
    await flushAsync();

    expect(res).not.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      called_by: 'intraday',
      success: true,
      status_code: 200,
      price_usd: 101.25,
    });
  });

  it('getCandles only-zero-close candles (e.g. Asia pre-market) → price_usd=null', async () => {
    const { svc, inserted } = makeServiceWithCapture();
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1_700_000_000, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      ],
      text: async () => '',
    });

    const res = await svc.getCandles('AAPL.US', '5m');
    await flushAsync();

    // data[] non-empty so logCall fires, but all candles filtered → no last close
    expect(res?.candles).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      called_by: 'intraday',
      success: true,
      status_code: 200,
      price_usd: null,
    });
  });
});
