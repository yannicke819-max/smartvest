/**
 * Smoke tests pour MistralShadowService.
 * Couvre : disabled state (no key), HTTP success path, HTTP error path,
 * timeout, parse failure. Réseau mocké via fetch global.
 */
import { ConfigService } from '@nestjs/config';
import { MistralShadowService } from '../mistral-shadow.service';

function mockConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string) => (values[key] as unknown) as T,
  } as unknown as ConfigService;
}

describe('MistralShadowService', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('isConfigured=false quand MISTRAL_SHADOW_ENABLED=false', () => {
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'false' }));
    expect(svc.isConfigured()).toBe(false);
  });

  it('isConfigured=false quand MISTRAL_API_KEY absent (même si enabled)', () => {
    const svc = new MistralShadowService(mockConfig({ MISTRAL_SHADOW_ENABLED: 'true' }));
    expect(svc.isConfigured()).toBe(false);
  });

  it('isConfigured=true quand key + flag présents', () => {
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    expect(svc.isConfigured()).toBe(true);
  });

  it('call() retourne error=not_configured sans throw quand disabled', async () => {
    const svc = new MistralShadowService(mockConfig({}));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toBe('not_configured');
    expect(r.content).toBeNull();
    expect(r.costUsd).toBe(0);
  });

  it('call() HTTP 200 — cost via pricing Medium 2505 default ($0.40 in / $2.00 out)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"action_kind":"hold","symbol":null,"confidence":0.5}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_FREE_TIER: 'false' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toBeNull();
    expect(r.content).toContain('hold');
    expect(r.inputTokens).toBe(2_000_000);
    expect(r.outputTokens).toBe(1_000_000);
    // Default = mistral-medium-latest (Medium 2505) → 2M × $0.40/M + 1M × $2.00/M = $0.80 + $2.00 = $2.80
    expect(r.costUsd).toBeCloseTo(2.8, 5);
    expect(r.providerId).toBe('mistral-medium');
    expect(r.model).toBe('mistral-medium-latest');
  });

  it('call() pricing model-aware — Large 3 override via MISTRAL_SHADOW_MODEL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_SHADOW_MODEL: 'mistral-large-latest', MISTRAL_FREE_TIER: 'false' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    // Large 2.x = $2.00 in + $6.00 out → 2M × $2.00 + 1M × $6.00 = $4.00 + $6.00 = $10.00
    expect(r.costUsd).toBeCloseTo(10, 5);
    expect(r.providerId).toBe('mistral-large');
    expect(r.model).toBe('mistral-large-latest');
  });

  it('call() pricing model-aware — Magistral reasoning ($2 in / $5 out)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_SHADOW_MODEL: 'magistral-medium-latest', MISTRAL_FREE_TIER: 'false' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    // Magistral Medium = $2 in + $5 out → 1M × $2 + 1M × $5 = $7
    expect(r.costUsd).toBeCloseTo(7, 5);
    expect(r.providerId).toBe('magistral-medium');
  });

  it('call() pay-as-you-go par défaut (08/06) — costUsd computé depuis les tokens', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    // 08/06 — défaut MISTRAL_FREE_TIER=false → le coût est désormais calculé (panel + budget).
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.inputTokens).toBe(2_000_000);
    expect(r.outputTokens).toBe(1_000_000);
  });

  it('call() MISTRAL_FREE_TIER=true (opt-in crédits gratuits) → costUsd=0', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_FREE_TIER: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.costUsd).toBe(0);
  });

  it('call() HTTP 429 → error capturé, pas de throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toContain('http_429');
    expect(r.content).toBeNull();
  });

  it('call() fetch throws → error capturé sans crash', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toContain('ECONNREFUSED');
    expect(r.content).toBeNull();
  });

  it('call() empty content → error=empty_content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: null } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }),
    });
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toBe('empty_content');
  });

  it('call() request body contient model + messages + temperature', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    });
    global.fetch = fetchMock;
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-key-123', MISTRAL_SHADOW_ENABLED: 'true' }));
    await svc.call({ system: 'sys-prompt', user: 'user-prompt', temperature: 0.7, maxTokens: 800 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-key-123');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('mistral-medium-latest');  // default Medium 3.5 (equivalent qualite Gemini Pro)
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'user-prompt' },
    ]);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(800);
  });

  describe('throttling (minIntervalMs)', () => {
    it('sérialise 3 appels concurrents avec ≥ minIntervalMs entre chaque', async () => {
      const callTimes: number[] = [];
      global.fetch = jest.fn().mockImplementation(async () => {
        callTimes.push(Date.now());
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          text: async () => '',
        } as unknown as Response;
      });
      const svc = new MistralShadowService(
        mockConfig({
          MISTRAL_API_KEY: 'sk-test',
          MISTRAL_SHADOW_ENABLED: 'true',
          MISTRAL_MIN_INTERVAL_MS: '100', // court pour test rapide
          MISTRAL_MAX_QUEUE_WAIT_MS: '60000',
        }),
      );
      const t0 = Date.now();
      await Promise.all([
        svc.call({ system: 's', user: 'u1' }),
        svc.call({ system: 's', user: 'u2' }),
        svc.call({ system: 's', user: 'u3' }),
      ]);
      expect(callTimes).toHaveLength(3);
      // Tolérance ±15ms pour le scheduler
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(85);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(85);
      // Total wall ≥ 2 × minInterval (avant le 1er call = 0, donc 2 intervalles entre 3 calls)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(170);
    });

    it('throttle_timeout si l’attente queue > maxQueueWaitMs', async () => {
      global.fetch = jest.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
        text: async () => '',
      } as unknown as Response));
      const svc = new MistralShadowService(
        mockConfig({
          MISTRAL_API_KEY: 'sk-test',
          MISTRAL_SHADOW_ENABLED: 'true',
          MISTRAL_MIN_INTERVAL_MS: '200', // 200ms entre 2 calls
          MISTRAL_MAX_QUEUE_WAIT_MS: '1000', // queue max 1000ms
        }),
      );
      // 10 calls back-to-back = 200ms × 9 attentes ≈ 1.8s total → certains > 1s queue wait
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => svc.call({ system: 's', user: `u${i}` })),
      );
      const timeouts = results.filter((r) => r.error === 'throttle_timeout').length;
      expect(timeouts).toBeGreaterThan(0);
    });

    it('aucun throttle si minIntervalMs=0 (override pour tests/perf)', async () => {
      const callTimes: number[] = [];
      global.fetch = jest.fn().mockImplementation(async () => {
        callTimes.push(Date.now());
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
          text: async () => '',
        } as unknown as Response;
      });
      const svc = new MistralShadowService(
        mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_MIN_INTERVAL_MS: '0' }),
      );
      await Promise.all([svc.call({ system: 's', user: 'a' }), svc.call({ system: 's', user: 'b' })]);
      // Pas de throttle = appels quasi-simultanés
      expect(callTimes[1] - callTimes[0]).toBeLessThan(50);
    });
  });
});
