/**
 * Phase D-1 — Event-driven engine scaffold tests.
 */

import { Logger } from '@nestjs/common';
import { EventEngineService } from '../event-engine.service';
import { categorizeEvent } from '../event-engine.config';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function makeSupabase(opts: {
  ready?: boolean;
  upcomingEvents?: Array<{ event_name: string; country: string; event_date: string; importance: string }>;
  scheduledTrades?: Array<{ id: number; event_name: string; event_country: string; event_date: string; symbol: string; status: string; snapshot_price: number | null; snapshot_taken_at: string | null }>;
} = {}) {
  const inserts: unknown[] = [];
  const updates: Array<{ id: unknown; row: unknown }> = [];
  return {
    inserts,
    updates,
    svc: {
      isReady: () => opts.ready !== false,
      getClient: () => ({
        from: (t: string) => {
          if (t === 'eodhd_economic_events') {
            return {
              select: () => ({ gte: () => ({ lte: () => ({ in: async () => ({ data: opts.upcomingEvents ?? [], error: null }) }) }) }),
            };
          }
          if (t === 'event_engine_trades') {
            return {
              select: () => ({
                eq: () => ({
                  gte: () => ({
                    lte: () => ({
                      limit: async () => ({ data: opts.scheduledTrades ?? [], error: null }),
                      order: async () => ({ data: opts.scheduledTrades ?? [], error: null }),
                    }),
                  }),
                }),
                gte: () => ({ lte: () => ({ order: async () => ({ data: opts.scheduledTrades ?? [], error: null }) }) }),
              }),
              insert: async (row: unknown) => { inserts.push(row); return { error: null }; },
              update: (row: unknown) => ({
                eq: async (_col: string, id: unknown) => { updates.push({ id, row }); return { error: null }; },
              }),
            };
          }
          return {};
        },
      }),
    } as any,
  };
}

function makeLisa(opts: { price?: number; source?: string } = {}) {
  return {
    getLivePrice: async () => ({
      price: opts.price ?? 100,
      source: opts.source ?? 'eodhd',
    }),
  } as any;
}

describe('categorizeEvent (mapping event-name → category)', () => {
  it('reconnaît FOMC / Fed Rate', () => {
    expect(categorizeEvent('FOMC Rate Decision')!.type).toBe('macro_rate');
    expect(categorizeEvent('Fed Funds Rate Decision')!.type).toBe('macro_rate');
  });

  it('reconnaît PCE / Core PCE', () => {
    expect(categorizeEvent('PCE Price Index YoY')!.type).toBe('macro_rate');
    expect(categorizeEvent('Core PCE Price Index')!.type).toBe('macro_rate');
  });

  it('reconnaît CPI / Inflation', () => {
    expect(categorizeEvent('CPI YoY')!.type).toBe('macro_cpi');
    expect(categorizeEvent('Consumer Price Index')!.type).toBe('macro_cpi');
  });

  it('reconnaît NFP / ADP', () => {
    expect(categorizeEvent('Non-Farm Payrolls')!.type).toBe('macro_jobs');
    expect(categorizeEvent('ADP Employment Change')!.type).toBe('macro_jobs');
  });

  it('reconnaît GDP', () => {
    expect(categorizeEvent('GDP Annualized')!.type).toBe('macro_gdp');
  });

  it('null pour events hors scope', () => {
    expect(categorizeEvent('CFTC EUR speculative net positions')).toBeNull();
    expect(categorizeEvent('Random Speech by Some Official')).toBeNull();
    expect(categorizeEvent('')).toBeNull();
  });

  it('tickers watched cohérents par catégorie', () => {
    const fomc = categorizeEvent('FOMC Rate Decision')!;
    expect(fomc.watch).toContain('SPY.US');
    expect(fomc.tpPct).toBeGreaterThan(0);
    expect(fomc.slPct).toBeGreaterThan(0);
    expect(fomc.windowMin).toBeGreaterThan(0);
  });
});

describe('EventEngineService.tick (scaffolding)', () => {
  it('OFF par défaut → no-op', async () => {
    const sb = makeSupabase();
    const svc = new EventEngineService(cfg(), sb.svc, makeLisa());
    expect(svc.isEnabled()).toBe(false);
    expect(await svc.tick()).toEqual({ scheduled: 0, snapshotsTaken: 0 });
    expect(sb.inserts).toHaveLength(0);
  });

  it('ON + 1 event FOMC → schedule 3 tickers (SPY, QQQ, TLT)', async () => {
    const eventDate = new Date(Date.now() + 20 * 60_000).toISOString();
    const sb = makeSupabase({
      upcomingEvents: [{ event_name: 'FOMC Rate Decision', country: 'US', event_date: eventDate, importance: 'high' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa());
    const r = await svc.tick();
    expect(r.scheduled).toBe(3);
    expect(sb.inserts).toHaveLength(3);
    const symbols = (sb.inserts as Array<{ symbol: string }>).map((i) => i.symbol);
    expect(symbols).toContain('SPY.US');
    expect(symbols).toContain('QQQ.US');
    expect(symbols).toContain('TLT.US');
  });

  it('ON + event hors scope (CFTC) → skip silencieux', async () => {
    const eventDate = new Date(Date.now() + 20 * 60_000).toISOString();
    const sb = makeSupabase({
      upcomingEvents: [{ event_name: 'CFTC GBP speculative net positions', country: 'UK', event_date: eventDate, importance: 'medium' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa());
    expect((await svc.tick()).scheduled).toBe(0);
    expect(sb.inserts).toHaveLength(0);
  });

  it('takePreSnapshots : capture prix si event dans T-5min', async () => {
    const inImminentWindow = new Date(Date.now() + 4 * 60_000).toISOString();
    const sb = makeSupabase({
      scheduledTrades: [{
        id: 1, event_name: 'PCE Price Index', event_country: 'US', event_date: inImminentWindow,
        symbol: 'SPY.US', status: 'scheduled', snapshot_price: null, snapshot_taken_at: null,
      }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 425.50 }));
    const r = await svc.tick();
    expect(r.snapshotsTaken).toBeGreaterThanOrEqual(1);
    // Update appelé avec snapshot_price
    const upd = sb.updates[0]?.row as { snapshot_price?: number; status?: string };
    expect(upd?.snapshot_price).toBe(425.50);
    expect(upd?.status).toBe('pre_snapshot');
  });

  it('takePreSnapshots : skip si source fallback (anti-bug $0)', async () => {
    const inImminentWindow = new Date(Date.now() + 4 * 60_000).toISOString();
    const sb = makeSupabase({
      scheduledTrades: [{
        id: 1, event_name: 'PCE Price Index', event_country: 'US', event_date: inImminentWindow,
        symbol: 'SPY.US', status: 'scheduled', snapshot_price: null, snapshot_taken_at: null,
      }],
    });
    const svc = new EventEngineService(
      cfg({ EVENT_ENGINE_ENABLED: 'true' }),
      sb.svc,
      makeLisa({ price: 0.0, source: 'fallback_unknown' }),
    );
    const r = await svc.tick();
    expect(r.snapshotsTaken).toBe(0);
    expect(sb.updates).toHaveLength(0);
  });
});

describe('EventEngineService.listUpcoming', () => {
  it('renvoie [] si Supabase indispo', async () => {
    const sb = makeSupabase({ ready: false });
    const svc = new EventEngineService(cfg(), sb.svc, makeLisa());
    expect(await svc.listUpcoming(48)).toEqual([]);
  });
});
