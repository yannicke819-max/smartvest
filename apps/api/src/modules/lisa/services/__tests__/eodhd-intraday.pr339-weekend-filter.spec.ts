/**
 * PR #339 — Weekend / session-closed filter sur EodhdIntradayService.getCandles.
 *
 * Avant ce fix : 5242 calls intraday asia en 12h weekend (samedi 21h UTC →
 * dimanche 06h UTC), 100 % empty_real, ~26k API calls EODHD gaspillés.
 *
 * Le pré-filtre `filterTickersForFetch` existant n'est appliqué que par
 * `top-gainers-scanner`. 6 autres callers (shadow-signals, multi-tf,
 * lisa.service, etc.) bypassent ce filtre. Le fix à la couche basse
 * (getCandles) les protège tous d'un coup.
 *
 * Comportement attendu :
 *   - .KO / .KQ (asia) un weekend → skip silencieux, fetch jamais appelé
 *   - .US un weekend → skip silencieux
 *   - .CC crypto un weekend → fetch normal (24/7)
 *   - kill-switch EODHD_WEEKEND_FILTER_ENABLED=false → fetch normal
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdIntradayService } from '../eodhd-intraday.service';
import { SupabaseService } from '../../../supabase/supabase.service';

// Silence boot logs.
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function makeService(env: Record<string, string> = {}): EodhdIntradayService {
  const config = {
    get: jest.fn((k: string) => env[k]),
  } as unknown as ConfigService;
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }) }),
  } as unknown as SupabaseService;
  return new EodhdIntradayService(config, supabase);
}

describe('PR #339 — weekend / session filter early-return', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
    jest.useRealTimers();
  });

  it('skip fetch un dimanche pour ticker .KO (asia closed weekend)', async () => {
    // Dimanche 17 mai 2026 06:00 UTC (Korea fermé)
    jest.useFakeTimers().setSystemTime(new Date('2026-05-17T06:00:00Z'));
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({ EODHD_API_KEY: 'real-key' });
    const result = await service.getCandles('005930.KO', '5m', 20);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skip fetch un samedi pour ticker .US (us closed weekend)', async () => {
    // Samedi 16 mai 2026 18:00 UTC (US fermé)
    jest.useFakeTimers().setSystemTime(new Date('2026-05-16T18:00:00Z'));
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({ EODHD_API_KEY: 'real-key' });
    const result = await service.getCandles('AAPL.US', '5m', 20);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skip fetch un samedi pour ticker .KQ (kosdaq closed weekend)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-16T03:00:00Z'));
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({ EODHD_API_KEY: 'real-key' });
    const result = await service.getCandles('222420.KQ', '5m', 20);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('autorise fetch crypto le weekend (24/7)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-17T06:00:00Z')); // dimanche
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { timestamp: 1715900000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 100 },
      ],
    });
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({ EODHD_API_KEY: 'real-key' });
    const result = await service.getCandles('BTC-USD.CC', '5m', 20);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it('respecte EODHD_WEEKEND_FILTER_ENABLED=false (kill-switch)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-17T06:00:00Z')); // dimanche
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({
      EODHD_API_KEY: 'real-key',
      EODHD_WEEKEND_FILTER_ENABLED: 'false',
    });
    await service.getCandles('005930.KO', '5m', 20);

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('autorise fetch un mardi pour ticker .KO en pleine session', async () => {
    // Mardi 19 mai 2026 02:00 UTC = 11:00 KST (KOSPI 09:00-15:30 KST)
    jest.useFakeTimers().setSystemTime(new Date('2026-05-19T02:00:00Z'));
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    (global as { fetch?: unknown }).fetch = fetchSpy;

    const service = makeService({ EODHD_API_KEY: 'real-key' });
    await service.getCandles('005930.KO', '5m', 20);

    expect(fetchSpy).toHaveBeenCalled();
  });
});
