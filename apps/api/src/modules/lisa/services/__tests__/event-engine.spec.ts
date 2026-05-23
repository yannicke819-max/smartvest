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
                  // D-3 chain : eq().limit() direct (forceCloseExpired)
                  limit: async () => ({ data: [], error: null }),
                  // D-1 chain : eq().gte().lte().limit() (takePreSnapshots)
                  gte: () => ({
                    lte: () => ({
                      limit: async () => ({ data: opts.scheduledTrades ?? [], error: null }),
                      order: async () => ({ data: opts.scheduledTrades ?? [], error: null }),
                    }),
                  }),
                }),
                // listUpcoming chain : select().gte().lte().order()
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
    expect(await svc.tick()).toEqual({ scheduled: 0, snapshotsTaken: 0, triggered: 0, forceClosed: 0 });
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

// ──────────────────────────────────────────────────────────────────
// D-2 — evaluateTriggers
// ──────────────────────────────────────────────────────────────────

function makeTriggerSupabase(opts: {
  preSnapshotRows: Array<{ id: number; snapshot_price: number; event_date: string; symbol: string; event_name?: string; event_country?: string; status?: string; snapshot_taken_at?: string | null }>;
}) {
  const updates: Array<{ id: unknown; row: Record<string, unknown> }> = [];
  return {
    updates,
    svc: {
      isReady: () => true,
      getClient: () => ({
        from: (t: string) => {
          if (t === 'event_engine_trades') {
            return {
              select: () => ({
                eq: (_col: string, value: string) => ({
                  // Pre-snapshot path
                  gte: () => ({
                    lte: () => ({
                      limit: async () => ({
                        data: value === 'pre_snapshot'
                          ? opts.preSnapshotRows.map((r) => ({
                              id: r.id, event_name: r.event_name ?? 'Test Event',
                              event_country: r.event_country ?? 'US',
                              event_date: r.event_date, symbol: r.symbol,
                              status: 'pre_snapshot', snapshot_price: r.snapshot_price,
                              snapshot_taken_at: r.snapshot_taken_at ?? new Date().toISOString(),
                            }))
                          : [],
                        error: null,
                      }),
                    }),
                  }),
                }),
                gte: () => ({ lte: () => ({ in: async () => ({ data: [], error: null }) }) }),
              }),
              insert: async () => ({ error: null }),
              update: (row: Record<string, unknown>) => ({
                eq: async (_col: string, id: unknown) => { updates.push({ id, row }); return { error: null }; },
              }),
            };
          }
          if (t === 'eodhd_economic_events') {
            return { select: () => ({ gte: () => ({ lte: () => ({ in: async () => ({ data: [], error: null }) }) }) }) };
          }
          return {};
        },
      }),
    } as any,
  };
}

describe('EventEngineService.evaluateTriggers (D-2)', () => {
  it('delta > 0.3% → status=triggered direction=long', async () => {
    const pastEvent = new Date(Date.now() - 7 * 60_000).toISOString();  // event T-7min, in [T-10, T-5] window
    const sb = makeTriggerSupabase({
      preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 100.50 }));
    const r = await svc.evaluateTriggers(new Date());
    expect(r).toBe(1);
    const upd = sb.updates[0]?.row;
    expect(upd?.status).toBe('triggered');
    expect(upd?.trigger_direction).toBe('long');
    expect(Number(upd?.trigger_delta_pct)).toBeCloseTo(0.5, 1);
  });

  it('delta < -0.3% → status=triggered direction=short', async () => {
    const pastEvent = new Date(Date.now() - 7 * 60_000).toISOString();
    const sb = makeTriggerSupabase({
      preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 99.40 }));
    const r = await svc.evaluateTriggers(new Date());
    expect(r).toBe(1);
    const upd = sb.updates[0]?.row;
    expect(upd?.status).toBe('triggered');
    expect(upd?.trigger_direction).toBe('short');
  });

  it('delta < seuil → status=skipped (pas de direction valide)', async () => {
    const pastEvent = new Date(Date.now() - 7 * 60_000).toISOString();
    const sb = makeTriggerSupabase({
      preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 100.10 }));
    const r = await svc.evaluateTriggers(new Date());
    expect(r).toBe(0);
    const upd = sb.updates[0]?.row;
    expect(upd?.status).toBe('skipped');
    expect(upd?.trigger_direction).toBeNull();
  });

  it('source fallback → skip silencieux (anti-bug)', async () => {
    const pastEvent = new Date(Date.now() - 7 * 60_000).toISOString();
    const sb = makeTriggerSupabase({
      preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }],
    });
    const svc = new EventEngineService(
      cfg({ EVENT_ENGINE_ENABLED: 'true' }),
      sb.svc,
      makeLisa({ price: 0, source: 'fallback_unknown' }),
    );
    expect(await svc.evaluateTriggers(new Date())).toBe(0);
    expect(sb.updates).toHaveLength(0);
  });

  it('seuil configurable EVENT_ENGINE_MIN_TRIGGER_DELTA_PCT', async () => {
    const pastEvent = new Date(Date.now() - 7 * 60_000).toISOString();
    const sb1 = makeTriggerSupabase({ preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }] });
    const sb2 = makeTriggerSupabase({ preSnapshotRows: [{ id: 1, snapshot_price: 100, event_date: pastEvent, symbol: 'SPY.US' }] });
    // delta 0.4% : avec seuil 0.5% → skipped, avec seuil 0.3% → triggered
    const strict = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true', EVENT_ENGINE_MIN_TRIGGER_DELTA_PCT: '0.005' }), sb1.svc, makeLisa({ price: 100.40 }));
    const lax = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true', EVENT_ENGINE_MIN_TRIGGER_DELTA_PCT: '0.003' }), sb2.svc, makeLisa({ price: 100.40 }));
    expect(await strict.evaluateTriggers(new Date())).toBe(0);
    expect(await lax.evaluateTriggers(new Date())).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// D-3 — forceCloseExpired
// ──────────────────────────────────────────────────────────────────

function makeForceCloseSupabase(opts: {
  triggeredRows: Array<{ id: number; event_name?: string; event_date: string; symbol: string; trigger_price: number; trigger_direction: 'long' | 'short'; raw_payload?: { window_min?: number } }>;
}) {
  const updates: Array<{ id: unknown; row: Record<string, unknown> }> = [];
  return {
    updates,
    svc: {
      isReady: () => true,
      getClient: () => ({
        from: (t: string) => {
          if (t === 'event_engine_trades') {
            return {
              select: () => ({
                eq: (_col: string, value: string) => ({
                  limit: async () => ({
                    data: value === 'triggered'
                      ? opts.triggeredRows.map((r) => ({
                          id: r.id,
                          event_name: r.event_name ?? 'Test Event',
                          event_date: r.event_date,
                          symbol: r.symbol,
                          trigger_price: r.trigger_price,
                          trigger_direction: r.trigger_direction,
                          trigger_taken_at: new Date().toISOString(),
                          raw_payload: r.raw_payload ?? { window_min: 30 },
                        }))
                      : [],
                    error: null,
                  }),
                  gte: () => ({ lte: () => ({ limit: async () => ({ data: [], error: null }) }) }),
                }),
              }),
              update: (row: Record<string, unknown>) => ({
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

describe('EventEngineService.forceCloseExpired (D-3)', () => {
  it('long en gain : pnl_net = gross - 0.1% frais', async () => {
    // Event T-31min, window 30 → close deadline T-1min (expirée)
    const event = new Date(Date.now() - 31 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'long' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 101.50 }));
    const r = await svc.forceCloseExpired(new Date());
    expect(r).toBe(1);
    const upd = sb.updates[0]?.row;
    expect(upd?.status).toBe('force_closed');
    expect(upd?.exit_price).toBe(101.50);
    // gross = 1.5%, net = 1.5% - 0.1% = 1.4%
    expect(Number(upd?.realized_pnl_pct)).toBeCloseTo(1.4, 2);
  });

  it('long en perte : pnl_net négatif inclut frais', async () => {
    const event = new Date(Date.now() - 31 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'long' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 99.20 }));
    await svc.forceCloseExpired(new Date());
    const upd = sb.updates[0]?.row;
    // gross = -0.8%, net = -0.8% - 0.1% = -0.9%
    expect(Number(upd?.realized_pnl_pct)).toBeCloseTo(-0.9, 2);
  });

  it('short en gain : prix baisse → pnl_net positif', async () => {
    const event = new Date(Date.now() - 31 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'short' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 98.50 }));
    await svc.forceCloseExpired(new Date());
    const upd = sb.updates[0]?.row;
    // gross = +1.5% (short de 100→98.5), net = 1.4%
    expect(upd?.trigger_direction).toBeUndefined();  // pas dans le UPDATE
    expect(Number(upd?.realized_pnl_pct)).toBeCloseTo(1.4, 2);
  });

  it('window non expirée → skip (pas de close)', async () => {
    // Event T-10min, window 30 → close deadline T+20min (futur)
    const event = new Date(Date.now() - 10 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'long' }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 102 }));
    expect(await svc.forceCloseExpired(new Date())).toBe(0);
    expect(sb.updates).toHaveLength(0);
  });

  it('source fallback → ne close pas (réessaie tick suivant)', async () => {
    const event = new Date(Date.now() - 31 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'long' }],
    });
    const svc = new EventEngineService(
      cfg({ EVENT_ENGINE_ENABLED: 'true' }),
      sb.svc,
      makeLisa({ price: 0, source: 'fallback_unknown' }),
    );
    expect(await svc.forceCloseExpired(new Date())).toBe(0);
    expect(sb.updates).toHaveLength(0);
  });

  it('window_min custom respecté (event_category 20min)', async () => {
    // Event T-21min, window 20 → close deadline T-1min (expirée)
    const event = new Date(Date.now() - 21 * 60_000).toISOString();
    const sb = makeForceCloseSupabase({
      triggeredRows: [{ id: 1, event_date: event, symbol: 'SPY.US', trigger_price: 100, trigger_direction: 'long', raw_payload: { window_min: 20 } }],
    });
    const svc = new EventEngineService(cfg({ EVENT_ENGINE_ENABLED: 'true' }), sb.svc, makeLisa({ price: 100.5 }));
    expect(await svc.forceCloseExpired(new Date())).toBe(1);
  });
});
