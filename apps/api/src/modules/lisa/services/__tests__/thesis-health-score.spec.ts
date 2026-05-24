import {
  computeSubA,
  computeSubB,
  computeComposite,
  decideVerdict,
  evaluateThesisHealth,
  DEFAULT_WEIGHTS,
} from '../thesis-health-score.helper';

describe('computeSubA — market momentum delta', () => {
  it('momentum perdu 40 % → -0.40 (cas réel BTC 24/5)', () => {
    expect(computeSubA(3.40, 2.04)).toBeCloseTo(-0.40, 2);
  });
  it('momentum stable → 0', () => {
    expect(computeSubA(3.0, 3.0)).toBe(0);
  });
  it('momentum renforcé +50 % → +0.50', () => {
    expect(computeSubA(2.0, 3.0)).toBeCloseTo(0.50, 2);
  });
  it('clamp à -1 si delta extrême', () => {
    expect(computeSubA(3.0, -10)).toBe(-1);
  });
  it('clamp à +1 si delta extrême positif', () => {
    expect(computeSubA(1.0, 10)).toBe(1);
  });
  it('null si entry absent', () => {
    expect(computeSubA(null, 2.0)).toBeNull();
  });
  it('null si now absent', () => {
    expect(computeSubA(3.0, null)).toBeNull();
  });
  it('null si entry ~ 0 (div/0)', () => {
    expect(computeSubA(0, 2.0)).toBeNull();
  });
});

describe('computeSubB — path + persistence delta', () => {
  it('pathEff dégradé 0.614→0.18, persistence 0.83→0.33 → composite négatif', () => {
    const v = computeSubB(0.614, 0.18, 0.83, 0.33);
    expect(v).not.toBeNull();
    // dPath = (0.18-0.614)/0.614 ≈ -0.707 ; dPers = (0.33-0.83)/0.83 ≈ -0.602
    // mean = -0.654, clampé → -0.654
    expect(v!).toBeCloseTo(-0.65, 1);
  });
  it('si seulement pathEff dispo, utilise lui', () => {
    const v = computeSubB(0.5, 0.25, null, null);
    expect(v).toBeCloseTo(-0.50, 2);
  });
  it('si seulement persistence dispo, utilise elle', () => {
    const v = computeSubB(null, null, 0.83, 0.33);
    expect(v).toBeCloseTo(-0.60, 1);
  });
  it('null si rien dispo', () => {
    expect(computeSubB(null, null, null, null)).toBeNull();
  });
  it('clamp à -1 si delta extrême', () => {
    expect(computeSubB(0.9, 0.0, 0.9, 0.0)).toBeCloseTo(-1, 2);
  });
});

describe('computeComposite — agrégation pondérée signed', () => {
  it('3 sub-scores défaut weights 0.40/0.35/0.25', () => {
    const r = computeComposite(-0.5, -0.4, -0.6, DEFAULT_WEIGHTS);
    // 0.40*-0.5 + 0.35*-0.4 + 0.25*-0.6 = -0.20 -0.14 -0.15 = -0.49
    expect(r.composite).toBeCloseTo(-0.49, 2);
    expect(r.weightsUsed.wA).toBeCloseTo(0.40);
    expect(r.weightsUsed.wB).toBeCloseTo(0.35);
    expect(r.weightsUsed.wC).toBeCloseTo(0.25);
  });
  it('subC null → poids redistribués sur A+B', () => {
    const r = computeComposite(-0.5, -0.4, null, DEFAULT_WEIGHTS);
    // sumW = 0.75 ; weights normalisés A=0.40/0.75=0.533, B=0.35/0.75=0.467
    // composite = 0.533*-0.5 + 0.467*-0.4 = -0.267 - 0.187 = -0.453
    expect(r.composite).toBeCloseTo(-0.453, 2);
    expect(r.weightsUsed.wA + r.weightsUsed.wB).toBeCloseTo(1, 2);
    expect(r.weightsUsed.wC).toBe(0);
  });
  it('un seul sub-score dispo → weight 1.0 sur lui', () => {
    const r = computeComposite(-0.7, null, null, DEFAULT_WEIGHTS);
    expect(r.composite).toBeCloseTo(-0.7, 2);
    expect(r.weightsUsed.wA).toBeCloseTo(1);
  });
  it('tous null → composite 0, HOLD par défaut', () => {
    const r = computeComposite(null, null, null);
    expect(r.composite).toBe(0);
  });
});

describe('decideVerdict — seuils', () => {
  it('< -0.60 → CLOSE_NOW', () => {
    expect(decideVerdict(-0.7)).toBe('CLOSE_NOW');
  });
  it('-0.30 .. -0.60 → TIGHTEN_SL', () => {
    expect(decideVerdict(-0.45)).toBe('TIGHTEN_SL');
    expect(decideVerdict(-0.30001)).toBe('TIGHTEN_SL');
  });
  it('-0.30 .. +0.30 → HOLD', () => {
    expect(decideVerdict(0)).toBe('HOLD');
    expect(decideVerdict(-0.29)).toBe('HOLD');
    expect(decideVerdict(0.29)).toBe('HOLD');
  });
  it('+0.30 .. +0.60 → RAISE_TP', () => {
    expect(decideVerdict(0.40)).toBe('RAISE_TP');
  });
  it('> +0.60 → MOMENTUM_RIDE', () => {
    expect(decideVerdict(0.80)).toBe('MOMENTUM_RIDE');
  });
});

describe('evaluateThesisHealth — bout-en-bout (cas réel BTC 24/5)', () => {
  it('cascade SL 24/5 14:17 — verdict aurait été CLOSE_NOW à 13:55', () => {
    // Sub-A : BTC ch1m 3.40 (open 11:08) → 2.04 (13:55) = -40 %
    // Sub-B : pathEff 0.614 → ~0.18, persistence 0.83 → ~0.33 → ~-0.65
    // Sub-C : pas de LLM
    const r = evaluateThesisHealth({
      marketCh1mAtEntry: 3.40,
      marketCh1mNow: 2.04,
      pathEffAtEntry: 0.614,
      pathEffNow: 0.18,
      persistenceAtEntry: 0.83,
      persistenceNow: 0.33,
      llmScore: null,
    });
    // composite : sub_A=-0.40 (poids 0.40) + sub_B=-0.65 (poids 0.35) sans C
    // sumW = 0.75 → normalisé : -0.40*(0.40/0.75) + -0.65*(0.35/0.75)
    //              = -0.40*0.533 + -0.65*0.467 = -0.213 - 0.304 = -0.517
    expect(r.composite).toBeLessThan(-0.30);
    expect(r.composite).toBeGreaterThan(-0.60);
    expect(r.verdict).toBe('TIGHTEN_SL');
    // Donc à 13:55 on aurait tighten_SL → breakeven → -0 % vs -1.5 % réalisé
  });

  it('momentum stable → HOLD', () => {
    const r = evaluateThesisHealth({
      marketCh1mAtEntry: 3.0, marketCh1mNow: 2.95,
      pathEffAtEntry: 0.6, pathEffNow: 0.58,
      persistenceAtEntry: 0.83, persistenceNow: 0.83,
      llmScore: 0,
    });
    expect(r.verdict).toBe('HOLD');
  });

  it('momentum très renforcé + Gemini bullish → MOMENTUM_RIDE', () => {
    const r = evaluateThesisHealth({
      marketCh1mAtEntry: 3.0, marketCh1mNow: 6.0,
      pathEffAtEntry: 0.6, pathEffNow: 0.85,
      persistenceAtEntry: 0.67, persistenceNow: 1.0,
      llmScore: 1.0,
    });
    expect(r.composite).toBeGreaterThan(0.60);
    expect(r.verdict).toBe('MOMENTUM_RIDE');
  });

  it('sub-scores partiels (pas de market proxy) → calcule sur B+C uniquement', () => {
    const r = evaluateThesisHealth({
      marketCh1mAtEntry: null, marketCh1mNow: null,
      pathEffAtEntry: 0.6, pathEffNow: 0.2,
      persistenceAtEntry: 0.83, persistenceNow: 0.17,
      llmScore: -0.5,
    });
    expect(r.subA).toBeNull();
    expect(r.subB).not.toBeNull();
    expect(r.subC).toBe(-0.5);
    expect(r.composite).toBeLessThan(0);
    expect(r.weightsUsed.wA).toBe(0);
  });

  it('tout null → HOLD safe default', () => {
    const r = evaluateThesisHealth({
      marketCh1mAtEntry: null, marketCh1mNow: null,
      pathEffAtEntry: null, pathEffNow: null,
      persistenceAtEntry: null, persistenceNow: null,
      llmScore: null,
    });
    expect(r.composite).toBe(0);
    expect(r.verdict).toBe('HOLD');
  });
});
