/**
 * Smoke tests pour MistralLargeShadowService (PR #521).
 * Test minimal qui valide le service cheap tier Mistral Large 3 :
 * - isConfigured selon flag dédié MISTRAL_LARGE_SHADOW_ENABLED (distinct de MISTRAL_SHADOW_ENABLED)
 * - Pricing hardcoded Large 3 ($0.50/$1.50)
 * - Best-effort (jamais throw, error captured)
 */
import { ConfigService } from '@nestjs/config';
import { MistralLargeShadowService } from '../mistral-large-shadow.service';

function mockConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string) => (values[key] as unknown) as T,
  } as unknown as ConfigService;
}

describe('MistralLargeShadowService (PR #521 cheap tier)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('isConfigured=false sans flag MISTRAL_LARGE_SHADOW_ENABLED', () => {
    const svc = new MistralLargeShadowService(mockConfig({ MISTRAL_API_KEY: 'sk-test' }));
    expect(svc.isConfigured()).toBe(false);
  });

  it('isConfigured=false avec flag mais sans MISTRAL_API_KEY', () => {
    const svc = new MistralLargeShadowService(mockConfig({ MISTRAL_LARGE_SHADOW_ENABLED: 'true' }));
    expect(svc.isConfigured()).toBe(false);
  });

  it('isConfigured=true avec flag + key', () => {
    const svc = new MistralLargeShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_LARGE_SHADOW_ENABLED: 'true' }),
    );
    expect(svc.isConfigured()).toBe(true);
  });

  it('flag indépendant de MISTRAL_SHADOW_ENABLED (Medium)', () => {
    // Medium ON, Large OFF → Large inerte (et inversement)
    const svcLargeOff = new MistralLargeShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'true', MISTRAL_LARGE_SHADOW_ENABLED: 'false' }),
    );
    expect(svcLargeOff.isConfigured()).toBe(false);

    const svcLargeOn = new MistralLargeShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_SHADOW_ENABLED: 'false', MISTRAL_LARGE_SHADOW_ENABLED: 'true' }),
    );
    expect(svcLargeOn.isConfigured()).toBe(true);
  });

  it('call() pricing hardcoded Large 3 ($0.50 in / $1.50 out)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"action_kind":"hold"}' } }],
        usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
      }),
    });
    const svc = new MistralLargeShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_LARGE_SHADOW_ENABLED: 'true' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toBeNull();
    // 2M × $0.50/M + 1M × $1.50/M = $1.00 + $1.50 = $2.50
    expect(r.costUsd).toBeCloseTo(2.5, 5);
    expect(r.providerId).toBe('mistral-large');
    expect(r.model).toBe('mistral-large-latest');
  });

  it('call() best-effort sur HTTP 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    const svc = new MistralLargeShadowService(
      mockConfig({ MISTRAL_API_KEY: 'sk-test', MISTRAL_LARGE_SHADOW_ENABLED: 'true' }),
    );
    const r = await svc.call({ system: 's', user: 'u' });
    expect(r.error).toContain('http_500');
    expect(r.content).toBeNull();
  });

  it('call() request body hardcode model=mistral-large-latest (pas configurable)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    });
    global.fetch = fetchMock;
    // Note : MISTRAL_SHADOW_MODEL n'a aucun effet sur ce service (toujours Large 3)
    const svc = new MistralLargeShadowService(
      mockConfig({
        MISTRAL_API_KEY: 'sk-test',
        MISTRAL_LARGE_SHADOW_ENABLED: 'true',
        MISTRAL_SHADOW_MODEL: 'mistral-medium-latest',  // doit etre ignore
      }),
    );
    await svc.call({ system: 's', user: 'u' });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('mistral-large-latest');
  });
});
