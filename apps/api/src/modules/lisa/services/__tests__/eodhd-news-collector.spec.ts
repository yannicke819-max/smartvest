/**
 * FIX 23/05/2026 — news collector universe : la colonne s'appelle `tickers`
 * (text[]), PAS `symbol`. Avant fix : query 404 → fallback crypto only (10
 * tickers) au lieu de 80+ tickers equity.
 */

import { Logger } from '@nestjs/common';
import { EodhdNewsCollectorService } from '../eodhd-news-collector.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function makeSupabase(rows: Array<{ tickers?: string[] | null }> | null) {
  return {
    isReady: () => rows !== null,
    getClient: () => ({
      from: () => ({
        select: () => ({
          limit: async () => ({
            data: rows,
            error: rows === null ? { message: 'forced err' } : null,
          }),
        }),
      }),
    }),
  } as any;
}

function makeNewsService(fetched: string[]) {
  return {
    isEnabled: () => true,
    fetchAndPersistOne: async (t: string) => { fetched.push(t); return 1; },
  } as any;
}

describe('EodhdNewsCollectorService — fetchActiveUniverse fix', () => {
  it('flatten le text[] de watchlist_universe + crypto majors en tête', async () => {
    const sb = makeSupabase([
      { tickers: ['AAPL.US', 'MSFT.US', 'NVDA.US'] },
      { tickers: ['BARC.LSE', 'HSBA.LSE'] },
      { tickers: ['005930.KO', '7203.T'] },
    ]);
    const fetched: string[] = [];
    const svc = new EodhdNewsCollectorService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE: '20' }),
      sb, makeNewsService(fetched),
    );
    await svc.runCollectCycle();
    // Crypto 10 en tête + 7 equity = 17 tickers (capped à 20)
    expect(fetched.length).toBe(17);
    // Crypto majors en tête
    expect(fetched[0]).toBe('BTCUSDT');
    expect(fetched[9]).toBe('POLUSDT');
    // Puis equity dans l'ordre
    expect(fetched.slice(10)).toEqual(['AAPL.US', 'MSFT.US', 'NVDA.US', 'BARC.LSE', 'HSBA.LSE', '005930.KO', '7203.T']);
  });

  it('dedupe les tickers présents dans plusieurs watchlists', async () => {
    const sb = makeSupabase([
      { tickers: ['AAPL.US', 'MSFT.US'] },
      { tickers: ['AAPL.US', 'GOOGL.US'] }, // AAPL en double
    ]);
    const fetched: string[] = [];
    const svc = new EodhdNewsCollectorService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE: '50' }),
      sb, makeNewsService(fetched),
    );
    await svc.runCollectCycle();
    // 10 crypto + 3 equity dédupliqués = 13
    expect(fetched.length).toBe(13);
    const equityOnly = fetched.slice(10);
    expect(equityOnly).toEqual(['AAPL.US', 'MSFT.US', 'GOOGL.US']);
  });

  it('cap à maxPerCycle préservé', async () => {
    const manyTickers = Array.from({ length: 200 }, (_, i) => `TICK${i}.US`);
    const sb = makeSupabase([{ tickers: manyTickers }]);
    const fetched: string[] = [];
    const svc = new EodhdNewsCollectorService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE: '50' }),
      sb, makeNewsService(fetched),
    );
    await svc.runCollectCycle();
    expect(fetched.length).toBe(50);
  });

  it('DB indispo (rows null) → fallback crypto majors only (10 tickers, pas de crash)', async () => {
    const sb = makeSupabase(null);
    const fetched: string[] = [];
    const svc = new EodhdNewsCollectorService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE: '50' }),
      sb, makeNewsService(fetched),
    );
    await svc.runCollectCycle();
    expect(fetched.length).toBe(10);
    expect(fetched[0]).toBe('BTCUSDT');
  });

  it('tickers vides ou null dans la row → skip silencieux', async () => {
    const sb = makeSupabase([{ tickers: null }, { tickers: [] }, { tickers: ['VALID.US'] }]);
    const fetched: string[] = [];
    const svc = new EodhdNewsCollectorService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE: '50' }),
      sb, makeNewsService(fetched),
    );
    await svc.runCollectCycle();
    // 10 crypto + 1 valid = 11
    expect(fetched.length).toBe(11);
    expect(fetched.slice(10)).toEqual(['VALID.US']);
  });
});
