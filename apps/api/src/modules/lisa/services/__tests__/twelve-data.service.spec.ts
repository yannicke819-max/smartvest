/**
 * PR #342 POC — tests TwelveDataService.
 *
 * Couverture cible : 85%+. Vise les chemins critiques :
 *   - boot sans clé (defensive, return null)
 *   - happy path supertrend / RSI / ATR
 *   - rate-limit minute (8e appel skip)
 *   - rate-limit jour (>= 750 → skip)
 *   - HTTP 429 retry puis null
 *   - HTTP 5xx retry puis null
 *   - réponse code 404 "Pro plan" → log error explicite
 *   - parsing valeurs invalides → null
 *   - mapping crypto Binance → TwelveData
 *
 * Pattern : mock global.fetch, ConfigService minimal, SupabaseService no-op.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwelveDataService } from '../twelve-data.service';
import { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

function makeService(env: Record<string, string> = { TWELVEDATA_API_KEY: 'test-key' }): TwelveDataService {
  const config = { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService;
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }) }),
  } as unknown as SupabaseService;
  return new TwelveDataService(config, supabase);
}

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }): jest.Mock {
  const mockFn = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: response.json ?? (() => Promise.resolve({})),
  });
  (global as { fetch?: unknown }).fetch = mockFn;
  return mockFn;
}

describe('TwelveDataService — PR #342 POC', () => {
  beforeEach(() => {
    errorSpy.mockClear();
  });

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  describe('boot defensive', () => {
    it('clé manquante → toutes les méthodes retournent null sans appel HTTP', async () => {
      const svc = makeService({});
      const fetchSpy = jest.fn();
      (global as { fetch?: unknown }).fetch = fetchSpy;

      expect(await svc.getSupertrendSignal('AAPL')).toBeNull();
      expect(await svc.getRsi('BTC/USD')).toBeNull();
      expect(await svc.getAtr('AAPL')).toBeNull();
      expect(await svc.getApiUsage()).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('clé vide → return null', async () => {
      const svc = makeService({ TWELVEDATA_API_KEY: '   ' });
      expect(await svc.getRsi('BTC/USD')).toBeNull();
    });
  });

  describe('getSupertrendSignal — happy path + parsing', () => {
    it('parse direction=up correctement', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [{ datetime: '2026-05-17 10:00:00', supertrend: '180.50', supertrend_direction: '1' }],
        }),
      });
      const svc = makeService();
      const r = await svc.getSupertrendSignal('AAPL', '30min');
      expect(r).toEqual({
        value: 180.5,
        direction: 'up',
        timestamp: '2026-05-17 10:00:00',
      });
    });

    it('parse direction=down correctement', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({
          values: [{ datetime: '2026-05-17 10:00:00', supertrend: '180.50', supertrend_direction: '-1' }],
        }),
      });
      const svc = makeService();
      const r = await svc.getSupertrendSignal('AAPL', '30min');
      expect(r?.direction).toBe('down');
    });

    it('values vide → null', async () => {
      mockFetchOnce({ ok: true, status: 200, json: async () => ({ values: [] }) });
      const svc = makeService();
      expect(await svc.getSupertrendSignal('AAPL')).toBeNull();
    });

    it('direction invalide → null', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ supertrend: '180', supertrend_direction: 'garbage' }] }),
      });
      const svc = makeService();
      expect(await svc.getSupertrendSignal('AAPL')).toBeNull();
    });
  });

  describe('getRsi — happy path', () => {
    it('parse RSI overbought (>75)', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ datetime: '2026-05-17 10:00', rsi: '82.34' }] }),
      });
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD', '5min');
      expect(r?.value).toBeCloseTo(82.34);
    });

    it('parse RSI oversold (<25)', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ rsi: '18.5' }] }),
      });
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r?.value).toBe(18.5);
    });

    it('rsi non-numérique → null', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ rsi: 'NaN' }] }),
      });
      const svc = makeService();
      expect(await svc.getRsi('BTC/USD')).toBeNull();
    });
  });

  describe('getAtr — happy path', () => {
    it('parse ATR value', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ atr: '1.23' }] }),
      });
      const svc = makeService();
      const r = await svc.getAtr('AAPL');
      expect(r?.value).toBe(1.23);
    });
  });

  describe('rate limit minute (7 credits/min)', () => {
    it('8e appel consécutif → null sans HTTP', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ rsi: '50' }] }),
      });
      (global as { fetch?: unknown }).fetch = fetchMock;

      const svc = makeService();
      for (let i = 0; i < 7; i++) {
        const r = await svc.getRsi('BTC/USD');
        expect(r).not.toBeNull();
      }
      expect(fetchMock).toHaveBeenCalledTimes(7);

      // 8e appel doit être bloqué par CreditTracker
      const blocked = await svc.getRsi('BTC/USD');
      expect(blocked).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(7); // pas de 8e HTTP
    });
  });

  describe('rate limit jour (750 credits/jour)', () => {
    it('au-delà de 750 daily_usage → null silencieux', async () => {
      const svc = makeService();
      // Force le tracker à 750 via 750 appels mockés successifs serait trop lent ;
      // on accède au tracker via reflection minimale.
      type Internals = { creditTracker: { consume: (n: number) => void } };
      (svc as unknown as Internals).creditTracker.consume(750);

      const fetchMock = jest.fn();
      (global as { fetch?: unknown }).fetch = fetchMock;
      const r = await svc.getRsi('BTC/USD');
      expect(r).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('HTTP errors with retry', () => {
    it('429 puis 200 → succès au 2e essai', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [{ rsi: '55' }] }),
        });
      (global as { fetch?: unknown }).fetch = fetchMock;

      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r?.value).toBe(55);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 15_000);

    it('429 deux fois → null', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
      (global as { fetch?: unknown }).fetch = fetchMock;
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 20_000);

    it('500 puis 200 → succès au 2e essai', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ values: [{ rsi: '50' }] }),
        });
      (global as { fetch?: unknown }).fetch = fetchMock;
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r?.value).toBe(50);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('400 → null sans retry (4xx non-429)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
      (global as { fetch?: unknown }).fetch = fetchMock;
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('réponse code 404 "Pro plan"', () => {
    it('log error explicite "plan upgrade required"', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 404, message: 'Symbol AAPL.US is not available with your current plan. Please upgrade to Pro plan.' }),
      });
      const svc = makeService();
      const r = await svc.getSupertrendSignal('AAPL.US');
      expect(r).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('plan upgrade required for symbol AAPL.US'),
      );
    });

    it('autre code != 200 → warn + null sans crash', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 400, message: 'parameter time_period missing' }),
      });
      const svc = makeService();
      const r = await svc.getRsi('BTC/USD');
      expect(r).toBeNull();
    });
  });

  describe('getApiUsage', () => {
    it('parse api_usage correctly', async () => {
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({
          current_usage: 42,
          plan_limit: 8,
          daily_usage: 142,
          plan_daily_limit: 800,
          plan_category: 'Basic',
        }),
      });
      const svc = makeService();
      const r = await svc.getApiUsage();
      expect(r).toEqual({
        currentUsage: 42,
        planLimit: 8,
        dailyUsage: 142,
        planDailyLimit: 800,
        planCategory: 'Basic',
      });
    });

    it('HTTP error → null', async () => {
      mockFetchOnce({ ok: false, status: 500, json: async () => ({}) });
      const svc = makeService();
      expect(await svc.getApiUsage()).toBeNull();
    });
  });

  describe('binanceToTwelveDataCrypto helper', () => {
    it.each<[string, string | null]>([
      ['POLUSDT', 'POL/USD'],
      ['BTCUSDT', 'BTC/USD'],
      ['ETHUSDC', 'ETH/USD'],
      ['BNBBUSD', 'BNB/USD'],
      ['SOLUSD', 'SOL/USD'],
      ['INVALID', null],
      ['', null],
    ])('%s → %s', (input, expected) => {
      expect(TwelveDataService.binanceToTwelveDataCrypto(input)).toBe(expected);
    });
  });

  describe('credit tracking exposition', () => {
    it('getDailyUsage reflète les consume', async () => {
      const svc = makeService();
      mockFetchOnce({
        ok: true,
        status: 200,
        json: async () => ({ values: [{ rsi: '50' }] }),
      });
      expect(svc.getDailyUsage()).toBe(0);
      await svc.getRsi('BTC/USD');
      expect(svc.getDailyUsage()).toBe(1);
    });
  });
});
