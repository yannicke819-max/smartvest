/**
 * Daily catalyst brief — couche d'intelligence dynamique Gemini.
 * Tests : parsing robuste (JSON pur + markdown fences) + flow generate/persist
 * + lecture du dernier brief + garde env-disabled.
 */

import { Logger } from '@nestjs/common';
import { DailyCatalystBriefService } from '../daily-catalyst-brief.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as any;

const econ = (upcoming: any[] = []) => ({
  getUpcomingEvents: async () => upcoming,
}) as any;

function makeSupabase(opts: { ready?: boolean; latestPayload?: unknown; insertErr?: string }) {
  const inserted: unknown[] = [];
  return {
    inserted,
    svc: {
      isReady: () => opts.ready !== false,
      getClient: () => ({
        from: (_t: string) => ({
          insert: async (row: unknown) => {
            inserted.push(row);
            return { error: opts.insertErr ? { message: opts.insertErr } : null };
          },
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: opts.latestPayload !== undefined ? [{ payload: opts.latestPayload }] : [],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    } as any,
  };
}

function makeLlm(content: string, opts: { fail?: boolean } = {}) {
  return {
    call: async () => {
      if (opts.fail) throw new Error('router disabled');
      return { content, providerId: 'gemini-flash-lite', costUsd: 0.0001, latencyMs: 250, fallbackUsed: false };
    },
  } as any;
}

const SAMPLE_BRIEF_JSON = JSON.stringify({
  date: '2026-05-23',
  macro_events: [{ time_utc: '12:30', event: 'PCE prices', impact: 'high' }],
  tickers_to_watch: [{ ticker: 'CRM.US', reason: 'earnings 27/05', type: 'earnings' }],
  tickers_to_avoid: [{ ticker: 'X.US', reason: 'post-earnings hangover', type: 'post_event' }],
  sectors_in_focus: ['semis', 'consumer discretionary'],
  summary: 'PCE Wednesday is the catalyst. Memorial Day Monday US closed.',
});

describe('DailyCatalystBriefService', () => {
  describe('parseBriefJson', () => {
    it('parse JSON pur produit par Gemini', () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      const b = svc.parseBriefJson(SAMPLE_BRIEF_JSON, '2026-05-23');
      expect(b).not.toBeNull();
      expect(b!.summary).toContain('PCE');
      expect(b!.tickers_to_watch).toHaveLength(1);
    });

    it("tolère les fences markdown ```json ... ```", () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      const wrapped = '```json\n' + SAMPLE_BRIEF_JSON + '\n```';
      const b = svc.parseBriefJson(wrapped, '2026-05-23');
      expect(b).not.toBeNull();
      expect(b!.summary).toContain('PCE');
    });

    it('limite chaque liste à 10 items (anti-flood)', () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      const huge = JSON.stringify({
        date: '2026-05-23',
        macro_events: Array.from({ length: 50 }, (_, i) => ({ event: `E${i}` })),
        tickers_to_watch: Array.from({ length: 50 }, (_, i) => ({ ticker: `T${i}.US`, reason: 'x' })),
        summary: 'huge',
      });
      const b = svc.parseBriefJson(huge, '2026-05-23');
      expect(b!.macro_events!.length).toBe(10);
      expect(b!.tickers_to_watch!.length).toBe(10);
    });

    it('renvoie null si JSON invalide', () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      expect(svc.parseBriefJson('not json at all', '2026-05-23')).toBeNull();
    });

    it("renvoie null si payload sans 'summary'", () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      expect(svc.parseBriefJson(JSON.stringify({ date: '2026-05-23' }), '2026-05-23')).toBeNull();
    });

    it('fallback date si absente', () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      const b = svc.parseBriefJson(JSON.stringify({ summary: 'ok' }), '2026-05-23');
      expect(b!.date).toBe('2026-05-23');
    });
  });

  describe('generateAndPersistBrief', () => {
    it('appelle Gemini + persiste dans decision_log (kind=daily_catalyst_brief)', async () => {
      const sb = makeSupabase({});
      const svc = new DailyCatalystBriefService(cfg(), sb.svc, makeLlm(SAMPLE_BRIEF_JSON), econ());
      const b = await svc.generateAndPersistBrief();
      expect(b).not.toBeNull();
      expect(b!.summary).toContain('PCE');
      expect(sb.inserted).toHaveLength(1);
      const row = sb.inserted[0] as { kind: string; payload: any };
      expect(row.kind).toBe('daily_catalyst_brief');
      expect(row.payload.summary).toContain('PCE');
      expect(row.payload.llm_provider).toBe('gemini-flash-lite');
    });

    it('LLM échoue → null, pas de crash, pas de persist', async () => {
      const sb = makeSupabase({});
      const svc = new DailyCatalystBriefService(cfg(), sb.svc, makeLlm('', { fail: true }), econ());
      expect(await svc.generateAndPersistBrief()).toBeNull();
      expect(sb.inserted).toHaveLength(0);
    });

    it('LLM renvoie texte non-JSON → null, pas de persist', async () => {
      const sb = makeSupabase({});
      const svc = new DailyCatalystBriefService(cfg(), sb.svc, makeLlm('Désolé, je ne peux pas répondre.'), econ());
      expect(await svc.generateAndPersistBrief()).toBeNull();
      expect(sb.inserted).toHaveLength(0);
    });

    it('Supabase indispo → renvoie le brief mais skip persist (pas de crash)', async () => {
      const sb = makeSupabase({ ready: false });
      const svc = new DailyCatalystBriefService(cfg(), sb.svc, makeLlm(SAMPLE_BRIEF_JSON), econ());
      const b = await svc.generateAndPersistBrief();
      expect(b).not.toBeNull();
      expect(sb.inserted).toHaveLength(0);
    });
  });

  describe('getLatestBrief', () => {
    it('retourne le dernier brief si présent', async () => {
      const payload = { date: '2026-05-23', summary: 'test', tickers_to_watch: [] };
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({ latestPayload: payload }).svc, makeLlm(''), econ());
      const b = await svc.getLatestBrief();
      expect(b).toEqual(payload);
    });

    it('null si aucun brief encore', async () => {
      const svc = new DailyCatalystBriefService(cfg(), makeSupabase({}).svc, makeLlm(''), econ());
      expect(await svc.getLatestBrief()).toBeNull();
    });
  });

  describe('cronDailyBrief (env-gated)', () => {
    it("ne fait rien si GEMINI_DAILY_BRIEF_ENABLED=false (default)", async () => {
      const sb = makeSupabase({});
      const svc = new DailyCatalystBriefService(cfg(), sb.svc, makeLlm(SAMPLE_BRIEF_JSON), econ());
      await svc.cronDailyBrief();
      expect(sb.inserted).toHaveLength(0);
    });

    it('génère + persiste si enabled=true', async () => {
      const sb = makeSupabase({});
      const svc = new DailyCatalystBriefService(cfg({ GEMINI_DAILY_BRIEF_ENABLED: 'true' }), sb.svc, makeLlm(SAMPLE_BRIEF_JSON), econ());
      await svc.cronDailyBrief();
      expect(sb.inserted).toHaveLength(1);
    });
  });
});
