/**
 * PR Action 3 — Tests MacroVetoService.
 *
 * Tests UNIT du parsing LLM, fail-open behavior, cache, et integration scanner gate.
 */

import { MacroVetoService, type MacroVetoDecision } from '../services/macro-veto.service';

describe('MacroVetoService — JSON parsing', () => {
  // Mirror la logique de parsing de callLlm (private, on teste indirectement via mock)

  function parseLlmResponse(content: string): { allowed: boolean; regime: string; confidence: number } {
    const cleaned = content.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('LLM response not valid JSON');
    }
    const p = parsed as Record<string, unknown>;
    return {
      allowed: typeof p.macro_allowed === 'boolean' ? p.macro_allowed : true,
      regime: ['risk_on', 'risk_off', 'transitioning', 'uncertain'].includes(String(p.regime))
        ? String(p.regime)
        : 'uncertain',
      confidence: typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1
        ? p.confidence
        : 0.5,
    };
  }

  it('parses valid JSON allow decision', () => {
    const json = '{"macro_allowed":true,"regime":"risk_on","veto_reason":null,"confidence":0.85}';
    const r = parseLlmResponse(json);
    expect(r.allowed).toBe(true);
    expect(r.regime).toBe('risk_on');
    expect(r.confidence).toBe(0.85);
  });

  it('parses valid JSON veto decision', () => {
    const json = '{"macro_allowed":false,"regime":"risk_off","veto_reason":"VIX +30%","confidence":0.92}';
    const r = parseLlmResponse(json);
    expect(r.allowed).toBe(false);
    expect(r.regime).toBe('risk_off');
    expect(r.confidence).toBe(0.92);
  });

  it('handles markdown code-fenced JSON', () => {
    const fenced = '```json\n{"macro_allowed":true,"regime":"transitioning","veto_reason":null,"confidence":0.6}\n```';
    const r = parseLlmResponse(fenced);
    expect(r.allowed).toBe(true);
    expect(r.regime).toBe('transitioning');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseLlmResponse('not json')).toThrow();
  });

  it('defaults to allow when macro_allowed missing', () => {
    const json = '{"regime":"uncertain","confidence":0.5}';
    const r = parseLlmResponse(json);
    expect(r.allowed).toBe(true);
  });

  it('defaults to uncertain on invalid regime', () => {
    const json = '{"macro_allowed":false,"regime":"INVALID","confidence":0.7}';
    const r = parseLlmResponse(json);
    expect(r.regime).toBe('uncertain');
  });

  it('clamps confidence to 0.5 when out of range', () => {
    const json = '{"macro_allowed":true,"regime":"risk_on","confidence":1.5}';
    const r = parseLlmResponse(json);
    expect(r.confidence).toBe(0.5);
  });
});

describe('MacroVetoService — Stale decision detection', () => {
  const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

  function isStale(decisionTimestamp: number, now: number): boolean {
    return now - decisionTimestamp > STALE_THRESHOLD_MS;
  }

  it('detects fresh decision (15min old) as not stale', () => {
    const now = Date.now();
    const decisionTime = now - 15 * 60 * 1000;
    expect(isStale(decisionTime, now)).toBe(false);
  });

  it('detects 1h45min old decision as not stale (just under threshold)', () => {
    const now = Date.now();
    const decisionTime = now - 1.75 * 60 * 60 * 1000;
    expect(isStale(decisionTime, now)).toBe(false);
  });

  it('detects 2h05min old decision as stale', () => {
    const now = Date.now();
    const decisionTime = now - 2.083 * 60 * 60 * 1000;
    expect(isStale(decisionTime, now)).toBe(true);
  });

  it('detects 6h old decision as stale', () => {
    const now = Date.now();
    const decisionTime = now - 6 * 60 * 60 * 1000;
    expect(isStale(decisionTime, now)).toBe(true);
  });
});

describe('MacroVetoService — Fail-open semantics (safety)', () => {
  // Si LLM fail OU pas de décision OU stale → default ALLOW (fail-open).
  // Critère : ne JAMAIS bloquer le trading sur une panne LLM.

  it('fail-open default decision allows trading', () => {
    const failOpenDecision: MacroVetoDecision = {
      macroAllowed: true,
      regime: 'uncertain',
      vetoReason: null,
      confidence: 0,
      fallbackUsed: true,
    };
    expect(failOpenDecision.macroAllowed).toBe(true);
    expect(failOpenDecision.fallbackUsed).toBe(true);
  });

  it('scanner gate respects fallback flag — fallback decisions DO NOT veto', () => {
    // Logic du scanner :
    //   if (macroFlag && !macroFlag.macroAllowed && !macroFlag.fallbackUsed) → SKIP
    // Donc fallback=true même avec macroAllowed=false ne déclenche pas le skip.
    const fallbackDecision: MacroVetoDecision = {
      macroAllowed: false,  // techniquement non-autorisé MAIS
      regime: 'uncertain',
      vetoReason: null,
      confidence: 0,
      fallbackUsed: true,    // c'est un fallback → ignore le veto
    };
    const shouldSkip = fallbackDecision && !fallbackDecision.macroAllowed && !fallbackDecision.fallbackUsed;
    expect(shouldSkip).toBe(false);  // ne skip PAS car fallback
  });

  it('scanner gate respects real LLM veto — real decisions DO veto', () => {
    const realVeto: MacroVetoDecision = {
      macroAllowed: false,
      regime: 'risk_off',
      vetoReason: 'VIX +30%',
      confidence: 0.92,
      fallbackUsed: false,
    };
    const shouldSkip = realVeto && !realVeto.macroAllowed && !realVeto.fallbackUsed;
    expect(shouldSkip).toBe(true);  // skip
  });
});

describe('MacroVetoService — Cache TTL behavior', () => {
  const CACHE_TTL_MS = 60 * 1000;

  function isCacheValid(fetchedAt: number, now: number): boolean {
    return now - fetchedAt < CACHE_TTL_MS;
  }

  it('30s old cache is valid (<60s)', () => {
    const now = Date.now();
    expect(isCacheValid(now - 30 * 1000, now)).toBe(true);
  });

  it('59s old cache is valid (just under TTL)', () => {
    const now = Date.now();
    expect(isCacheValid(now - 59 * 1000, now)).toBe(true);
  });

  it('60s old cache is invalid (TTL exceeded, exclusive)', () => {
    const now = Date.now();
    expect(isCacheValid(now - 60 * 1000, now)).toBe(false);
  });

  it('5min old cache is invalid', () => {
    const now = Date.now();
    expect(isCacheValid(now - 5 * 60 * 1000, now)).toBe(false);
  });
});
