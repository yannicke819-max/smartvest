/**
 * PR #344 P1 — tests EodhdScreenerService instrumentation.
 *
 * Vérifie que EodhdScreenerService.runScan() délègue au EodhdLoggerService
 * partagé avec endpoint='screener' + extras (preset, n_symbols_returned,
 * credits_estimes). Success + error paths.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdScreenerService } from '../eodhd-screener.service';
import { EodhdLoggerService } from '../eodhd-logger.service';
import type { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function makeLogger(): EodhdLoggerService & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const stub = {
    log: (entry: Record<string, unknown>) => calls.push(entry),
    calls,
  };
  return stub as unknown as EodhdLoggerService & { calls: Array<Record<string, unknown>> };
}

function makeService(loggerStub: EodhdLoggerService): EodhdScreenerService {
  const config = {
    get: jest.fn((k: string) => (k === 'EODHD_API_KEY' ? 'test-key' : undefined)),
  } as unknown as ConfigService;
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }) }),
  } as unknown as SupabaseService;
  return new EodhdScreenerService(config, supabase, loggerStub);
}

describe('EodhdScreenerService — PR #344 P1 instrumentation', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('runScan success → log avec endpoint=screener + extras.preset + n_symbols_returned + credits_estimes', async () => {
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: 10 }, (_, i) => ({
          code: `TEST${i}`,
          exchange: 'US',
          name: `Test ${i}`,
          market_capitalization: 50_000_000_000,
        })),
      }),
    });

    const logger = makeLogger();
    const svc = makeService(logger);
    const results = await svc.runScan('oversold_quality', 10);

    expect(results).toHaveLength(10);
    const calls = (logger as unknown as { calls: Array<Record<string, unknown>> }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      calledBy: 'screener',
      endpoint: 'screener',
      success: true,
      statusCode: 200,
    });
    const extras = calls[0].extras as Record<string, unknown>;
    expect(extras.preset).toBe('oversold_quality');
    expect(extras.n_symbols_returned).toBe(10);
    expect(extras.credits_estimes).toBe(15); // 5 + 10
  });

  it('runScan HTTP 422 → log success=false + statusCode=422 + errorMessage', async () => {
    (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"errors": "filter unsupported"}',
    });

    const logger = makeLogger();
    const svc = makeService(logger);
    const results = await svc.runScan('momentum_mid_cap', 5);

    expect(results).toHaveLength(0);
    const calls = (logger as unknown as { calls: Array<Record<string, unknown>> }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      calledBy: 'screener',
      endpoint: 'screener',
      success: false,
      statusCode: 422,
    });
    expect(String(calls[0].errorMessage)).toContain('HTTP_422');
  });

  it('runScan fetch exception → log success=false + errorMessage', async () => {
    (global as { fetch?: unknown }).fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const logger = makeLogger();
    const svc = makeService(logger);
    const results = await svc.runScan('volume_anomaly', 5);

    expect(results).toHaveLength(0);
    const calls = (logger as unknown as { calls: Array<Record<string, unknown>> }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      calledBy: 'screener',
      endpoint: 'screener',
      success: false,
    });
    expect(String(calls[0].errorMessage)).toContain('network down');
  });
});
