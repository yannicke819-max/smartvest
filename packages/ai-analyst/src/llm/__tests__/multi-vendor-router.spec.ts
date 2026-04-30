/**
 * P17 — Tests MultiVendorLlmRouter — fallback chain, timeout, retry, observability.
 */

import {
  MultiVendorLlmRouter,
  AllProvidersFailedError,
  type MultiVendorCallMetrics,
} from '../multi-vendor-router';
import type { LlmProvider, LlmCallResult, LlmCallParams } from '../providers/types';

function mockProvider(opts: {
  id: string;
  configured?: boolean;
  /** Fonction call() — par défaut renvoie un succès. */
  call?: (params: LlmCallParams) => Promise<LlmCallResult>;
}): LlmProvider {
  const id = opts.id;
  return {
    id,
    model: `${id}-model`,
    isConfigured: () => opts.configured ?? true,
    call:
      opts.call ??
      (async () => ({
        content: `ok-from-${id}`,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0001,
        latencyMs: 250,
        providerId: id,
        model: `${id}-model`,
      })),
  };
}

const PARAMS: LlmCallParams = { system: 'sys', user: 'usr', temperature: 0.2, maxTokens: 256 };

describe('MultiVendorLlmRouter', () => {
  it('uses primary when it succeeds (no fallback)', async () => {
    const primary = mockProvider({ id: 'gemini' });
    const fallback = mockProvider({ id: 'claude' });
    const router = new MultiVendorLlmRouter([primary, fallback]);

    const res = await router.call(PARAMS);
    expect(res.providerId).toBe('gemini');
    expect(res.fallbackUsed).toBe(false);
    expect(res.attemptCount).toBe(1);
  });

  it('falls back to next provider when primary throws', async () => {
    const primary = mockProvider({
      id: 'gemini',
      call: async () => { throw new Error('boom'); },
    });
    const fallback = mockProvider({ id: 'claude' });
    const router = new MultiVendorLlmRouter([primary, fallback], { retriesPerProvider: 0 });

    const res = await router.call(PARAMS);
    expect(res.providerId).toBe('claude');
    expect(res.fallbackUsed).toBe(true);
    expect(res.attemptCount).toBe(2);
  });

  it('cascades through prod chain — Gemini down → reaches Claude (ADR-001 §1.4)', async () => {
    const fail = (id: string) => mockProvider({
      id, call: async () => { throw new Error(`${id} down`); },
    });
    const router = new MultiVendorLlmRouter(
      [fail('gemini'), mockProvider({ id: 'claude' })],
      { retriesPerProvider: 0 },
    );

    const res = await router.call(PARAMS);
    expect(res.providerId).toBe('claude');
    expect(res.attemptCount).toBe(2);
    expect(res.fallbackUsed).toBe(true);
  });

  it('throws AllProvidersFailedError when every provider fails', async () => {
    const fail = (id: string) => mockProvider({
      id, call: async () => { throw new Error(`${id} died`); },
    });
    const router = new MultiVendorLlmRouter(
      [fail('a'), fail('b')],
      { retriesPerProvider: 0 },
    );

    await expect(router.call(PARAMS)).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(router.call(PARAMS)).rejects.toMatchObject({
      errorsByProvider: { a: 'a died', b: 'b died' },
    });
  });

  it('skips unconfigured providers from the chain', () => {
    const router = new MultiVendorLlmRouter([
      mockProvider({ id: 'a', configured: false }),
      mockProvider({ id: 'b', configured: true }),
      mockProvider({ id: 'c', configured: false }),
    ]);
    expect(router.getActiveProviders().map((p) => p.id)).toEqual(['b']);
  });

  it('throws at construction if no provider is configured', () => {
    expect(() =>
      new MultiVendorLlmRouter([mockProvider({ id: 'a', configured: false })]),
    ).toThrow(/no provider is configured/);
  });

  it('respects timeout — slow primary times out, fallback wins', async () => {
    const slow = mockProvider({
      id: 'slow',
      call: () => new Promise<LlmCallResult>((resolve) =>
        setTimeout(
          () => resolve({
            content: 'late', inputTokens: 0, outputTokens: 0, costUsd: 0,
            latencyMs: 1000, providerId: 'slow', model: 'slow-model',
          }),
          200,
        )),
    });
    const fast = mockProvider({ id: 'fast' });
    const router = new MultiVendorLlmRouter([slow, fast], {
      timeoutMs: 50, retriesPerProvider: 0, retryDelayMs: 0,
    });

    const res = await router.call(PARAMS);
    expect(res.providerId).toBe('fast');
  });

  it('retries within same provider before falling back', async () => {
    let attempts = 0;
    const flaky = mockProvider({
      id: 'flaky',
      call: async () => {
        attempts++;
        if (attempts < 2) throw new Error('transient');
        return {
          content: 'ok', inputTokens: 0, outputTokens: 0, costUsd: 0,
          latencyMs: 10, providerId: 'flaky', model: 'flaky-model',
        };
      },
    });
    const router = new MultiVendorLlmRouter([flaky], {
      retriesPerProvider: 2, retryDelayMs: 0,
    });

    const res = await router.call(PARAMS);
    expect(res.providerId).toBe('flaky');
    expect(attempts).toBe(2); // 1 fail + 1 success
  });

  it('emits onCall metrics with fallbackUsed flag', async () => {
    const events: MultiVendorCallMetrics[] = [];
    const router = new MultiVendorLlmRouter(
      [
        mockProvider({ id: 'a', call: async () => { throw new Error('x'); } }),
        mockProvider({ id: 'b' }),
      ],
      { retriesPerProvider: 0, onCall: (m) => events.push(m) },
    );

    await router.call(PARAMS);
    expect(events).toHaveLength(1);
    expect(events[0].providerId).toBe('b');
    expect(events[0].fallbackUsed).toBe(true);
    expect(events[0].errorsByProvider.a).toContain('x');
  });

  it('emits onCall with providerId="none" when all fail', async () => {
    const events: MultiVendorCallMetrics[] = [];
    const router = new MultiVendorLlmRouter(
      [mockProvider({ id: 'a', call: async () => { throw new Error('1'); } })],
      { retriesPerProvider: 0, onCall: (m) => events.push(m) },
    );

    await expect(router.call(PARAMS)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(events[0].providerId).toBe('none');
  });
});
