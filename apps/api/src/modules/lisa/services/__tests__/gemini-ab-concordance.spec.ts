// PR4 (31/05/2026) — Tests purs sur la logique de concordance Pro vs Flash
// utilisée dans LiveTraderAgent.recordAbShadow.
//
// La méthode `recordAbShadow` est privée (helper d'instance) et fait beaucoup
// de I/O (LLM call + Supabase insert). Pour tester la logique de comparaison
// sans monter tout LiveTraderAgent, on extrait la logique pure dans ce fichier
// et on la valide indépendamment.

function computeConcordance(
  pro: { action_kind: string | null; symbol: string | null; confidence: number | null },
  flash: { action_kind: string | null; symbol: string | null; confidence: number | null } | null,
): {
  concordanceAction: boolean | null;
  concordanceTarget: boolean | null;
  concordanceFull: boolean;
  confDelta: number | null;
} {
  if (flash === null) {
    return {
      concordanceAction: null,
      concordanceTarget: null,
      concordanceFull: false,
      confDelta: null,
    };
  }
  // null === null est valide pour hold (symbol absent attendu des deux côtés).
  // Comparaison directe : true si les deux ont la même valeur (y compris null).
  const concordanceAction = flash.action_kind === pro.action_kind;
  const concordanceTarget = flash.symbol === pro.symbol;
  const concordanceFull = concordanceAction && concordanceTarget;
  const confDelta = pro.confidence !== null && flash.confidence !== null
    ? Math.round((pro.confidence - flash.confidence) * 1000) / 1000
    : null;
  return { concordanceAction, concordanceTarget, concordanceFull, confDelta };
}

describe('PR4 — Gemini A/B concordance logic', () => {
  it('Pro et Flash identiques (hold/hold) → full concordance true', () => {
    const res = computeConcordance(
      { action_kind: 'hold', symbol: null, confidence: 0.95 },
      { action_kind: 'hold', symbol: null, confidence: 0.92 },
    );
    expect(res.concordanceAction).toBe(true);
    expect(res.concordanceTarget).toBe(true);
    expect(res.concordanceFull).toBe(true);
    expect(res.confDelta).toBe(0.03);
  });

  it('Pro et Flash identiques sur open + même symbol → full concordance true', () => {
    const res = computeConcordance(
      { action_kind: 'open_directional', symbol: 'BTCUSDT', confidence: 0.85 },
      { action_kind: 'open_directional', symbol: 'BTCUSDT', confidence: 0.72 },
    );
    expect(res.concordanceFull).toBe(true);
    expect(res.confDelta).toBe(0.13);
  });

  it('Pro et Flash sur même action mais symbols différents → concordance partielle', () => {
    const res = computeConcordance(
      { action_kind: 'open_directional', symbol: 'BTCUSDT', confidence: 0.85 },
      { action_kind: 'open_directional', symbol: 'ETHUSDT', confidence: 0.78 },
    );
    expect(res.concordanceAction).toBe(true);
    expect(res.concordanceTarget).toBe(false);
    expect(res.concordanceFull).toBe(false);
  });

  it('Pro vs Flash action divergente (hold vs open) → concordance false', () => {
    const res = computeConcordance(
      { action_kind: 'hold', symbol: null, confidence: 0.90 },
      { action_kind: 'open_directional', symbol: 'BTCUSDT', confidence: 0.65 },
    );
    expect(res.concordanceAction).toBe(false);
    expect(res.concordanceTarget).toBe(false);
    expect(res.concordanceFull).toBe(false);
    expect(res.confDelta).toBe(0.25); // Pro +0.25 plus confiant
  });

  it('Flash call failed (null) → concordance fields nulls + concordanceFull false', () => {
    const res = computeConcordance(
      { action_kind: 'hold', symbol: null, confidence: 0.95 },
      null,
    );
    expect(res.concordanceAction).toBeNull();
    expect(res.concordanceTarget).toBeNull();
    expect(res.concordanceFull).toBe(false);
    expect(res.confDelta).toBeNull();
  });

  it('Confidence delta négatif (Flash plus confiant que Pro)', () => {
    const res = computeConcordance(
      { action_kind: 'hold', symbol: null, confidence: 0.60 },
      { action_kind: 'hold', symbol: null, confidence: 0.95 },
    );
    expect(res.confDelta).toBe(-0.35);
  });

  it('Flash a parsé partiellement (action mais pas symbol) → concordance valide quand même', () => {
    const res = computeConcordance(
      { action_kind: 'hold', symbol: null, confidence: 0.80 },
      { action_kind: 'hold', symbol: null, confidence: 0.75 },
    );
    expect(res.concordanceFull).toBe(true);
    expect(res.confDelta).toBe(0.05);
  });
});
