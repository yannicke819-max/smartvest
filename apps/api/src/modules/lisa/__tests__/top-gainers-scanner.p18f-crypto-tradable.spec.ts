/**
 * P18f — Tests pour le concept `crypto_tradable` (whitelist opt-in).
 *
 * Comportement attendu (option b "skip + log") :
 *   - whitelist VIDE / non-définie → toutes les crypto sont tradables
 *     (back-compat, pas de restriction sur le path d'open)
 *   - whitelist SET (ex `BTCUSDT,ETHUSDT`) → seuls ces symboles passent ;
 *     les autres sont skippés silencieusement avec log INFO + counter
 */

import { Logger } from '@nestjs/common';
import { TopGainersScannerService } from '../services/top-gainers-scanner.service';

const supabaseFromMock = jest.fn();
const mockSupabase = { getClient: () => ({ from: supabaseFromMock }) } as any;
const mockLisa = {} as any;
const mockDecisionLog = {} as any;
const mockConfig = { get: jest.fn() } as any;
const mockBinance = { getTicker24h: jest.fn().mockResolvedValue(null) } as any;
const mockScheduler = {
  getCronJob: jest.fn().mockImplementation(() => { throw new Error('not found'); }),
  addCronJob: jest.fn(),
} as any;
const mockMtf = {} as any;
const mockLlmRouter = { isEnabled: jest.fn().mockReturnValue(false), call: jest.fn() } as any;

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

function makeService(envMap: Record<string, string | undefined> = {}): TopGainersScannerService {
  mockConfig.get.mockImplementation((key: string) => {
    if (key === 'SCAN_INTERVAL_MINUTES') return '15';
    return envMap[key];
  });
  return new TopGainersScannerService(
    mockSupabase, mockLisa, mockDecisionLog, mockConfig, mockBinance, mockScheduler, mockMtf, mockLlmRouter, { isShadowEnabled: () => false } as any, { evaluate: () => ({ raw: {} as any, compositeScore: null, decision: "REJECT", rejectReason: null, spreadProxy: null, spreadProxySource: null, trendFilter: null, rvolIntraday: null }) } as any, { enrich: (i: any) => i.candidate } as any, { evaluate: (i: any) => i.candidate } as any, { getCandles: () => Promise.resolve(null) } as any,
  );
}

describe('isCryptoTradable — P18f whitelist gate', () => {
  it('returns true for ALL symbols when whitelist env var is unset (back-compat)', () => {
    const svc = makeService({});
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
    expect(svc.isCryptoTradable('ETHUSDT')).toBe(true);
    expect(svc.isCryptoTradable('DOGEUSDT')).toBe(true);
    expect(svc.isCryptoTradable('SHIBUSDT')).toBe(true);
  });

  it('returns true for ALL symbols when whitelist env var is empty string', () => {
    const svc = makeService({ CRYPTO_TRADABLE_WHITELIST: '' });
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
    expect(svc.isCryptoTradable('DOGEUSDT')).toBe(true);
  });

  it('returns true for ALL symbols when whitelist env var is whitespace-only', () => {
    const svc = makeService({ CRYPTO_TRADABLE_WHITELIST: '   ' });
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
  });

  it('returns true ONLY for whitelisted symbols when whitelist is set', () => {
    const svc = makeService({ CRYPTO_TRADABLE_WHITELIST: 'BTCUSDT,ETHUSDT' });
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
    expect(svc.isCryptoTradable('ETHUSDT')).toBe(true);
    // NOT in whitelist
    expect(svc.isCryptoTradable('SOLUSDT')).toBe(false);
    expect(svc.isCryptoTradable('DOGEUSDT')).toBe(false);
    expect(svc.isCryptoTradable('SHIBUSDT')).toBe(false);
  });

  it('whitelist match is case-insensitive', () => {
    const svc = makeService({ CRYPTO_TRADABLE_WHITELIST: 'btcusdt,EthUsdt' });
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
    expect(svc.isCryptoTradable('ETHUSDT')).toBe(true);
    expect(svc.isCryptoTradable('btcusdt')).toBe(true);  // lowercase input also passes
  });

  it('handles whitespace around CSV entries', () => {
    const svc = makeService({ CRYPTO_TRADABLE_WHITELIST: '  BTCUSDT  ,  ETHUSDT  ,SOLUSDT' });
    expect(svc.isCryptoTradable('BTCUSDT')).toBe(true);
    expect(svc.isCryptoTradable('ETHUSDT')).toBe(true);
    expect(svc.isCryptoTradable('SOLUSDT')).toBe(true);
    expect(svc.isCryptoTradable('DOGEUSDT')).toBe(false);
  });

  it('counter starts at 0', () => {
    const svc = makeService({});
    expect(svc.getSkippedNotCryptoTradableCounter()).toBe(0);
  });
});
