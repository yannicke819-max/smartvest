/**
 * PR #343 — observability Binance WS, snapshot 5 min (Option C).
 *
 * Tests les helpers purs (`mapWsState`, `computeSilentFailureSuspected`,
 * `getOpenCryptoPositionsCount`) + le cron `logBinanceWsHealthSnapshot`
 * en vérifiant la structure JSON loguée, le reset du compteur, le flag
 * d activation, et le comportement fail-open Supabase.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RealtimePriceService } from '../realtime-price.service';
import { SupabaseService } from '../../../supabase/supabase.service';

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

function makeConfig(env: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

interface SupabaseStub {
  count?: number | null;
  error?: { message: string } | null;
  ready?: boolean;
}

function makeSupabase(stub: SupabaseStub = {}): SupabaseService {
  return {
    isReady: () => stub.ready ?? true,
    getClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => ({
              eq: () => Promise.resolve({ count: stub.count ?? 0, error: stub.error ?? null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseService;
}

function makeService(
  env: Record<string, string> = {},
  supabase: SupabaseService = makeSupabase(),
): RealtimePriceService {
  return new RealtimePriceService(supabase, makeConfig(env));
}

describe('RealtimePriceService — PR #343 observability', () => {
  beforeEach(() => {
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  describe('mapWsState', () => {
    const svc = makeService();
    it.each<[number | undefined | null, string]>([
      [0, 'CONNECTING'],
      [1, 'OPEN'],
      [2, 'CLOSING'],
      [3, 'CLOSED'],
      [undefined, 'NOT_INITIALIZED'],
      [null, 'NOT_INITIALIZED'],
      [99, 'UNKNOWN'],
    ])('readyState=%s → %s', (state, expected) => {
      expect(svc.mapWsState(state ?? undefined)).toBe(expected);
    });
  });

  describe('computeSilentFailureSuspected', () => {
    it('OPEN + symbols>0 + msg=0 → true', () => {
      expect(RealtimePriceService.computeSilentFailureSuspected('OPEN', 3, 0)).toBe(true);
    });
    it('OPEN + symbols>0 + msg>0 → false', () => {
      expect(RealtimePriceService.computeSilentFailureSuspected('OPEN', 3, 42)).toBe(false);
    });
    it('CLOSED → false (peu importe le reste)', () => {
      expect(RealtimePriceService.computeSilentFailureSuspected('CLOSED', 3, 0)).toBe(false);
    });
    it('symbols=0 → false (0 position crypto ouverte = WS volontairement fermé)', () => {
      expect(RealtimePriceService.computeSilentFailureSuspected('OPEN', 0, 0)).toBe(false);
    });
    it('NOT_INITIALIZED → false', () => {
      expect(RealtimePriceService.computeSilentFailureSuspected('NOT_INITIALIZED', 5, 0)).toBe(false);
    });
  });

  describe('getOpenCryptoPositionsCount', () => {
    it('succès → retourne le count', async () => {
      const svc = makeService({}, makeSupabase({ count: 2 }));
      expect(await svc.getOpenCryptoPositionsCount()).toBe(2);
    });

    it('Supabase not ready → null', async () => {
      const svc = makeService({}, makeSupabase({ ready: false }));
      expect(await svc.getOpenCryptoPositionsCount()).toBeNull();
    });

    it('Supabase error → null + warn log', async () => {
      const svc = makeService({}, makeSupabase({ error: { message: 'connection reset' } }));
      const result = await svc.getOpenCryptoPositionsCount();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('crypto positions query failed'));
    });

    it('count null Supabase → 0 (default conservateur)', async () => {
      const svc = makeService({}, makeSupabase({ count: null }));
      expect(await svc.getOpenCryptoPositionsCount()).toBe(0);
    });
  });

  describe('logBinanceWsHealthSnapshot — JSON structuré', () => {
    it('flag BINANCE_WS_HEALTH_LOG_ENABLED=false → early-return, aucun log', async () => {
      const svc = makeService({ BINANCE_WS_HEALTH_LOG_ENABLED: 'false' });
      await svc.logBinanceWsHealthSnapshot();
      const calls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[binance-ws-health]'));
      expect(calls).toHaveLength(0);
    });

    it('flag absent (default true) → log JSON produit', async () => {
      const svc = makeService();
      await svc.logBinanceWsHealthSnapshot();
      const calls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[binance-ws-health]'));
      expect(calls.length).toBeGreaterThan(0);
    });

    it('structure JSON complète et types corrects (WS non initialisé)', async () => {
      const svc = makeService({}, makeSupabase({ count: 0 }));
      await svc.logBinanceWsHealthSnapshot();
      const call = logSpy.mock.calls.find((c) => String(c[0]).includes('[binance-ws-health]'));
      expect(call).toBeDefined();
      const jsonPart = String(call![0]).replace('[binance-ws-health] ', '');
      const parsed = JSON.parse(jsonPart);
      expect(parsed).toMatchObject({
        event: 'binance_ws_health',
        ws_state: 'NOT_INITIALIZED',
        symbols_subscribed_count: 0,
        symbols_subscribed: [],
        msg_count_last_5min: 0,
        last_msg_age_seconds: null,
        open_crypto_positions: 0,
        silent_failure_suspected: false,
      });
      expect(typeof parsed.ts_utc).toBe('string');
      expect(parsed.ts_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('reset compteur 5min après snapshot', async () => {
      const svc = makeService();
      // Inject un compteur non-zéro via reflection.
      (svc as unknown as { msgCounter5min: number }).msgCounter5min = 17;
      await svc.logBinanceWsHealthSnapshot();
      expect((svc as unknown as { msgCounter5min: number }).msgCounter5min).toBe(0);
    });

    it('silent failure → warn additionnel', async () => {
      const svc = makeService();
      const internals = svc as unknown as {
        ws: { readyState: number };
        subscribedStreams: Set<string>;
        msgCounter5min: number;
      };
      internals.ws = { readyState: 1 }; // OPEN
      internals.subscribedStreams = new Set(['BTCUSDT', 'ETHUSDT']);
      internals.msgCounter5min = 0;

      await svc.logBinanceWsHealthSnapshot();

      const warn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('SILENT FAILURE SUSPECTED'),
      );
      expect(warn).toBeDefined();
    });

    it('msg_count > 0 → pas de warn silent failure', async () => {
      const svc = makeService();
      const internals = svc as unknown as {
        ws: { readyState: number };
        subscribedStreams: Set<string>;
        msgCounter5min: number;
        lastMsgTs: number | null;
      };
      internals.ws = { readyState: 1 };
      internals.subscribedStreams = new Set(['BTCUSDT']);
      internals.msgCounter5min = 42;
      internals.lastMsgTs = Date.now() - 1000;

      await svc.logBinanceWsHealthSnapshot();

      const warn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('SILENT FAILURE SUSPECTED'),
      );
      expect(warn).toBeUndefined();
    });

    it('last_msg_age_seconds calculé quand lastMsgTs présent', async () => {
      const svc = makeService();
      const internals = svc as unknown as { lastMsgTs: number | null };
      internals.lastMsgTs = Date.now() - 30_000; // 30 s ago

      await svc.logBinanceWsHealthSnapshot();
      const call = logSpy.mock.calls.find((c) => String(c[0]).includes('[binance-ws-health]'));
      const jsonPart = String(call![0]).replace('[binance-ws-health] ', '');
      const parsed = JSON.parse(jsonPart);
      expect(parsed.last_msg_age_seconds).toBeGreaterThan(25);
      expect(parsed.last_msg_age_seconds).toBeLessThan(35);
    });
  });
});
