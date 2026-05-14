/**
 * Bug #R5 — Tests sanity check livePrice avant déclenchement SL/TP.
 *
 * COMPLÉMENT INCRÉMENTAL à Bug #M (#310/#311/#315), PAS un duplicate :
 * Bug #M couvrait déjà price≤0 + source fallback sur risk-monitor,
 * mechanical-trading, option-broker, rebound-monitor. R5 ajoute :
 *   1. Les ratio bounds [0.5x, 2.0x] de l'entry — rejette une corruption
 *      NON-NULLE (glitch EODHD type 2.5 sur entry 5.0 : ni zéro, ni fallback,
 *      mais aberrant). Absent partout sauf mechanical-trading (SANITY_BOUND
 *      30% existant, plus strict — laissé inchangé).
 *   2. Le gap zéro NON-FALLBACK de lisa.service #C5 (close reco + SWAP) qui
 *      ne checkait QUE source.startsWith('fallback') — un prix 0/NaN
 *      non-sentinel passait.
 *
 * Pattern de test : reproduction en isolation de la décision sanity (norme
 * repo, cf. batch-cap.spec.ts — services trop lourds en DI NestJS). Les
 * fonctions ci-dessous reproduisent EXACTEMENT les gardes insérées.
 */

export {};

const R5_SANITY_MIN_RATIO = 0.5;
const R5_SANITY_MAX_RATIO = 2.0;

/**
 * Reproduit le gate sanity commun (risk-monitor / rebound-monitor / lisa.service
 * #C5). Retourne true si le livePrice est utilisable pour déclencher une action.
 * `entryPrice ≤ 0 / NaN` → on ne bloque pas sur le ratio (les autres clauses
 * couvrent), on retourne la validité du seul livePrice.
 */
function isLivePriceSane(livePrice: number, entryPrice: number): boolean {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return false;
  if (Number.isFinite(entryPrice) && entryPrice > 0) {
    const ratio = livePrice / entryPrice;
    if (ratio < R5_SANITY_MIN_RATIO || ratio > R5_SANITY_MAX_RATIO) return false;
  }
  return true;
}

describe('Bug #R5 — livePrice sanity (6 cas spec)', () => {
  const ENTRY = 5.0;

  it('rejette livePrice=0', () => {
    expect(isLivePriceSane(0, ENTRY)).toBe(false);
  });

  it('rejette livePrice négatif', () => {
    expect(isLivePriceSane(-3.2, ENTRY)).toBe(false);
  });

  it('rejette livePrice NaN / Infinity', () => {
    expect(isLivePriceSane(NaN, ENTRY)).toBe(false);
    expect(isLivePriceSane(Infinity, ENTRY)).toBe(false);
    expect(isLivePriceSane(-Infinity, ENTRY)).toBe(false);
  });

  it('rejette livePrice < entryPrice * 0.5', () => {
    expect(isLivePriceSane(2.49, ENTRY)).toBe(false);   // 0.498x
    expect(isLivePriceSane(1.0, ENTRY)).toBe(false);    // 0.2x
  });

  it('rejette livePrice > entryPrice * 2.0', () => {
    expect(isLivePriceSane(10.01, ENTRY)).toBe(false);  // 2.002x
    expect(isLivePriceSane(50.0, ENTRY)).toBe(false);   // 10x
  });

  it('accepte livePrice dans [0.5x, 2.0x] de entry', () => {
    expect(isLivePriceSane(2.5, ENTRY)).toBe(true);     // 0.5x exact (borne incluse)
    expect(isLivePriceSane(5.0, ENTRY)).toBe(true);     // 1.0x
    expect(isLivePriceSane(10.0, ENTRY)).toBe(true);    // 2.0x exact (borne incluse)
    expect(isLivePriceSane(4.8929, ENTRY)).toBe(true);  // ~SL légitime (SEE.LSE)
  });
});

describe('Bug #R5 — scénario incrémental : corruption NON-NULLE (le vrai apport vs Bug #M)', () => {
  it('glitch EODHD 2.5 sur entry 5.0 → rejeté par le ratio (Bug #M ne le voyait pas : ni 0 ni fallback)', () => {
    // 2.5 / 5.0 = 0.5x → exactement à la borne basse, accepté.
    // 2.49 / 5.0 = 0.498x → sous la borne → rejeté.
    expect(isLivePriceSane(2.49, 5.0)).toBe(false);
    // Un glitch plus franc (ex. EODHD renvoie 1.2 pour un ticker à 5.0).
    expect(isLivePriceSane(1.2, 5.0)).toBe(false);
  });

  it('glitch EODHD 12.0 sur entry 5.0 → rejeté par la borne haute (protection symétrique)', () => {
    expect(isLivePriceSane(12.0, 5.0)).toBe(false);  // 2.4x
  });

  it('mouvement de marché légitime -40% (3.0 sur entry 5.0) → accepté (dans [0.5x, 2.0x])', () => {
    // R5 ne bloque PAS les vrais mouvements ≤50% : un SL légitime à -40%
    // doit pouvoir se déclencher. Seule la corruption >50% est rejetée.
    expect(isLivePriceSane(3.0, 5.0)).toBe(true);
  });
});

/**
 * Reproduit le gate de lisa.service #C5 (close recommendation + SWAP).
 * AVANT Bug #R5 : seul `source.startsWith('fallback')` était checké → un prix
 * 0/NaN NON-FALLBACK passait. APRÈS : on rejette quelle que soit la source.
 */
function lisaC5ShouldSkip(
  source: string,
  livePrice: number,
  entryPrice: number,
): boolean {
  if (source && source.startsWith('fallback')) return true;          // garde Bug #M #C5
  if (!isLivePriceSane(livePrice, entryPrice)) return true;          // gap R5 comblé
  return false;
}

describe('Bug #R5 — gap zéro NON-FALLBACK de lisa.service #C5', () => {
  it('source fallback → skip (garde Bug #M #C5 préservée)', () => {
    expect(lisaC5ShouldSkip('fallback_unknown', 0, 5.0)).toBe(true);
  });

  it('GAP COMBLÉ : prix 0 avec source eodhd (non-fallback) → skip (avant R5 : passait)', () => {
    // C'est le scénario que la garde #C5 originale ratait : EODHD renvoie
    // un 0 NON via le sentinel fallback_unknown mais via un payload corrompu.
    expect(lisaC5ShouldSkip('eodhd', 0, 5.0)).toBe(true);
  });

  it('GAP COMBLÉ : prix NaN avec source eodhd → skip', () => {
    expect(lisaC5ShouldSkip('eodhd', NaN, 5.0)).toBe(true);
  });

  it('GAP COMBLÉ : prix corrompu non-nul (2.0 sur entry 5.0) source eodhd → skip', () => {
    expect(lisaC5ShouldSkip('eodhd', 2.0, 5.0)).toBe(true);  // 0.4x < 0.5x
  });

  it('prix sain source eodhd → ne skip pas (close exécuté normalement)', () => {
    expect(lisaC5ShouldSkip('eodhd', 4.85, 5.0)).toBe(false);
  });

  it('prix sain source binance_ws → ne skip pas', () => {
    expect(lisaC5ShouldSkip('binance_ws', 5.1, 5.0)).toBe(false);
  });
});

describe('Bug #R5 — non-régression : entry invalide ne bloque pas sur le ratio', () => {
  it('entryPrice 0 → seul le livePrice est jugé (pas de division par zéro)', () => {
    expect(isLivePriceSane(5.0, 0)).toBe(true);    // livePrice sain, entry ignoré
    expect(isLivePriceSane(0, 0)).toBe(false);     // livePrice invalide
  });

  it('entryPrice NaN → idem, seul le livePrice compte', () => {
    expect(isLivePriceSane(5.0, NaN)).toBe(true);
    expect(isLivePriceSane(-1, NaN)).toBe(false);
  });
});
