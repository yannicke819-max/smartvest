/**
 * Phase C — Cache ATR par symbole.
 * Test du compute ATR pur + flow refresh + lecture cache.
 */

import { Logger } from '@nestjs/common';
import { SymbolAtrCacheService } from '../symbol-atr-cache.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function makeSupabase(opts: { ready?: boolean; atrRow?: { atr_ratio_pct: number; computed_at: string } | null; universe?: Array<{ tickers?: string[] }> } = {}) {
  const upserted: unknown[] = [];
  return {
    upserted,
    svc: {
      isReady: () => opts.ready !== false,
      getClient: () => ({
        from: (t: string) => {
          if (t === 'symbol_atr_cache') {
            return {
              select: () => ({
                eq: () => ({
                  limit: async () => ({
                    data: opts.atrRow ? [opts.atrRow] : [],
                    error: null,
                  }),
                }),
              }),
              upsert: async (row: unknown) => {
                upserted.push(row);
                return { error: null };
              },
            };
          }
          // watchlist_universe
          return {
            select: () => ({
              limit: async () => ({ data: opts.universe ?? [], error: null }),
            }),
          };
        },
      }),
    } as any,
  };
}

describe('SymbolAtrCacheService.computeAtr (pure)', () => {
  it('renvoie null si moins de 14 candles', () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({ date: `2026-01-${i+1}`, high: 100, low: 99, close: 99.5 }));
    expect(SymbolAtrCacheService.computeAtr(candles)).toBeNull();
  });

  it('ATR d\'un range constant (high-low=2, no gap) = 2', () => {
    const candles = Array.from({ length: 14 }, (_, i) => ({ date: `d${i}`, high: 101, low: 99, close: 100 }));
    expect(SymbolAtrCacheService.computeAtr(candles)).toBeCloseTo(2, 2);
  });

  it('ATR avec gap-up : TR inclut |high - prevClose|', () => {
    const candles = [
      { date: 'd0', high: 100, low: 99, close: 99.5 },
      ...Array.from({ length: 13 }, (_, i) => ({ date: `d${i+1}`, high: 105, low: 104, close: 104.5 })),
    ];
    // gap c0→c1 : prevClose=99.5 high=105 → TR=5.5 (vs h-l=1)
    // suivants : h-l=1
    // ATR(14) = (5.5 + 13×1) / 14 ≈ 1.32
    expect(SymbolAtrCacheService.computeAtr(candles)).toBeCloseTo(1.32, 1);
  });

  it('paramètre période custom', () => {
    const candles = Array.from({ length: 7 }, (_, i) => ({ date: `d${i}`, high: 102, low: 100, close: 101 }));
    expect(SymbolAtrCacheService.computeAtr(candles, 7)).toBeCloseTo(2, 2);
  });
});

describe('SymbolAtrCacheService.getAtrRatio (cache lookup)', () => {
  it('cache hit récent → renvoie valeur', async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const sb = makeSupabase({ atrRow: { atr_ratio_pct: 2.8, computed_at: recent } });
    const svc = new SymbolAtrCacheService(cfg(), sb.svc);
    expect(await svc.getAtrRatio('AAPL.US')).toBeCloseTo(2.8);
  });

  it('cache stale (>48h) → null (fail-open)', async () => {
    const stale = new Date(Date.now() - 72 * 3600_000).toISOString();
    const sb = makeSupabase({ atrRow: { atr_ratio_pct: 5.0, computed_at: stale } });
    const svc = new SymbolAtrCacheService(cfg(), sb.svc);
    expect(await svc.getAtrRatio('AAPL.US')).toBeNull();
  });

  it('cache vide → null (fail-open)', async () => {
    const sb = makeSupabase({ atrRow: null });
    const svc = new SymbolAtrCacheService(cfg(), sb.svc);
    expect(await svc.getAtrRatio('UNKNOWN.US')).toBeNull();
  });

  it('Supabase indispo → null', async () => {
    const sb = makeSupabase({ ready: false });
    const svc = new SymbolAtrCacheService(cfg(), sb.svc);
    expect(await svc.getAtrRatio('AAPL.US')).toBeNull();
  });
});

describe('SymbolAtrCacheService.refreshUniverse (env gating)', () => {
  it('cron OFF par défaut (SYMBOL_ATR_CACHE_REFRESH_ENABLED non set)', async () => {
    const sb = makeSupabase();
    const svc = new SymbolAtrCacheService(cfg(), sb.svc);
    expect(await svc.refreshUniverse()).toEqual({ processed: 0, persisted: 0, failed: 0 });
  });

  it('cron ON sans EODHD_API_KEY → no-op', async () => {
    const sb = makeSupabase();
    const svc = new SymbolAtrCacheService(cfg({ SYMBOL_ATR_CACHE_REFRESH_ENABLED: 'true' }), sb.svc);
    expect(await svc.refreshUniverse()).toEqual({ processed: 0, persisted: 0, failed: 0 });
  });

  it('cron ON + clé set + univers vide → no-op', async () => {
    const sb = makeSupabase({ universe: [] });
    const svc = new SymbolAtrCacheService(
      cfg({ SYMBOL_ATR_CACHE_REFRESH_ENABLED: 'true', EODHD_API_KEY: 'real' }),
      sb.svc,
    );
    expect(await svc.refreshUniverse()).toEqual({ processed: 0, persisted: 0, failed: 0 });
  });
});
