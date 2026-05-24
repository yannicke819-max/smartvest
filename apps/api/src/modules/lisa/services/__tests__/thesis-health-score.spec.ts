import {
  computeSubA,
  computeSubB,
  computeComposite,
  decideVerdict,
  evaluateThesisHealth,
  decideSizingMultiplier,
  parseConvictionSizingConfig,
  computeEntryConvictionScore,
  DEFAULT_WEIGHTS,
  DEFAULT_CONVICTION_SIZING,
} from '../thesis-health-score.helper';

describe('computeEntryConvictionScore', () => {
  it('A+ setup (pathEff 0.85, persist 0.83, ch1m 4.5%) → score positif élevé', () => {
    const s = computeEntryConvictionScore({ pathEff: 0.85, persistence: 0.83, ch1mPct: 4.5 });
    // pathEff norm = (0.85-0.55)/0.30 = 1.0
    // persist norm = (0.83-0.50)/0.30 = 1.1 clamp 1.0
    // ch1m norm = 4.5/5 = 0.9
    // avg = (1.0 + 1.0 + 0.9) / 3 = 0.967
    expect(s).toBeCloseTo(0.967, 2);
  });
  it('Setup moyen (pathEff 0.55, persist 0.50, ch1m 3.0) → ~0', () => {
    const s = computeEntryConvictionScore({ pathEff: 0.55, persistence: 0.50, ch1mPct: 3.0 });
    // pathEff norm = 0, persist norm = 0, ch1m norm = 3/5 = 0.6
    // avg = 0.2
    expect(s).toBeCloseTo(0.2, 2);
  });
  it('Setup faible (pathEff 0.30, persist 0.20, ch1m 1.0) → score négatif', () => {
    const s = computeEntryConvictionScore({ pathEff: 0.30, persistence: 0.20, ch1mPct: 1.0 });
    expect(s).toBeLessThan(-0.3);
  });
  it('Toutes features null → 0', () => {
    expect(computeEntryConvictionScore({ pathEff: null, persistence: null, ch1mPct: null })).toBe(0);
  });
  it('Partial (seulement ch1m) → utilise les dispos', () => {
    const s = computeEntryConvictionScore({ pathEff: null, persistence: null, ch1mPct: 5.0 });
    expect(s).toBeCloseTo(1.0, 2);
  });
  it('Cas réel SOLUSDT 24/05 (pathEff 0.560, persist 0.83, ch1m 4.83%) → score positif', () => {
    const s = computeEntryConvictionScore({ pathEff: 0.560, persistence: 0.83, ch1mPct: 4.83 });
    // pathEff norm = (0.56-0.55)/0.30 = 0.033
    // persist norm = 1.1 clamp 1.0
    // ch1m norm = 4.83/5 = 0.966
    // avg = 0.666 → A+ tier (selon DEFAULT_CONVICTION_SIZING highThreshold 0.60)
    expect(s).toBeGreaterThan(0.6);
  });
});

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

describe('decideSizingMultiplier — sizing calibré conviction', () => {
  it('composite < 0 → 0 (SKIP) par défaut', () => {
    expect(decideSizingMultiplier(-0.5)).toBe(0);
    expect(decideSizingMultiplier(-0.01)).toBe(0);
  });
  it('composite ∈ [0, 0.30) → multLow 0.7', () => {
    expect(decideSizingMultiplier(0)).toBe(0.7);
    expect(decideSizingMultiplier(0.15)).toBe(0.7);
    expect(decideSizingMultiplier(0.299)).toBe(0.7);
  });
  it('composite ∈ [0.30, 0.60] → 1.0 (standard)', () => {
    expect(decideSizingMultiplier(0.30)).toBe(1.0);
    expect(decideSizingMultiplier(0.45)).toBe(1.0);
    expect(decideSizingMultiplier(0.60)).toBe(1.0);
  });
  it('composite > 0.60 → multHigh 1.5', () => {
    expect(decideSizingMultiplier(0.601)).toBe(1.5);
    expect(decideSizingMultiplier(0.75)).toBe(1.5);
    expect(decideSizingMultiplier(1.0)).toBe(1.5);
  });
  it('null / NaN → 1.0 (fallback sizing standard, back-compat safe)', () => {
    expect(decideSizingMultiplier(null)).toBe(1.0);
    expect(decideSizingMultiplier(NaN)).toBe(1.0);
  });
  it('skipIfNegative=false → composite négatif applique multLow', () => {
    const cfg = { ...DEFAULT_CONVICTION_SIZING, skipIfNegative: false };
    expect(decideSizingMultiplier(-0.5, cfg)).toBe(cfg.multLow);
  });
  it('config custom : multHigh 2.0', () => {
    const cfg = { ...DEFAULT_CONVICTION_SIZING, multHigh: 2.0 };
    expect(decideSizingMultiplier(0.8, cfg)).toBe(2.0);
  });
  it('maxMultiplier clamp : pas plus haut que cap', () => {
    const cfg = { ...DEFAULT_CONVICTION_SIZING, multHigh: 5.0, maxMultiplier: 2.0 };
    expect(decideSizingMultiplier(0.8, cfg)).toBe(2.0);
  });
  it('cas réel : composite +0.7 (A+ setup) → 1.5× sizing', () => {
    expect(decideSizingMultiplier(0.7)).toBe(1.5);
  });
  it('cas réel : composite +0.15 (conviction moyenne) → 0.7× sizing', () => {
    expect(decideSizingMultiplier(0.15)).toBe(0.7);
  });
  it('cas réel : composite -0.5 (thèse déjà cassée à entry) → SKIP', () => {
    expect(decideSizingMultiplier(-0.5)).toBe(0);
  });
});

describe('parseConvictionSizingConfig', () => {
  it('env vide → enabled false, defaults', () => {
    const r = parseConvictionSizingConfig({});
    expect(r.enabled).toBe(false);
    expect(r.cfg.multLow).toBe(0.7);
    expect(r.cfg.multHigh).toBe(1.5);
  });
  it('CONVICTION_SIZING_ENABLED=true', () => {
    expect(parseConvictionSizingConfig({ CONVICTION_SIZING_ENABLED: 'true' }).enabled).toBe(true);
  });
  it('overrides custom', () => {
    const r = parseConvictionSizingConfig({
      CONVICTION_SIZING_ENABLED: 'true',
      CONVICTION_SIZING_MULT_LOW: '0.5',
      CONVICTION_SIZING_MULT_HIGH: '2.0',
      CONVICTION_SIZING_LOW_THRESHOLD: '0.20',
      CONVICTION_SIZING_HIGH_THRESHOLD: '0.70',
      CONVICTION_SIZING_SKIP_IF_NEGATIVE: 'false',
    });
    expect(r.cfg.multLow).toBe(0.5);
    expect(r.cfg.multHigh).toBe(2.0);
    expect(r.cfg.lowThreshold).toBe(0.20);
    expect(r.cfg.highThreshold).toBe(0.70);
    expect(r.cfg.skipIfNegative).toBe(false);
  });
  it('valeurs hors range → defaults', () => {
    const r = parseConvictionSizingConfig({
      CONVICTION_SIZING_MULT_LOW: '-1',
      CONVICTION_SIZING_MULT_HIGH: '10',
    });
    expect(r.cfg.multLow).toBe(0.7);  // -1 < 0 → default 0.7
    expect(r.cfg.multHigh).toBe(1.5); // 10 > 3 → default 1.5
  });
  it('NaN inputs → defaults', () => {
    const r = parseConvictionSizingConfig({
      CONVICTION_SIZING_MULT_LOW: 'abc',
    });
    expect(r.cfg.multLow).toBe(0.7);
  });
});
