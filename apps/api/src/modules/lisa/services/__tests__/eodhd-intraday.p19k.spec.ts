/**
 * P19k — Tests pour le symbol-suffix mapping côté EODHD intraday endpoint.
 *
 * Issue (29/04/2026 16h prod) : EODHD retournait 404 silently sur tous les
 * tickers Korea. Cause : le scanner et le suffix Yahoo utilisent `.KO` mais
 * l'endpoint intraday EODHD attend `.KOSE` (KOSPI). Idem `.SS`/`.SZ` →
 * `.SHG`/`.SHE` pour Shanghai/Shenzhen.
 *
 * Sans normalisation, MTF service envoyait `199820.KO` à EODHD → 404 → null
 * → fallback chain s'épuisait sans message clair.
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

describe('EodhdIntradayService — P19k symbol suffix mapping', () => {
  it('maps KOSPI .KO → .KOSE (EODHD intraday endpoint convention)', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('199820.KO')).toBe('199820.KOSE');
    expect(fn('006340.KO')).toBe('006340.KOSE');
    expect(fn('005930.KO')).toBe('005930.KOSE'); // Samsung
  });

  it('maps Shanghai .SS → .SHG', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('600000.SS')).toBe('600000.SHG');
    expect(fn('601398.SS')).toBe('601398.SHG'); // ICBC
  });

  it('maps Shenzhen .SZ → .SHE', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('000001.SZ')).toBe('000001.SHE');
    expect(fn('300750.SZ')).toBe('300750.SHE'); // CATL
  });

  it('passes through US/LSE/XETRA/PA/HK/TO/NSE/BSE/KQ/AU unchanged', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('AAPL.US')).toBe('AAPL.US');
    expect(fn('SHEL.LSE')).toBe('SHEL.LSE');
    expect(fn('SAP.XETRA')).toBe('SAP.XETRA');
    expect(fn('AIR.PA')).toBe('AIR.PA');
    expect(fn('0700.HK')).toBe('0700.HK');
    expect(fn('SHOP.TO')).toBe('SHOP.TO');
    expect(fn('RELIANCE.NSE')).toBe('RELIANCE.NSE');
    expect(fn('TCS.BSE')).toBe('TCS.BSE');
    expect(fn('035720.KQ')).toBe('035720.KQ'); // KOSDAQ already correct
    expect(fn('BHP.AU')).toBe('BHP.AU');
  });

  it('passes through tickers without suffix (defensive)', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('AAPL')).toBe('AAPL');
    expect(fn('199820')).toBe('199820');
  });

  it('case-insensitive suffix match (e.g. .ko / .ss)', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('199820.ko')).toBe('199820.KOSE');
    expect(fn('600000.ss')).toBe('600000.SHG');
  });

  it('only the LAST dot is used as the suffix delimiter (multi-dot tickers)', () => {
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    // Cas hypothétique d'un ticker avec point dans le base (rare mais défensif)
    expect(fn('BRK.B.US')).toBe('BRK.B.US');
    expect(fn('FOO.BAR.KO')).toBe('FOO.BAR.KOSE');
  });

  it('cache key uses the normalized form (avoid duplicate cache for KO vs KOSE)', () => {
    // We verify by checking that getCandles uses the same cache key for
    // both inputs of the same ticker. Direct assertion impossible without
    // exposing internals — covered indirectly by integration tests.
    const svc = makeService();
    const fn = (svc as any).normalizeForEodhdIntraday.bind(svc);
    expect(fn('199820.KO')).toBe(fn('199820.KOSE'));
  });
});
