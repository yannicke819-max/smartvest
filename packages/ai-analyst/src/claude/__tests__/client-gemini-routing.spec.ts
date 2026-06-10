/**
 * LisaClaudeClient — tests de routing provider (Gemini ↔ Claude).
 *
 * Couvre la logique de sélection du provider effectif au constructeur :
 *  - 'gemini' sans apiKey → fallback claude (avec warn)
 *  - 'gemini' avec apiKey → effective gemini
 *  - 'claude' explicite → effective claude (même si gemini key dispo)
 *  - défaut sans config → claude
 *  - pricing Gemini Pro = $1.25 input + $10 output par 1M
 */

import { LisaClaudeClient } from '../client';
import type { LlmRouter } from '../../llm';

describe('LisaClaudeClient — provider routing', () => {
  // Router stub minimal — on ne l'appelle pas, on vérifie juste la décision provider
  const stubRouter = {} as LlmRouter;
  const origDisabled = process.env.GEMINI_DISABLED;
  const restore = (): void => {
    if (origDisabled === undefined) delete process.env.GEMINI_DISABLED;
    else process.env.GEMINI_DISABLED = origDisabled;
  };

  // ── Kill-switch par défaut (GEMINI_DISABLED non posé = Gemini OFF) ──────────
  describe('Gemini désactivé par défaut → tout en Claude', () => {
    beforeEach(() => { delete process.env.GEMINI_DISABLED; });
    afterEach(restore);

    it('défaut sans gemini config → claude', () => {
      const client = new LisaClaudeClient(stubRouter);
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('claude');
    });

    it('apiKey gemini fourni → claude quand même (kill global) + warn', () => {
      const warn = jest.fn();
      const client = new LisaClaudeClient(stubRouter, { apiKey: 'fake-key', logger: { warn } });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('claude');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('GEMINI_DISABLED'));
    });

    it('provider=gemini explicite + apiKey → claude quand même (kill global)', () => {
      const client = new LisaClaudeClient(stubRouter, { apiKey: 'fake-key', provider: 'gemini' });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('claude');
    });
  });

  // ── Routing legacy quand Gemini est explicitement réactivé ─────────────────
  describe('GEMINI_DISABLED=false → routing legacy', () => {
    beforeEach(() => { process.env.GEMINI_DISABLED = 'false'; });
    afterEach(restore);

    it('provider=gemini sans apiKey → fallback claude + warn', () => {
      const warn = jest.fn();
      const client = new LisaClaudeClient(stubRouter, { provider: 'gemini', logger: { warn } });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('claude');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('LISA_PROPOSAL_PROVIDER=gemini'));
    });

    it('provider=gemini avec apiKey → effective gemini', () => {
      const client = new LisaClaudeClient(stubRouter, { apiKey: 'fake-key', provider: 'gemini' });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('gemini');
    });

    it('provider=claude explicite + apiKey gemini dispo → claude', () => {
      const client = new LisaClaudeClient(stubRouter, { apiKey: 'fake-key', provider: 'claude' });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('claude');
    });

    it('apiKey gemini fourni sans provider explicite → gemini (default legacy)', () => {
      const client = new LisaClaudeClient(stubRouter, { apiKey: 'fake-key' });
      // @ts-expect-error — accès propriété privée pour test
      expect(client.effectiveProvider).toBe('gemini');
    });
  });
});

describe('LisaClaudeClient.estimateCostUsdGemini — pricing', () => {
  it('Gemini Pro = $1.25 input + $10 output par 1M tokens', () => {
    // 1M input + 1M output = $1.25 + $10 = $11.25
    const cost = LisaClaudeClient.estimateCostUsdGemini(1_000_000, 1_000_000, 'gemini-2.5-pro');
    expect(cost).toBeCloseTo(11.25, 4);
  });

  it('Gemini Flash = $0.30 input + $2.50 output par 1M', () => {
    const cost = LisaClaudeClient.estimateCostUsdGemini(1_000_000, 1_000_000, 'gemini-2.5-flash');
    expect(cost).toBeCloseTo(2.80, 4);
  });

  it('Gemini Flash-Lite = $0.10 input + $0.40 output par 1M', () => {
    const cost = LisaClaudeClient.estimateCostUsdGemini(1_000_000, 1_000_000, 'gemini-2.5-flash-lite');
    expect(cost).toBeCloseTo(0.50, 4);
  });

  it('Économie ×10 vs Claude Opus sur usage typique (30k input + 5k output)', () => {
    const opusCost = LisaClaudeClient.estimateCostUsd({
      inputTokens: 30_000,
      outputTokens: 5_000,
    });
    const geminiCost = LisaClaudeClient.estimateCostUsdGemini(
      30_000,
      5_000,
      'gemini-2.5-pro',
    );
    // Opus = 30k * $15/1M + 5k * $75/1M = $0.45 + $0.375 = $0.825
    // Gemini Pro = 30k * $1.25/1M + 5k * $10/1M = $0.0375 + $0.05 = $0.0875
    // Ratio ~9.4× (proche du ×10 attendu)
    expect(opusCost / geminiCost).toBeGreaterThan(8);
    expect(opusCost / geminiCost).toBeLessThan(11);
  });
});
