/**
 * ADR-001 Phase 1 (30/04/2026) — Tests for scanner LLM router chain
 * simplification.
 *
 * Per ADR-001 :
 *   - Scanner uses Gemini 2.5 Flash Lite as PRIMARY
 *   - Claude Opus 4.7 as FALLBACK ULTIME ONLY (no intermediate)
 *   - OpenAI + Mistral REMOVED from chain (suppression scope simplification)
 *
 * Cf. docs/decision_records/ADR-001-llm-architecture.md
 */

import { Logger } from '@nestjs/common';
import { ScannerLlmRouterService } from '../services/scanner-llm-router.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

function makeConfig(overrides: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  } as any;
}

describe('ScannerLlmRouterService — ADR-001 Phase 1 chain simplification', () => {
  it('router is INACTIVE when SCANNER_LLM_ROUTER_ENABLED=false (default)', () => {
    const config = makeConfig({
      SCANNER_LLM_ROUTER_ENABLED: 'false',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GEMINI_API_KEY: 'gemini-test-key',
    });
    const svc = new ScannerLlmRouterService(config);
    expect(svc.isEnabled()).toBe(false);
  });

  it('router activates with Gemini + Claude when flag=true and both keys present', () => {
    const config = makeConfig({
      SCANNER_LLM_ROUTER_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GEMINI_API_KEY: 'gemini-test-key',
    });
    const svc = new ScannerLlmRouterService(config);
    expect(svc.isEnabled()).toBe(true);
  });

  it('router activates with Gemini ONLY when ANTHROPIC_API_KEY missing', () => {
    const config = makeConfig({
      SCANNER_LLM_ROUTER_ENABLED: 'true',
      GEMINI_API_KEY: 'gemini-test-key',
    });
    const svc = new ScannerLlmRouterService(config);
    expect(svc.isEnabled()).toBe(true);
  });

  it('router DISABLES when flag=true but GEMINI_API_KEY missing AND ANTHROPIC_API_KEY missing', () => {
    const config = makeConfig({
      SCANNER_LLM_ROUTER_ENABLED: 'true',
    });
    const svc = new ScannerLlmRouterService(config);
    expect(svc.isEnabled()).toBe(false);
  });

  it('call() throws when router disabled', async () => {
    const config = makeConfig({ SCANNER_LLM_ROUTER_ENABLED: 'false' });
    const svc = new ScannerLlmRouterService(config);
    await expect(
      svc.call({ system: 'sys', user: 'usr' } as any),
    ).rejects.toThrow(/router disabled/);
  });

  it('Gemini-only invariant (27/05/2026) : aucune clé Anthropic/OpenAI/Mistral consultée', () => {
    // Chain Gemini-only depuis 27/05 (cf. claude/llm-timeout-30s). Plus de
    // ClaudeProvider en fallback ultime. Le router ne doit consulter QUE
    // GEMINI_API_KEY (+ le flag SCANNER_LLM_ROUTER_ENABLED).
    const calls: string[] = [];
    const config = {
      get: jest.fn((key: string) => {
        calls.push(key);
        if (key === 'SCANNER_LLM_ROUTER_ENABLED') return 'true';
        if (key === 'GEMINI_API_KEY') return 'gemini-test-key';
        return undefined;
      }),
    } as any;
    new ScannerLlmRouterService(config);
    expect(calls).toContain('GEMINI_API_KEY');
    expect(calls).not.toContain('ANTHROPIC_API_KEY');
    expect(calls).not.toContain('OPENAI_API_KEY');
    expect(calls).not.toContain('MISTRAL_API_KEY');
  });
});
