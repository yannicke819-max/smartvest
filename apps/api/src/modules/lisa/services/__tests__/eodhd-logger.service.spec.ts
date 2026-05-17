/**
 * PR #344 P1 — tests EodhdLoggerService.
 *
 * Couvre :
 *   - log() insert succès dans eodhd_request_log avec tous les champs
 *   - log() insert path d'erreur (extras propagés)
 *   - log() supabase not ready → no-op silencieux
 *   - log() error Supabase → warn local, jamais throw
 *   - estimateCredits() barème par endpoint
 */

import { Logger } from '@nestjs/common';
import { EodhdLoggerService } from '../eodhd-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

interface InsertCapture {
  payloads: Array<Record<string, unknown>>;
}

function makeSupabase(opts: {
  ready?: boolean;
  error?: { message: string } | null;
  capture?: InsertCapture;
} = {}): SupabaseService {
  return {
    isReady: () => opts.ready ?? true,
    getClient: () => ({
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          if (opts.capture) opts.capture.payloads.push(payload);
          return Promise.resolve({ error: opts.error ?? null });
        },
      }),
    }),
  } as unknown as SupabaseService;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('EodhdLoggerService — PR #344 P1', () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  describe('log() — succès path', () => {
    it('insert dans eodhd_request_log avec tous les champs', async () => {
      const capture: InsertCapture = { payloads: [] };
      const svc = new EodhdLoggerService(makeSupabase({ capture }));
      svc.log({
        ticker: 'gainers_screener_US',
        eodhdTicker: 'gainers_screener_US',
        source: 'eodhd',
        success: true,
        statusCode: 200,
        latencyMs: 234,
        calledBy: 'gainers_screener',
        endpoint: 'screener',
        extras: { n_symbols_returned: 42, credits_estimes: 47, exchange: 'US' },
      });
      await flush();
      expect(capture.payloads).toHaveLength(1);
      expect(capture.payloads[0]).toMatchObject({
        ticker: 'gainers_screener_US',
        called_by: 'gainers_screener',
        endpoint: 'screener',
        success: true,
        status_code: 200,
        latency_ms: 234,
      });
      expect((capture.payloads[0].extras as Record<string, unknown>).credits_estimes).toBe(47);
    });
  });

  describe('log() — error path', () => {
    it('insert success=false + errorMessage + extras', async () => {
      const capture: InsertCapture = { payloads: [] };
      const svc = new EodhdLoggerService(makeSupabase({ capture }));
      svc.log({
        ticker: 'screener_oversold_quality',
        source: 'eodhd',
        success: false,
        statusCode: 422,
        latencyMs: 123,
        calledBy: 'screener',
        endpoint: 'screener',
        extras: { preset: 'oversold_quality', credits_estimes: 5 },
        errorMessage: 'HTTP_422 · filter unsupported',
      });
      await flush();
      expect(capture.payloads).toHaveLength(1);
      expect(capture.payloads[0]).toMatchObject({
        success: false,
        status_code: 422,
        error_message: 'HTTP_422 · filter unsupported',
        called_by: 'screener',
        endpoint: 'screener',
      });
    });
  });

  describe('log() — fail-open', () => {
    it('Supabase not ready → no-op silencieux (pas d insert)', async () => {
      const capture: InsertCapture = { payloads: [] };
      const svc = new EodhdLoggerService(makeSupabase({ ready: false, capture }));
      svc.log({ ticker: 'AAPL.US', success: true, calledBy: 'screener' });
      await flush();
      expect(capture.payloads).toHaveLength(0);
    });

    it('Supabase erreur insert → warn local, pas de throw', async () => {
      const capture: InsertCapture = { payloads: [] };
      const svc = new EodhdLoggerService(
        makeSupabase({ error: { message: 'connection reset' }, capture }),
      );
      svc.log({ ticker: 'AAPL.US', success: true, calledBy: 'screener' });
      await flush();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    });
  });

  describe('estimateCredits — barème par endpoint', () => {
    it.each<[string, Record<string, unknown> | undefined, number]>([
      ['screener', { n_symbols_returned: 42 }, 47], // 5 + 42
      ['screener', { n_symbols_returned: 0 }, 5], // 5 + 0
      ['screener', undefined, 5], // 5 + 0 (default)
      ['intraday', undefined, 5],
      ['technical', undefined, 5],
      ['insider', undefined, 10],
      ['options', undefined, 10],
      ['real-time', undefined, 1],
      ['eod', undefined, 1],
      ['exchange-hours', undefined, 1],
      ['unknown_endpoint', undefined, 1], // default conservateur
    ])('endpoint=%s extras=%o → %d credits', (endpoint, extras, expected) => {
      expect(EodhdLoggerService.estimateCredits(endpoint, extras)).toBe(expected);
    });

    it('extras.n_symbols_returned NaN → 5 + 0', () => {
      expect(
        EodhdLoggerService.estimateCredits('screener', { n_symbols_returned: 'invalid' }),
      ).toBe(5);
    });
  });
});
