/**
 * Bug #M Part 3 (issue #313) — Tests garde-fou fallback price sur 5 sites
 * critiques résiduels (kill-switches + cron + Lisa).
 *
 * Tous identiques en symptôme au Bug #M original : si EODHD fallback retourne
 * `{ price: '0', source: 'fallback_unknown' }`, le code fermait des positions
 * à $0 = perte maximale.
 *
 * Pattern de test : reproduction en isolation de la logique de garde insérée
 * à chaque site (norme du repo, cf. mechanical-trading.batch-cap.spec.ts —
 * les services sont trop lourds en DI NestJS pour être instanciés proprement).
 * Chaque test rejoue la décision exacte du code patché, alimenté par le quote
 * sentinel fallback, et vérifie l'issue (close at entry_price OU skip).
 */

type Quote = { price: string; source: string } | null;

const FALLBACK_QUOTE: Quote = { price: '0', source: 'fallback_unknown' };
const LEGIT_QUOTE: Quote = { price: '4.80', source: 'eodhd' };

// ---------------------------------------------------------------------------
// #C1 — mechanical-trading P4.1 kill-switch auto : corrupt → entry_price + tag
// ---------------------------------------------------------------------------
function c1ResolveClosePx(quote: Quote, entryPrice: string): { px: string; corrupt: boolean } {
  // Reproduit mechanical-trading.service.ts P4.1 kill-switch loop (#C1).
  // Le quote null est filtré en amont (`if (!quote) continue`), ici on teste
  // le cas quote présent mais corrompu.
  const priceNum = parseFloat(quote!.price);
  const corrupt =
    !quote!.source || quote!.source.startsWith('fallback') ||
    !Number.isFinite(priceNum) ||
    priceNum <= 0;
  return { px: corrupt ? entryPrice : quote!.price, corrupt };
}

describe('Bug #M Part 3 #C1 — P4.1 kill-switch auto fallback guard', () => {
  it('fallback_unknown quote → ferme à entry_price (pas à 0)', () => {
    const { px, corrupt } = c1ResolveClosePx(FALLBACK_QUOTE, '5.0182');
    expect(corrupt).toBe(true);
    expect(px).toBe('5.0182');
  });

  it('quote legit eodhd → ferme au prix live normal', () => {
    const { px, corrupt } = c1ResolveClosePx(LEGIT_QUOTE, '5.0182');
    expect(corrupt).toBe(false);
    expect(px).toBe('4.80');
  });

  it('quote price=NaN → corrupt, ferme à entry_price', () => {
    const { px, corrupt } = c1ResolveClosePx({ price: 'NaN', source: 'eodhd' }, '5.0182');
    expect(corrupt).toBe(true);
    expect(px).toBe('5.0182');
  });
});

// ---------------------------------------------------------------------------
// #C2 — lisa.service triggerKillSwitch (user) : corrupt → entry_price + tag
// ---------------------------------------------------------------------------
function c2ResolveLiquidationPx(quote: { price: string; source?: string }, entryPrice: string): {
  px: string;
  corrupt: boolean;
} {
  // Reproduit lisa.service.ts triggerKillSwitch loop (#C2).
  const priceNum = parseFloat(quote.price);
  const corrupt =
    (quote.source != null && quote.source.startsWith('fallback')) ||
    !Number.isFinite(priceNum) ||
    priceNum <= 0;
  return { px: corrupt ? entryPrice : quote.price, corrupt };
}

describe('Bug #M Part 3 #C2 — user kill-switch fallback guard', () => {
  it('fallback_unknown quote → ferme à entry_price (le bouton de protection ne détruit pas)', () => {
    const { px, corrupt } = c2ResolveLiquidationPx(FALLBACK_QUOTE!, '5.0182');
    expect(corrupt).toBe(true);
    expect(px).toBe('5.0182');
  });

  it('quote legit → ferme au prix live', () => {
    const { px, corrupt } = c2ResolveLiquidationPx(LEGIT_QUOTE!, '5.0182');
    expect(corrupt).toBe(false);
    expect(px).toBe('4.80');
  });

  it('quote price≤0 explicite → corrupt', () => {
    const { corrupt } = c2ResolveLiquidationPx({ price: '0.00', source: 'eodhd' }, '5.0182');
    expect(corrupt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #C3 — option-broker cron : expiration → entry_underlying_price ; TP → skip
// ---------------------------------------------------------------------------
function c3ResolveOptionAction(
  quote: Quote,
  entryUnderlyingPrice: number,
): { spotForExpiry: number; tpSkipped: boolean } {
  // Reproduit option-broker.service.ts cron loop (#C3).
  const isFallback = quote != null && quote.source != null && quote.source.startsWith('fallback');
  const priceNum = quote != null ? parseFloat(quote.price) : NaN;
  const reliable = quote != null && !isFallback && Number.isFinite(priceNum) && priceNum > 0;
  const spotForExpiry = reliable ? priceNum : entryUnderlyingPrice;
  // Pour le TP : skip ce cycle si pas de prix fiable
  const tpSkipped = !reliable;
  return { spotForExpiry, tpSkipped };
}

describe('Bug #M Part 3 #C3 — option-broker cron fallback guard', () => {
  it('fallback quote → expiration close à entry_underlying_price (pas spot=0)', () => {
    const { spotForExpiry } = c3ResolveOptionAction(FALLBACK_QUOTE, 102.5);
    expect(spotForExpiry).toBe(102.5);
  });

  it('fallback quote → TP check skippé ce cycle (option reste vivante)', () => {
    const { tpSkipped } = c3ResolveOptionAction(FALLBACK_QUOTE, 102.5);
    expect(tpSkipped).toBe(true);
  });

  it('quote legit → spot fiable utilisé, TP évalué', () => {
    const { spotForExpiry, tpSkipped } = c3ResolveOptionAction({ price: '110.0', source: 'eodhd' }, 102.5);
    expect(spotForExpiry).toBe(110.0);
    expect(tpSkipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #C4 — mechanical-trading AutonomyRule close : fallback → skip (pas de close)
// ---------------------------------------------------------------------------
function c4ShouldClose(quote: Quote): boolean {
  // Reproduit mechanical-trading.service.ts evaluateAutonomyRules close (#C4).
  // isFallbackSource : source absente OU commençant par 'fallback' = fallback.
  const isFallback = !quote || !quote.source || quote.source.startsWith('fallback');
  return quote != null && !isFallback;
}

describe('Bug #M Part 3 #C4 — AutonomyRule close fallback guard', () => {
  it('fallback_unknown quote → NE ferme PAS (skip, retry next cycle)', () => {
    expect(c4ShouldClose(FALLBACK_QUOTE)).toBe(false);
  });

  it('quote null → NE ferme PAS', () => {
    expect(c4ShouldClose(null)).toBe(false);
  });

  it('quote legit eodhd → ferme normalement', () => {
    expect(c4ShouldClose(LEGIT_QUOTE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #C5 — lisa.service SWAP + close recommendation : fallback → skip
// ---------------------------------------------------------------------------
function c5ShouldSkip(quote: { price: string; source?: string }): boolean {
  // Reproduit lisa.service.ts SWAP (L~1956) + close recommendation (L~1769).
  return quote.source != null && quote.source.startsWith('fallback');
}

describe('Bug #M Part 3 #C5 — Lisa SWAP + recommendation fallback guard', () => {
  it('fallback_unknown quote → skip (pas de close sur prix sentinel)', () => {
    expect(c5ShouldSkip(FALLBACK_QUOTE!)).toBe(true);
  });

  it('quote legit eodhd → close exécuté', () => {
    expect(c5ShouldSkip(LEGIT_QUOTE!)).toBe(false);
  });

  it('quote source binance_ws → close exécuté (source fiable non-fallback)', () => {
    expect(c5ShouldSkip({ price: '60000', source: 'binance_ws' })).toBe(false);
  });
});
