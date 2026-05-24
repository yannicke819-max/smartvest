import {
  buildEarlyExitUserPrompt,
  parseEarlyExitVerdict,
  type EarlyExitInput,
} from '../early-exit-guard.helper';

const sample: EarlyExitInput = {
  symbol: 'SOLUSDT',
  direction: 'long',
  ageMinutes: 7,
  entryPrice: 86.18,
  livePrice: 85.40,
  ch1mAtEntry: 4.83,
  ch1mNow: 1.20,
  pathEffAtEntry: 0.56,
  unrealizedPct: -0.9,
  slDistancePct: -0.6,
  tpDistancePct: 2.4,
};

describe('buildEarlyExitUserPrompt', () => {
  it('inclut symbol, direction, entry, live, ch1m, distances', () => {
    const p = buildEarlyExitUserPrompt(sample);
    expect(p).toContain('SOLUSDT');
    expect(p).toContain('LONG');
    expect(p).toContain('Age: 7 min');
    expect(p).toContain('$86.18');
    expect(p).toContain('$85.40');
    expect(p).toContain('-0.90%');
    expect(p).toContain('4.83%');
    expect(p).toContain('1.20%');
  });

  it('omet les champs null gracefully', () => {
    const p = buildEarlyExitUserPrompt({
      ...sample, ch1mAtEntry: null, ch1mNow: null, pathEffAtEntry: null,
      slDistancePct: null, tpDistancePct: null,
    });
    expect(p).not.toContain('Momentum');
    expect(p).not.toContain('PathEff');
    expect(p).not.toContain('Distance SL');
    expect(p).toContain('SOLUSDT');
  });

  it('SHORT direction', () => {
    const p = buildEarlyExitUserPrompt({ ...sample, direction: 'short' });
    expect(p).toContain('Direction: SHORT');
  });
});

describe('parseEarlyExitVerdict', () => {
  it('parse FADE valide', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({
      decision: 'FADE',
      rationale: 'Momentum BTC perdu 75%, ch1m de 4.83 à 1.20, sortir avant SL',
    }));
    expect(r!.decision).toBe('FADE');
    expect(r!.rationale).toContain('Momentum');
  });
  it('parse HOLD valide', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({ decision: 'HOLD', rationale: 'momentum stable' }));
    expect(r!.decision).toBe('HOLD');
  });
  it('decision lowercase → uppercase', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({ decision: 'fade', rationale: 'x' }));
    expect(r!.decision).toBe('FADE');
  });
  it('decision inconnue → HOLD par défaut (safe)', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({ decision: 'UNKNOWN', rationale: 'x' }));
    expect(r!.decision).toBe('HOLD');
  });
  it('JSON dans markdown extrait', () => {
    const r = parseEarlyExitVerdict('```json\n{"decision":"FADE","rationale":"x"}\n```');
    expect(r!.decision).toBe('FADE');
  });
  it('rationale tronquée à 200 chars', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({
      decision: 'FADE',
      rationale: 'A'.repeat(500),
    }));
    expect(r!.rationale.length).toBe(200);
  });
  it('null si pas JSON', () => {
    expect(parseEarlyExitVerdict('bearish')).toBeNull();
    expect(parseEarlyExitVerdict('')).toBeNull();
  });
  it('null si JSON invalide', () => {
    expect(parseEarlyExitVerdict('{"decision"')).toBeNull();
  });
  it('JSON avec strings contenant braces', () => {
    const r = parseEarlyExitVerdict(JSON.stringify({
      decision: 'FADE',
      rationale: 'Pattern { fakeBraces } detected',
    }));
    expect(r!.decision).toBe('FADE');
    expect(r!.rationale).toContain('fakeBraces');
  });
});
