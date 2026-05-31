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

  it('call() HTTP 200 — cost via pricing Medium 3.5 default ($1.50 in / $7.50 out)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"action_kind":"hold","symbol":null,"confidence":0.5}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true' }));
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toBeNull();
    expect(r.content).toContain('hold');
    expect(r.inputTokens).toBe(2_000_000);
    expect(r.outputTokens).toBe(1_000_000);
    // Default = mistral-medium-latest → 2M × $1.50/M + 1M × $7.50/M = $3 + $7.50 = $10.50
    expect(r.costUsd).toBeCloseTo(10.5, 5);
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
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_SHADOW_MODEL: 'mistral-large-latest' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    // Large 3 = $0.50 in + $1.50 out → 2M × $0.50 + 1M × $1.50 = $1.00 + $1.50 = $2.50
    expect(r.costUsd).toBeCloseTo(2.5, 5);
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
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_SHADOW_MODEL: 'magistral-medium-latest' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    // Magistral Medium = $2 in + $5 out → 1M × $2 + 1M × $5 = $7
    expect(r.costUsd).toBeCloseTo(7, 5);
    expect(r.providerId).toBe('magistral-medium');
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
});
