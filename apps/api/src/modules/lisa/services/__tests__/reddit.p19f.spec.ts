/**
 * P19f — Regression tests pour Reddit RSS 403 graceful degrade (#97).
 *
 * Issue #97 (29/04/2026 14:05 prod) : 100% des feeds RSS retournent 403.
 *   reddit rss stocks HTTP 403
 *   reddit rss investing HTTP 403
 *   ...
 *   news aggregate ... reddit=0 twitter=0
 *
 * Fix scope :
 *   - UA conforme Reddit recommandé `<platform>:<app-id>:<v> (by /u/<user>)`
 *   - Headers enrichis (Accept-Language, Cache-Control, Pragma)
 *   - Log agrégé warn fin de cycle (au lieu de 5 × debug par sub)
 *   - Compteur observability `getTotalBlockedCycles()`
 *   - Service ne throw jamais → degrade graceful avec [] retour
 *
 * Hors scope (par instruction utilisateur "quick fix UA d'abord") :
 *   - OAuth Reddit migration → environment-based, déjà supporté quand
 *     REDDIT_CLIENT_ID/SECRET sont set, le service bascule auto sur le path OAuth
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedditService } from '../reddit.service';

const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

const realFetch = global.fetch;

beforeEach(() => {
  logSpy.mockClear();
  warnSpy.mockClear();
  debugSpy.mockClear();
  global.fetch = realFetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

function makeConfig(envMap: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn((key: string) => envMap[key]),
  } as unknown as ConfigService;
}

function makeService(envMap: Record<string, string | undefined> = {}): RedditService {
  return new RedditService(makeConfig(envMap));
}

describe('P19f — RedditService graceful degrade on 403', () => {
  it('default User-Agent follows Reddit-recommended format `<platform>:<app-id>:<v> (by /u/<user>)`', () => {
    const svc = makeService({});
    const ua = (svc as any).getUserAgent();
    expect(ua).toMatch(/^web:smartvest-news:v\d+\.\d+ \(by \/u\/[\w-]+\)$/);
  });

  it('respects REDDIT_USER_AGENT env override', () => {
    const svc = makeService({ REDDIT_USER_AGENT: 'custom-agent/2.0' });
    const ua = (svc as any).getUserAgent();
    expect(ua).toBe('custom-agent/2.0');
  });

  it('all subs HTTP 403 → empty result + ONE aggregated warn (no 5×debug spam)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 403,
      ok: false,
      headers: new Map([['content-type', 'text/html']]) as any,
      text: async () => '<html>Forbidden</html>',
      json: async () => ({}),
    } as unknown as Response);

    const svc = makeService({ REDDIT_USE_RSS: 'true' });
    const result = await svc.fetchHotPosts(25);
    expect(result).toEqual([]);

    // Find the aggregated warn (not the per-sub debug)
    const aggregatedWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('[reddit:rss]') && String(c[0]).includes('blocked this cycle'),
    );
    expect(aggregatedWarn).toBeDefined();
    const msg = String(aggregatedWarn![0]);
    expect(msg).toContain('5/5 sub(s) blocked');
    // Should mention the OAuth fix hint
    expect(msg).toContain('REDDIT_CLIENT_ID');
  });

  it('total blocked cycles counter increments only when ALL subs blocked', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 403,
      ok: false,
      headers: new Map([['content-type', 'text/html']]) as any,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response);

    const svc = makeService({ REDDIT_USE_RSS: 'true' });
    expect(svc.getTotalBlockedCycles()).toBe(0);
    await svc.fetchHotPosts(25);
    expect(svc.getTotalBlockedCycles()).toBe(1);
    // Cache 5min in RSS mode — 2nd fetchHotPosts hits cache, no new fetch
    await svc.fetchHotPosts(25);
    expect(svc.getTotalBlockedCycles()).toBe(1); // pas re-incrémenté (cache)
  });

  it('partial blocked subs (3/5) → warn but counter NOT incremented (not "fully blocked")', async () => {
    let callIdx = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      callIdx++;
      // First 2 calls succeed, last 3 fail with 403
      const succeed = callIdx <= 2;
      return {
        status: succeed ? 200 : 403,
        ok: succeed,
        headers: new Map([['content-type', 'application/json']]) as any,
        text: async () => '',
        json: async () => ({ data: { children: [] } }),
      } as unknown as Response;
    });

    const svc = makeService({ REDDIT_USE_RSS: 'true' });
    await svc.fetchHotPosts(25);
    // Counter not incremented because not ALL subs failed
    expect(svc.getTotalBlockedCycles()).toBe(0);

    const aggregatedWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('blocked this cycle'),
    );
    expect(aggregatedWarn).toBeDefined();
    expect(String(aggregatedWarn![0])).toContain('3/5');
  });

  it('headers sent include UA + Accept + Accept-Language + Cache-Control', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return {
        status: 403,
        ok: false,
        headers: new Map([['content-type', 'text/html']]) as any,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    });

    const svc = makeService({ REDDIT_USE_RSS: 'true' });
    await svc.fetchHotPosts(25);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!['User-Agent']).toMatch(/smartvest/);
    expect(capturedHeaders!['Accept']).toBe('application/json');
    expect(capturedHeaders!['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(capturedHeaders!['Cache-Control']).toBe('no-cache');
    expect(capturedHeaders!['Pragma']).toBe('no-cache');
  });

  it('all subs success → no aggregated warn, counter stays 0', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'application/json']]) as any,
      json: async () => ({ data: { children: [] } }),
      text: async () => '',
    } as unknown as Response);

    const svc = makeService({ REDDIT_USE_RSS: 'true' });
    const result = await svc.fetchHotPosts(25);
    expect(result).toEqual([]);

    const aggregatedWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('blocked this cycle'),
    );
    expect(aggregatedWarn).toBeUndefined();
    expect(svc.getTotalBlockedCycles()).toBe(0);
  });
});
