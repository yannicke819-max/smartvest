/**
 * P5-REDDIT-RSS-FALLBACK — Tests mode RSS public (sans OAuth).
 *
 * Couvre :
 *   - useRssMode dispatch logic (env REDDIT_USE_RSS, OAuth absent)
 *   - User-Agent custom obligatoire (default 'smartvest-news/1.0')
 *   - Parsing JSON listing → EodhdNewsItem[]
 *   - Filter sticky posts + non-t3 entries
 *   - Cache 5min en mode RSS
 *   - 429 backoff exponentiel
 *   - Content-Type non-JSON (auth wall) → []
 *   - isConfigured() = true en RSS mode même sans creds
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedditService } from '../reddit.service';

interface FakeFetchResponse {
  status: number;
  ok?: boolean;
  contentType?: string;
  body: unknown;
}

let fetchMock: jest.Mock;
const realFetch = global.fetch;

function installFetchMock(responses: FakeFetchResponse[] | (() => FakeFetchResponse)) {
  let i = 0;
  fetchMock = jest.fn(async () => {
    const r = typeof responses === 'function' ? responses() : responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      status: r.status,
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-type' ? (r.contentType ?? 'application/json') : null,
      },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
}

afterEach(() => {
  (global as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

async function makeService(env: Record<string, string | undefined>): Promise<RedditService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RedditService,
      { provide: ConfigService, useValue: { get: (k: string) => env[k] ?? null } },
    ],
  }).compile();
  return moduleRef.get(RedditService);
}

const buildPost = (overrides: Partial<{
  title: string;
  score: number;
  num_comments: number;
  created_utc: number;
  permalink: string;
  selftext: string;
  upvote_ratio: number;
  link_flair_text: string;
  stickied: boolean;
}> = {}) => ({
  kind: 't3',
  data: {
    title: 'TSLA squeeze incoming',
    score: 1500,
    num_comments: 200,
    created_utc: Math.floor(Date.now() / 1000),
    permalink: '/r/wallstreetbets/comments/abc/tsla_squeeze',
    selftext: 'Body text',
    upvote_ratio: 0.92,
    link_flair_text: 'DD',
    stickied: false,
    ...overrides,
  },
});

const buildListing = (children: ReturnType<typeof buildPost>[] = []) => ({
  data: { children },
});

describe('RedditService — RSS public mode (P5-REDDIT-RSS-FALLBACK)', () => {
  describe('useRssMode dispatch', () => {
    it('isConfigured()=true when REDDIT_USE_RSS=true (no creds needed)', async () => {
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      expect(svc.isConfigured()).toBe(true);
    });

    it('isConfigured()=true implicitly when no OAuth creds (RSS fallback)', async () => {
      const svc = await makeService({});
      expect(svc.isConfigured()).toBe(true);
    });

    it('isConfigured()=true with OAuth creds (RSS skipped, OAuth used)', async () => {
      const svc = await makeService({
        REDDIT_CLIENT_ID: 'id',
        REDDIT_CLIENT_SECRET: 'secret',
        REDDIT_USER_AGENT: 'test/1.0',
      });
      expect(svc.isConfigured()).toBe(true);
    });
  });

  describe('fetchHotPosts in RSS mode', () => {
    it('uses public www.reddit.com URL (no oauth.reddit.com)', async () => {
      installFetchMock([{ status: 200, body: buildListing([buildPost()]) }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      await svc.fetchHotPosts(25);
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((u) => u.includes('www.reddit.com'))).toBe(true);
      expect(calls.every((u) => !u.includes('oauth.reddit.com'))).toBe(true);
      expect(calls.every((u) => u.includes('hot.json'))).toBe(true);
    });

    it('sets custom User-Agent (REDDIT_USER_AGENT or default smartvest-news/1.0)', async () => {
      installFetchMock([{ status: 200, body: buildListing([buildPost()]) }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true', REDDIT_USER_AGENT: 'my-bot/2.0' });
      await svc.fetchHotPosts(10);
      const headers = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
      expect(headers.headers['User-Agent']).toBe('my-bot/2.0');
    });

    it("uses default 'smartvest-news/1.0' User-Agent if REDDIT_USER_AGENT absent", async () => {
      installFetchMock([{ status: 200, body: buildListing([buildPost()]) }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      await svc.fetchHotPosts(10);
      const headers = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
      expect(headers.headers['User-Agent']).toBe('smartvest-news/1.0');
    });

    it('parses JSON listing → EodhdNewsItem[] with score tag', async () => {
      installFetchMock([{
        status: 200,
        body: buildListing([
          buildPost({ title: 'GME to the moon', score: 5000 }),
          buildPost({ title: 'AAPL earnings beat', score: 800 }),
        ]),
      }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      const items = await svc.fetchHotPosts(50);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].provider).toBe('reddit');
      expect(items[0].title.length).toBeGreaterThan(0);
      // tag score:N présent
      expect(items[0].tags.some((t) => t.startsWith('score:'))).toBe(true);
    });

    it('filters out stickied posts', async () => {
      installFetchMock([{
        status: 200,
        body: buildListing([
          buildPost({ title: 'STICKY rules', stickied: true, score: 9999 }),
          buildPost({ title: 'real DD', stickied: false, score: 100 }),
        ]),
      }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      const items = await svc.fetchHotPosts(10);
      expect(items.every((i) => !i.title.includes('STICKY'))).toBe(true);
    });

    it('returns [] on 429 final after retries', async () => {
      installFetchMock(() => ({ status: 429, body: {} }));
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      const items = await svc.fetchHotPosts(10);
      expect(items).toEqual([]);
      // 3 tentatives × 5 subreddits ≤ 15 fetches max (3 retries each)
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it('returns [] when Content-Type is not JSON (auth wall HTML page)', async () => {
      installFetchMock(() => ({
        status: 200,
        body: '<html>Login required</html>',
        contentType: 'text/html; charset=utf-8',
      }));
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      const items = await svc.fetchHotPosts(10);
      expect(items).toEqual([]);
    });

    it('caches results 5min in RSS mode (2nd call without fetch)', async () => {
      installFetchMock([{ status: 200, body: buildListing([buildPost()]) }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      await svc.fetchHotPosts(25);
      const firstCallCount = fetchMock.mock.calls.length;
      await svc.fetchHotPosts(25);
      // 2e call sert depuis le cache → pas de nouveau fetch
      expect(fetchMock.mock.calls.length).toBe(firstCallCount);
    });

    it('records engagement (sum of scores) for sigma rolling window', async () => {
      installFetchMock([{
        status: 200,
        body: buildListing([
          buildPost({ score: 1000 }),
          buildPost({ score: 2000 }),
        ]),
      }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      await svc.fetchHotPosts(25);
      // < 10 samples → sigma null
      expect(svc.getSpikeSigma()).toBeNull();
    });

    it('extracts known tickers from titles ($TSLA + GME)', async () => {
      installFetchMock([{
        status: 200,
        body: buildListing([
          buildPost({ title: '$TSLA upgrade + GME squeeze incoming' }),
        ]),
      }]);
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      const items = await svc.fetchHotPosts(10);
      const symbols = items.flatMap((i) => i.symbols);
      expect(symbols).toContain('TSLA');
      expect(symbols).toContain('GME');
    });

    it('queries 5 subreddits including options + cryptocurrency', async () => {
      installFetchMock(() => ({ status: 200, body: buildListing([buildPost()]) }));
      const svc = await makeService({ REDDIT_USE_RSS: 'true' });
      await svc.fetchHotPosts(25);
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/r/wallstreetbets/'))).toBe(true);
      expect(urls.some((u) => u.includes('/r/CryptoCurrency/'))).toBe(true);
      expect(urls.some((u) => u.includes('/r/options/'))).toBe(true);
      expect(urls.some((u) => u.includes('/r/stocks/'))).toBe(true);
      expect(urls.some((u) => u.includes('/r/investing/'))).toBe(true);
    });
  });
});
