/**
 * ZERO_PRICE_REJECT — garde-fou centralisé fetchLivePrice (incident SEE.LSE).
 *
 * Incident SEE.LSE (14/05/2026, perte -$1574 = 47% du drawdown MAIN) :
 * un prix de fermeture stop-loss à $0.00 sur SEE.LSE (entry $5.0182) provenait
 * d'une source NON taggée fallback (intraday-provider-router renvoyait
 * `tdLast.close = 0` ou `eodhdQuote.price = 0` sans validation > 0 lignes
 * 580-585 + 577) → contournait isFallbackSource → SL trigger faux à 0.
 *
 * Le fix #371 a patché checkStopTarget (mechanical-trading) avec ZERO_PRICE_GUARD,
 * mais d'autres consumers (closeRecommendation L1810, SWAP L2022, market_snapshot
 * L1088, etc.) pouvaient encore recevoir le prix corrompu et déclencher actions
 * destructives.
 *
 * Ce patch centralise le rejet dans fetchLivePrice : tout prix <= 0 / NaN
 * provenant d'une source non-fallback est re-taggé `fallback_unknown` AVANT
 * d'atteindre tout consumer. Les garde-fous existants (`isFallbackSource`,
 * `source.startsWith('fallback')`) catchent alors et skip toute action.
 *
 * Pattern de test : Object.create (LisaService a 30+ deps en DI). Stub
 * fetchLivePriceInner et logger.
 */

import { LisaService } from '../lisa.service';

interface BareLisa {
  fetchLivePriceInner: (s: string) => Promise<{ symbol: string; price: string; asOf: string; source: string }>;
  fetchLivePrice: (s: string) => Promise<{ symbol: string; price: string; asOf: string; source: string }>;
  tagStaleness: (q: { symbol: string; price: string; asOf: string; source: string }) => { symbol: string; price: string; asOf: string; source: string };
  logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock; debug: jest.Mock };
}

function makeLisa(innerResult: { price: string; source: string; asOf?: string }): BareLisa {
  const svc = Object.create(LisaService.prototype) as unknown as BareLisa;
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  svc.fetchLivePriceInner = async (symbol: string) => ({
    symbol,
    price: innerResult.price,
    asOf: innerResult.asOf ?? new Date().toISOString(),
    source: innerResult.source,
  });
  // Stub tagStaleness à identité (testé ailleurs). Le fix doit court-circuiter
  // tagStaleness sur les cas zero-price → on n'appelle JAMAIS tagStaleness pour
  // un re-tag fallback_unknown (sinon on re-tagge une source déjà invalidée).
  svc.tagStaleness = (q) => q;
  return svc;
}

describe('LisaService.fetchLivePrice — ZERO_PRICE_REJECT centralisé (régression SEE.LSE)', () => {
  it('prix 0 source non-fallback (eodhd) → re-tag fallback_unknown', async () => {
    const svc = makeLisa({ price: '0', source: 'eodhd' });
    const out = await svc.fetchLivePrice('SEE.LSE');
    expect(out.source).toBe('fallback_unknown');
    expect(out.price).toBe('0');
    expect(svc.logger.error).toHaveBeenCalledWith(expect.stringContaining('[ZERO_PRICE_REJECT]'));
  });

  it('prix 0.0000 (string) source twelvedata → re-tag fallback_unknown', async () => {
    const svc = makeLisa({ price: '0.0000', source: 'twelvedata' });
    const out = await svc.fetchLivePrice('SEE.LSE');
    expect(out.source).toBe('fallback_unknown');
    expect(svc.logger.error).toHaveBeenCalledWith(expect.stringContaining('SEE.LSE'));
  });

  it('prix négatif source eodhd → re-tag fallback_unknown', async () => {
    const svc = makeLisa({ price: '-3.14', source: 'eodhd' });
    const out = await svc.fetchLivePrice('TEST.US');
    expect(out.source).toBe('fallback_unknown');
  });

  it('prix NaN source eodhd → re-tag fallback_unknown', async () => {
    const svc = makeLisa({ price: 'NaN', source: 'eodhd' });
    const out = await svc.fetchLivePrice('TEST.US');
    expect(out.source).toBe('fallback_unknown');
  });

  it('prix non parsable source eodhd → re-tag fallback_unknown', async () => {
    const svc = makeLisa({ price: 'abc', source: 'eodhd' });
    const out = await svc.fetchLivePrice('TEST.US');
    expect(out.source).toBe('fallback_unknown');
  });

  it('prix 0 source DÉJÀ fallback_unknown → laisser passer (sentinel attendu)', async () => {
    const svc = makeLisa({ price: '0', source: 'fallback_unknown' });
    const out = await svc.fetchLivePrice('UNKNOWN.SYM');
    expect(out.source).toBe('fallback_unknown');
    // Pas de double-log error (déjà fallback)
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  it('prix 0 source fallback_quota_cap → laisser passer (déjà flaggé)', async () => {
    const svc = makeLisa({ price: '0', source: 'fallback_quota_cap' });
    const out = await svc.fetchLivePrice('TEST.US');
    expect(out.source).toBe('fallback_quota_cap');
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  it('prix valide (5.02) source eodhd → passe normalement', async () => {
    const svc = makeLisa({ price: '5.0182', source: 'eodhd' });
    const out = await svc.fetchLivePrice('SEE.LSE');
    expect(out.source).toBe('eodhd');
    expect(out.price).toBe('5.0182');
    expect(svc.logger.error).not.toHaveBeenCalled();
  });

  it('scenario SEE.LSE complet : entry $5.0182, intraday-router renvoie $0 eodhd → fallback_unknown → consumer guards skip', async () => {
    // Reproduit EXACTEMENT le pathway du 14/05 :
    // 1. checkStopTarget appelle getLivePrice('SEE.LSE')
    // 2. fetchLivePriceInner appelle intradayRouter.getLiveQuote → renvoie
    //    { price: 0, source: 'eodhd' } (eodhdQuote.price = 0, non validé L578)
    // 3. fetchLivePrice doit re-tagger fallback_unknown
    // 4. checkStopTarget.isFallbackSource('fallback_unknown') → true → skip
    //    → PAS de SL trigger à 0 → PAS de fausse liquidation -$1574
    const svc = makeLisa({ price: '0', source: 'eodhd' });
    const out = await svc.fetchLivePrice('SEE.LSE');
    expect(out.source).toBe('fallback_unknown');
    // Vérification que le consumer guard (logique inline) bloque bien :
    const isFallback = out.source.startsWith('fallback') || out.source.startsWith('stale_');
    expect(isFallback).toBe(true);
  });
});
