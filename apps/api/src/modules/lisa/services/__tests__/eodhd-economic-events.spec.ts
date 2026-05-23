/**
 * EodhdEconomicEventsService — pull macro calendar (FOMC/PCE/etc.) + persist.
 */

import { Logger } from '@nestjs/common';
import { EodhdEconomicEventsService } from '../eodhd-economic-events.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function makeSupabase() {
  const upserted: unknown[][] = [];
  return {
    upserted,
    svc: {
      isReady: () => true,
      getClient: () => ({
        from: () => ({
          upsert: async (rows: unknown[]) => {
            upserted.push(rows);
            return { error: null };
          },
          select: () => ({
            gte: () => ({
              lte: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as any,
  };
}

describe('EodhdEconomicEventsService.toRow / parseNum', () => {
  it('parse nombre + supprime %/K/M/B/virgules', () => {
    expect(EodhdEconomicEventsService.parseNum(2.5)).toBe(2.5);
    expect(EodhdEconomicEventsService.parseNum('2.5%')).toBe(2.5);
    expect(EodhdEconomicEventsService.parseNum('1,200K')).toBe(1200);
    expect(EodhdEconomicEventsService.parseNum(null)).toBeNull();
    expect(EodhdEconomicEventsService.parseNum('')).toBeNull();
    expect(EodhdEconomicEventsService.parseNum('N/A')).toBeNull();
  });

  it('row valide depuis raw event EODHD', () => {
    const r = EodhdEconomicEventsService.toRow({
      type: 'PCE Price Index YoY',
      country: 'US',
      date: '2026-05-28T12:30:00Z',
      actual: null,
      previous: 2.3,
      estimate: 2.4,
      unit: '%',
      importance: 'high',
    });
    expect(r).not.toBeNull();
    expect(r!.event_name).toBe('PCE Price Index YoY');
    expect(r!.country).toBe('US');
    expect(r!.importance).toBe('high');
    expect(r!.previous).toBe(2.3);
    expect(r!.estimate).toBe(2.4);
  });

  it('null si champs essentiels absents', () => {
    expect(EodhdEconomicEventsService.toRow({ country: 'US' })).toBeNull();
    expect(EodhdEconomicEventsService.toRow({ type: 'X', date: '2026' })).toBeNull();
  });
});

describe('EodhdEconomicEventsService.pullAndPersist', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it("ne fait rien si EODHD_ECONOMIC_EVENTS_ENABLED=false (default)", async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn() as any;
    const svc = new EodhdEconomicEventsService(cfg(), sb.svc);
    expect(await svc.pullAndPersist()).toEqual({ fetched: 0, persisted: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pull + upsert si enabled + key set', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { type: 'FOMC Rate Decision', country: 'US', date: '2026-05-28T18:00:00Z', importance: 'high' },
        { type: 'ECB Press Conference', country: 'EU', date: '2026-05-29T12:30:00Z', importance: 'medium' },
      ],
    }) as any;
    const svc = new EodhdEconomicEventsService(
      cfg({ EODHD_ECONOMIC_EVENTS_ENABLED: 'true', EODHD_API_KEY: 'real' }),
      sb.svc,
    );
    const r = await svc.pullAndPersist(7);
    expect(r.fetched).toBe(2);
    expect(r.persisted).toBe(2);
    expect(sb.upserted).toHaveLength(1);
  });

  it('HTTP error → fetched=0', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    const svc = new EodhdEconomicEventsService(
      cfg({ EODHD_ECONOMIC_EVENTS_ENABLED: 'true', EODHD_API_KEY: 'real' }),
      sb.svc,
    );
    expect(await svc.pullAndPersist()).toEqual({ fetched: 0, persisted: 0 });
  });

  it('payload non-array → fetched=0', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ error: 'x' }) }) as any;
    const svc = new EodhdEconomicEventsService(
      cfg({ EODHD_ECONOMIC_EVENTS_ENABLED: 'true', EODHD_API_KEY: 'real' }),
      sb.svc,
    );
    expect(await svc.pullAndPersist()).toEqual({ fetched: 0, persisted: 0 });
  });
});
