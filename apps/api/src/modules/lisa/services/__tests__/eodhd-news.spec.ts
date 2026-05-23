/**
 * EodhdNewsService — pull + persist + dedupe + parse robustness.
 */

import { Logger } from '@nestjs/common';
import { EodhdNewsService } from '../eodhd-news.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

function makeSupabase(opts: { ready?: boolean; upsertErr?: string } = {}) {
  const upserted: unknown[][] = [];
  return {
    upserted,
    svc: {
      isReady: () => opts.ready !== false,
      getClient: () => ({
        from: () => ({
          upsert: async (rows: unknown[]) => {
            upserted.push(rows);
            return { error: opts.upsertErr ? { message: opts.upsertErr } : null };
          },
          select: () => ({
            eq: () => ({ gte: () => ({ order: async () => ({ data: [], error: null }) }) }),
          }),
        }),
      }),
    } as any,
  };
}

describe('EodhdNewsService.toRow / computeExternalId', () => {
  it('hash externe stable et déterministe sur (date jour + titre normalisé)', () => {
    const a = EodhdNewsService.computeExternalId('2026-05-22T15:00:00Z', 'Earnings Beat');
    const b = EodhdNewsService.computeExternalId('2026-05-22T17:00:00Z', 'Earnings Beat'); // même jour
    const c = EodhdNewsService.computeExternalId('2026-05-22T15:00:00Z', 'earnings beat'); // case-insensitive
    expect(a).toBe(b);
    expect(a).toBe(c);
    const d = EodhdNewsService.computeExternalId('2026-05-23T15:00:00Z', 'Earnings Beat');
    expect(d).not.toBe(a);
  });

  it('parse article EODHD avec sentiment', () => {
    const r = EodhdNewsService.toRow('AAP.US', {
      date: '2026-05-22T15:00:00Z',
      title: 'Advance Auto Q1 Earnings Beat Estimates',
      content: 'long body',
      link: 'https://example.com',
      sentiment: { polarity: 0.998, neg: 0, neu: 0.1, pos: 0.9 },
      symbols: ['AAP.US'],
      tags: ['earnings'],
    });
    expect(r).not.toBeNull();
    expect(r!.ticker).toBe('AAP.US');
    expect(r!.sentiment_polarity).toBeCloseTo(0.998);
    expect(r!.published_at).toMatch(/2026-05-22/);
    expect(r!.tags).toEqual(['earnings']);
  });

  it('renvoie null si date ou titre absent', () => {
    expect(EodhdNewsService.toRow('X.US', { title: 'no date' })).toBeNull();
    expect(EodhdNewsService.toRow('X.US', { date: '2026-05-22' } as any)).toBeNull();
  });

  it('tronque contenu et title (anti-bloat)', () => {
    const big = 'x'.repeat(10000);
    const r = EodhdNewsService.toRow('X.US', { date: '2026-05-22', title: big, content: big });
    expect(r!.title.length).toBeLessThanOrEqual(500);
    expect(r!.content!.length).toBeLessThanOrEqual(5000);
  });
});

describe('EodhdNewsService.fetchAndPersistOne', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it("ne fait rien si EODHD_NEWS_PERSIST_ENABLED=false (default)", async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn() as any;
    const svc = new EodhdNewsService(cfg(), sb.svc);
    expect(await svc.fetchAndPersistOne('AAP.US', '2026-05-08', '2026-05-23')).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ne fait rien si EODHD_API_KEY absent ou 'demo'", async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn() as any;
    const svc = new EodhdNewsService(cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true' }), sb.svc);
    expect(await svc.fetchAndPersistOne('AAP.US', '2026-05-08', '2026-05-23')).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pull + upsert si enabled, key set, réponse API valide', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { date: '2026-05-22T15:00:00Z', title: 'Earnings Beat', sentiment: { polarity: 0.9 } },
        { date: '2026-05-22T16:00:00Z', title: 'Analyst Upgrade', sentiment: { polarity: 0.5 } },
      ],
    }) as any;
    const svc = new EodhdNewsService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_API_KEY: 'real-key' }),
      sb.svc,
    );
    const n = await svc.fetchAndPersistOne('AAP.US', '2026-05-08', '2026-05-23');
    expect(n).toBe(2);
    expect(sb.upserted).toHaveLength(1);
    expect((sb.upserted[0] as any[])[0].ticker).toBe('AAP.US');
  });

  it('HTTP error → 0, pas de crash', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    const svc = new EodhdNewsService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_API_KEY: 'key' }),
      sb.svc,
    );
    expect(await svc.fetchAndPersistOne('X.US', '2026-05-08', '2026-05-23')).toBe(0);
    expect(sb.upserted).toHaveLength(0);
  });

  it('réponse vide (array []) → 0', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [] }) as any;
    const svc = new EodhdNewsService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_API_KEY: 'key' }),
      sb.svc,
    );
    expect(await svc.fetchAndPersistOne('X.US', '2026-05-08', '2026-05-23')).toBe(0);
  });

  it('réponse non-array (erreur API stringifiée) → 0', async () => {
    const sb = makeSupabase();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ error: 'Unauthenticated' }) }) as any;
    const svc = new EodhdNewsService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_API_KEY: 'key' }),
      sb.svc,
    );
    expect(await svc.fetchAndPersistOne('X.US', '2026-05-08', '2026-05-23')).toBe(0);
  });

  it('Supabase indispo → 0 (pas de crash)', async () => {
    const sb = makeSupabase({ ready: false });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ date: '2026-05-22', title: 'x' }],
    }) as any;
    const svc = new EodhdNewsService(
      cfg({ EODHD_NEWS_PERSIST_ENABLED: 'true', EODHD_API_KEY: 'key' }),
      sb.svc,
    );
    expect(await svc.fetchAndPersistOne('X.US', '2026-05-08', '2026-05-23')).toBe(0);
  });
});
