import {
  buildGeminiVerdictUserPrompt,
  parseGeminiVerdict,
} from '../gemini-thesis-verdict.helper';

describe('buildGeminiVerdictUserPrompt', () => {
  it('inclut toutes les features quand dispos', () => {
    const p = buildGeminiVerdictUserPrompt({
      symbol: 'BTCUSDT',
      assetClass: 'crypto_major',
      openedAt: '2026-05-24T11:08:00Z',
      ageMinutes: 187,
      entryPrice: 77188,
      livePrice: 76381,
      unrealPnlPct: -1.05,
      pathEffAtEntry: 0.614,
      pathEffNow: 0.18,
      persistenceAtEntry: 0.83,
      persistenceNow: 0.33,
      marketCh1mAtEntry: 3.40,
      marketCh1mNow: 1.46,
      tpDistancePct: 4.0,
      slDistancePct: -0.5,
    });
    expect(p).toContain('BTCUSDT');
    expect(p).toContain('crypto_major');
    expect(p).toContain('Entry: $77188');
    expect(p).toContain('PathEff: 0.614 → 0.180');
    expect(p).toContain('Persistence: 0.83 → 0.33');
    expect(p).toContain('3.40% → 1.46%');
    expect(p).toContain('TP: 4.00%');
    expect(p).toContain('SL: -0.50%');
  });

  it('omet gracefully les features null', () => {
    const p = buildGeminiVerdictUserPrompt({
      symbol: 'AAPL',
      assetClass: 'us_equity_large',
      openedAt: '2026-05-24T15:00:00Z',
      ageMinutes: 30,
      entryPrice: 200,
      livePrice: 198,
      unrealPnlPct: -1,
      pathEffAtEntry: null,
      pathEffNow: null,
      persistenceAtEntry: null,
      persistenceNow: null,
      marketCh1mAtEntry: null,
      marketCh1mNow: null,
      tpDistancePct: null,
      slDistancePct: null,
    });
    expect(p).not.toContain('PathEff');
    expect(p).not.toContain('Persistence');
    expect(p).not.toContain('Market proxy');
    expect(p).toContain('AAPL');
  });
});

describe('parseGeminiVerdict', () => {
  it('parse réponse JSON propre', () => {
    const r = parseGeminiVerdict('{"score": -0.5, "rationale": "Momentum BTC perdu, tighten recommandé"}');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(-0.5);
    expect(r!.rationale).toBe('Momentum BTC perdu, tighten recommandé');
  });

  it('clamp score hors range', () => {
    expect(parseGeminiVerdict('{"score": -2.5, "rationale": "x"}')!.score).toBe(-1);
    expect(parseGeminiVerdict('{"score": 5, "rationale": "x"}')!.score).toBe(1);
  });

  it('extrait JSON entouré de markdown / texte', () => {
    const r = parseGeminiVerdict('```json\n{"score": 0.7, "rationale": "Strong"}\n```\nExplication...');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0.7);
  });

  it('coupe rationale à 200 chars', () => {
    const long = 'A'.repeat(300);
    const r = parseGeminiVerdict(`{"score": 0, "rationale": "${long}"}`);
    expect(r!.rationale.length).toBe(200);
  });

  it('null si pas de JSON', () => {
    expect(parseGeminiVerdict('Hello, here is my answer: bearish')).toBeNull();
  });

  it('null si score absent', () => {
    expect(parseGeminiVerdict('{"rationale": "no score"}')).toBeNull();
  });

  it('null si score NaN', () => {
    expect(parseGeminiVerdict('{"score": "abc", "rationale": "x"}')).toBeNull();
  });

  it('null si content vide', () => {
    expect(parseGeminiVerdict('')).toBeNull();
    expect(parseGeminiVerdict('   ')).toBeNull();
  });

  it('null si JSON incomplet', () => {
    expect(parseGeminiVerdict('{"score": 0.5, "rationale"')).toBeNull();
  });

  it('rationale optionnel → string vide ok', () => {
    const r = parseGeminiVerdict('{"score": 0.3}');
    expect(r).not.toBeNull();
    expect(r!.rationale).toBe('');
  });
});
