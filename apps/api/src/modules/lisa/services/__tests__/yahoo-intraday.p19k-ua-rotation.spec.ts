/**
 * P19k / Bug #C (13/05/2026) — Tests UA rotation + single-shot retry sur 429.
 *
 * Contexte : Yahoo maintient une blocklist UA statique. Le UA prod
 * (Chrome 120 Linux x86_64, PR #268) est banni → 100% des requêtes 429
 * depuis le 7 mai 2026. Fix : pool de 4 UAs validés 200 OK + rotation
 * round-robin + 1 retry sur 429 avec UA suivant.
 *
 * Comportement attendu :
 *   - 3 appels successifs envoient 3 UA différents (round-robin)
 *   - 429 first + 200 retry : fetch 2x avec UA différents, circuit fermé, non-null
 *   - 429 + 429 : openCircuit appelé 1x (raison "HTTP 429 after UA rotation retry")
 *   - 200 first : pas de retry, 1 seul fetch, circuit fermé
 *   - 403 first : pas de retry, openCircuit immédiate (P19h inchangé)
 *   - 404 first : silent null sans trip
 *   - DEFAULT_BASE_COOLDOWN_MS = 15s (était 60s avant Bug #C)
 */

import { Logger } from '@nestjs/common';
import { YahooIntradayService } from '../yahoo-intraday.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});
beforeEach(() => {
  warnSpy.mockClear();
  logSpy.mockClear();
});

type FetchCall = { url: string; userAgent: string };

/**
 * Mock fetch qui capture les User-Agent envoyés + permet de répondre
 * statiquement OU séquentiellement selon les besoins du test.
 */
function captureFetch(responses: Array<{ status: number; ok: boolean; body?: unknown }>): {
  fetchMock: jest.Mock;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fetchMock = jest.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const ua = (init.headers as Record<string, string>)?.['User-Agent'] ?? '<none>';
    calls.push({ url, userAgent: ua });
    const r = responses[Math.min(idx++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => '',
    };
  });
  global.fetch = fetchMock as never;
  return { fetchMock, calls };
}

function okBody(closes: number[] = [180, 181, 182]) {
  const baseTs = 1761830400;
  return {
    chart: {
      result: [{
        meta: { symbol: 'AAPL' },
        timestamp: closes.map((_, i) => baseTs + i * 300),
        indicators: { quote: [{ close: closes, open: closes, high: closes, low: closes, volume: closes.map(() => 1000) }] },
      }],
      error: null,
    },
  };
}

describe('Bug #C / P19k — UA rotation round-robin', () => {
  it('3 appels successifs envoient 3 UA différents (pool round-robin)', async () => {
    const { calls } = captureFetch([
      { ok: true, status: 200, body: okBody() },
      { ok: true, status: 200, body: okBody() },
      { ok: true, status: 200, body: okBody() },
    ]);
    const svc = new YahooIntradayService();

    await svc.getCandles('AAPL.US', '5m');
    await svc.getCandles('MSFT.US', '5m');
    await svc.getCandles('GOOG.US', '5m');

    expect(calls).toHaveLength(3);
    const uas = calls.map((c) => c.userAgent);
    // 3 UA distincts
    expect(new Set(uas).size).toBe(3);
    // Tous non-vides + structure UA (vérif minimale)
    for (const ua of uas) {
      expect(ua).toMatch(/Mozilla\/5\.0/);
    }
  });

  it('appel 1 = UA[0], appel 2 = UA[1], etc. (ordre round-robin déterministe)', async () => {
    const { calls } = captureFetch([
      { ok: true, status: 200, body: okBody() },
      { ok: true, status: 200, body: okBody() },
    ]);
    const svc = new YahooIntradayService();

    await svc.getCandles('AAPL.US', '5m');
    await svc.getCandles('MSFT.US', '5m');

    expect(calls[0].userAgent).not.toBe(calls[1].userAgent);
  });

  it('pool de 4 UAs : appel 5 reprend le UA du appel 1 (modulo 4)', async () => {
    const { calls } = captureFetch(Array(5).fill({ ok: true, status: 200, body: okBody() }));
    const svc = new YahooIntradayService();

    for (let i = 0; i < 5; i++) {
      await svc.getCandles(`AAPL.US`, '5m');
    }

    expect(calls).toHaveLength(5);
    // Call 5 wraps around to UA[0] (= same as call 1)
    expect(calls[4].userAgent).toBe(calls[0].userAgent);
  });
});

describe('Bug #C / P19k — single-shot retry sur 429', () => {
  it('429 first + 200 retry : fetch 2x avec UA différents, circuit reste fermé, return non-null', async () => {
    const { calls } = captureFetch([
      { ok: false, status: 429 },           // attempt 1: 429
      { ok: true, status: 200, body: okBody() },  // retry: 200 OK
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(2);
    // UA différents entre l'attempt 1 et la retry
    expect(calls[0].userAgent).not.toBe(calls[1].userAgent);
    // Circuit reste fermé après succès retry
    expect(svc.getCircuitStatus().state).toBe('closed');
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
  });

  it('429 + 429 (double échec) : openCircuit appelé 1x avec raison Bug #C', async () => {
    const { calls } = captureFetch([
      { ok: false, status: 429 },
      { ok: false, status: 429 },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().openCount).toBe(1);
    // Raison logs : "HTTP 429 after UA rotation retry"
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0] ?? ''));
    expect(warnCalls.some((m) => m.includes('HTTP 429 after UA rotation retry'))).toBe(true);
  });

  it('200 first : pas de retry, 1 seul fetch, circuit fermé', async () => {
    const { calls } = captureFetch([
      { ok: true, status: 200, body: okBody() },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);  // PAS de retry sur 200 first
    expect(svc.getCircuitStatus().state).toBe('closed');
  });

  it('403 first : pas de retry, openCircuit immédiate (P19h inchangé)', async () => {
    const { calls } = captureFetch([
      { ok: false, status: 403 },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);  // PAS de retry sur 403 (seul 429 trigger retry)
    expect(svc.getCircuitStatus().state).toBe('open');
    expect(svc.getCircuitStatus().openCount).toBe(1);
    // Message log = "HTTP 403", pas "after UA rotation retry"
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0] ?? ''));
    expect(warnCalls.some((m) => m.includes('HTTP 403'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('after UA rotation retry'))).toBe(false);
  });

  it('500 first : pas de retry, openCircuit immédiate', async () => {
    const { calls } = captureFetch([
      { ok: false, status: 500 },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(svc.getCircuitStatus().state).toBe('open');
  });

  it('404 first (ticker unknown) : pas de retry, silent null, circuit reste fermé', async () => {
    const { calls } = captureFetch([
      { ok: false, status: 404 },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('AAPL.US', '5m');

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(svc.getCircuitStatus().state).toBe('closed');  // PAS trip
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
  });

  it('chart.error (symbol not found) : pas de retry, silent null, circuit fermé', async () => {
    const { calls } = captureFetch([
      { ok: true, status: 200, body: { chart: { error: { code: 'Not Found', description: 'No data' } } } },
    ]);
    const svc = new YahooIntradayService();

    const result = await svc.getCandles('UNKNOWN.US', '5m');

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(svc.getCircuitStatus().state).toBe('closed');
  });

  it('429 retry returns 200 → consecutiveFailures reste à 0 (success path)', async () => {
    captureFetch([
      { ok: false, status: 429 },
      { ok: true, status: 200, body: okBody() },
    ]);
    const svc = new YahooIntradayService();

    await svc.getCandles('AAPL.US', '5m');

    // closeCircuitOnSuccess reset consecutiveFailures even si le primary a "échoué"
    expect(svc.getCircuitStatus().consecutiveFailures).toBe(0);
    expect(svc.getCircuitStatus().state).toBe('closed');
  });
});

describe('Bug #C / P19k — DEFAULT_BASE_COOLDOWN_MS reduced to 15s', () => {
  it('1st failure cooldown ~15s (was 60s avant Bug #C)', async () => {
    jest.useFakeTimers();
    captureFetch([
      { ok: false, status: 403 },  // 403 → open immédiat sans retry
    ]);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');

    const status = svc.getCircuitStatus();
    expect(status.state).toBe('open');
    // openUntilMs - Date.now() ~ 15_000 ms (1st failure, no backoff exp yet)
    const remainMs = status.openUntilMs - Date.now();
    expect(remainMs).toBeGreaterThan(14_000);
    expect(remainMs).toBeLessThanOrEqual(15_000);
  });

  it('2nd failure cooldown ~30s (exp backoff base*2)', async () => {
    jest.useFakeTimers();
    // First failure : 15s
    captureFetch([{ ok: false, status: 403 }]);
    const svc = new YahooIntradayService();
    await svc.getCandles('AAPL.US', '5m');

    // Advance past 15s cooldown to allow probe
    jest.advanceTimersByTime(16_000);

    // Probe failure (2nd consecutive)
    captureFetch([{ ok: false, status: 403 }]);
    await svc.getCandles('AAPL.US', '5m');

    const status = svc.getCircuitStatus();
    expect(status.state).toBe('open');
    expect(status.consecutiveFailures).toBe(2);
    const remainMs = status.openUntilMs - Date.now();
    // ~30s (15_000 * 2^1)
    expect(remainMs).toBeGreaterThan(28_000);
    expect(remainMs).toBeLessThanOrEqual(30_000);
  });
});

describe('Bug #C / P19k — regression toYahooSymbol mapping (sanity)', () => {
  // Vérifie que le mapping n'a pas été touché par les changements UA
  it('AAPL.US → AAPL (US suffix stripped)', () => {
    const svc = new YahooIntradayService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).toYahooSymbol('AAPL.US')).toBe('AAPL');
  });

  it('199820.KO → 199820.KS (KO → KS)', () => {
    const svc = new YahooIntradayService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).toYahooSymbol('199820.KO')).toBe('199820.KS');
  });
});
