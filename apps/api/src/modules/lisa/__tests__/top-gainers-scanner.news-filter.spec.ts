/**
 * Phase 2 — Filtre news pré-trade reject_post_news_fresh_strong_pos.
 *
 * Justification empirique (cross-réf 23/05/2026, n=87 trades US/15j) :
 *   - sans news 24h pre-entry : +0.08% mean, WR 48%
 *   - avec news strong_pos 24h : -0.18% mean, WR 41%
 *   - inertie : T-1h = -0.79% (chase the top), T-4h = -0.36%
 *
 * Le filtre lit STRICTEMENT la DB (jamais d'appel API live). Default OFF
 * (GAINERS_NEWS_AGE_FILTER_HOURS=0).
 */

import type { PersistedNewsArticle } from '../services/eodhd-news.service';

function makeEodhdNewsMock(byTicker: Record<string, PersistedNewsArticle[]>) {
  return {
    getRecentNewsForTicker: async (ticker: string, _hoursBack: number) => {
      return byTicker[ticker] ?? [];
    },
  } as any;
}

/**
 * Mock article. `polarity` reste accepté pour rétro-compat des cas existants ;
 * pos/neg sont dérivés automatiquement (pos = max(polarity, 0), neg = max(-polarity, 0)).
 * Override possible via {pos, neg} explicites.
 */
function makeArticle(opts: {
  ticker: string;
  ageMinutes: number;
  polarity: number;
  pos?: number;
  neg?: number;
}): PersistedNewsArticle {
  const pos = opts.pos ?? Math.max(opts.polarity, 0);
  const neg = opts.neg ?? Math.max(-opts.polarity, 0);
  return {
    ticker: opts.ticker,
    external_id: `art_${Math.random().toString(36).slice(2)}`,
    published_at: new Date(Date.now() - opts.ageMinutes * 60_000).toISOString(),
    title: 'Test news title',
    content: null,
    source_url: null,
    sentiment_polarity: opts.polarity,
    sentiment_neg: neg,
    sentiment_neu: null,
    sentiment_pos: pos,
    tags: [],
    related_symbols: [],
  };
}

/**
 * Predicate pur du filtre. Aligné sur la prod (top-gainers-scanner.service.ts) :
 * utilise le sentiment net (pos - neg) au lieu de la polarity saturée d'EODHD.
 * Audit 23/05/2026 : 73% des articles ont polarity > 0.9 → signal inutilisable.
 * Net sentiment p90 = 0.15 → seuil par défaut.
 */
async function shouldRejectByNews(
  candidate: { symbol: string; assetClass: string },
  newsService: { getRecentNewsForTicker: (t: string, h: number) => Promise<PersistedNewsArticle[]> } | undefined,
  newsAgeHours: number,
  newsMinNetSentiment: number,
): Promise<{ rejected: boolean; reason?: string }> {
  if (newsAgeHours <= 0) return { rejected: false };
  if (!newsService) return { rejected: false };
  const cls = candidate.assetClass;
  const inScope =
    (candidate.symbol.endsWith('.US') && (cls === 'us_equity_large' || cls === 'us_equity_small_mid')) ||
    cls === 'crypto_major';
  if (!inScope) return { rejected: false };
  try {
    const recent = await newsService.getRecentNewsForTicker(candidate.symbol, newsAgeHours);
    const strongPos = recent.find((n) => {
      if (typeof n.sentiment_pos !== 'number' || typeof n.sentiment_neg !== 'number') return false;
      return (n.sentiment_pos - n.sentiment_neg) >= newsMinNetSentiment;
    });
    if (!strongPos) return { rejected: false };
    const net = (strongPos.sentiment_pos ?? 0) - (strongPos.sentiment_neg ?? 0);
    return { rejected: true, reason: `net=${net.toFixed(3)}` };
  } catch {
    return { rejected: false };
  }
}

describe('Phase 2 — filtre reject_post_news_fresh_strong_pos', () => {
  const candUs = { symbol: 'AAP.US', assetClass: 'us_equity_small_mid' };
  const candUsLarge = { symbol: 'NKE.US', assetClass: 'us_equity_large' };
  const candEu = { symbol: 'BARC.LSE', assetClass: 'eu_equity' };
  const candAsia = { symbol: '005930.KO', assetClass: 'asia_equity' };
  const candCrypto = { symbol: 'BTCUSDT', assetClass: 'crypto_major' };

  // Seuil net par défaut = 0.15 (≈ p90 du sentiment net réel sur 300 articles
  // échantillonnés 23/05). Cas avec pos/neg explicites pour clarté.
  const DEFAULT_NET = 0.15;

  it('OFF par défaut (newsAgeHours=0) → passe', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.99, pos: 0.8, neg: 0.1 })] });
    const r = await shouldRejectByNews(candUs, news, 0, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('ON + news fortement positive nette (pos=0.5 neg=0.05 → net=0.45) US small-mid → REJETÉ', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.9, pos: 0.5, neg: 0.05 })] });
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(true);
    expect(r.reason).toContain('0.450');
  });

  it('ON + news fortement positive nette US large → REJETÉ aussi', async () => {
    const news = makeEodhdNewsMock({ 'NKE.US': [makeArticle({ ticker: 'NKE.US', ageMinutes: 60, polarity: 0.75, pos: 0.4, neg: 0.05 })] });
    const r = await shouldRejectByNews(candUsLarge, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(true);
  });

  it('ON + sentiment net faible (pos=0.10 neg=0.05 → net=0.05 < 0.15) → PASSE', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.30, pos: 0.10, neg: 0.05 })] });
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('ON + news négative (pos=0.05 neg=0.6) → PASSE (le filtre ne bloque QUE strong_pos)', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: -0.7, pos: 0.05, neg: 0.6 })] });
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('ON + aucune news → PASSE', async () => {
    const news = makeEodhdNewsMock({});
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('ON + pos/neg absents (null) → PASSE (fail-safe sans signal)', async () => {
    const newsArticle: PersistedNewsArticle = {
      ticker: 'AAP.US',
      external_id: 'art_null_sentiment',
      published_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      title: 't',
      content: null,
      source_url: null,
      sentiment_polarity: 0.99,
      sentiment_neg: null,
      sentiment_neu: null,
      sentiment_pos: null,
      tags: [],
      related_symbols: [],
    };
    const news = makeEodhdNewsMock({ 'AAP.US': [newsArticle] });
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('EU ticker même avec news strong_pos → PASSE (couverture EODHD EU médiocre)', async () => {
    const news = makeEodhdNewsMock({ 'BARC.LSE': [makeArticle({ ticker: 'BARC.LSE', ageMinutes: 30, polarity: 0.9, pos: 0.5, neg: 0.05 })] });
    const r = await shouldRejectByNews(candEu, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('Asia ticker → PASSE (0% couverture EODHD)', async () => {
    const news = makeEodhdNewsMock({ '005930.KO': [makeArticle({ ticker: '005930.KO', ageMinutes: 30, polarity: 0.99, pos: 0.6, neg: 0.05 })] });
    const r = await shouldRejectByNews(candAsia, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('Crypto major AVEC news strong_pos → REJETÉ (couverture EODHD .CC)', async () => {
    const news = makeEodhdNewsMock({ BTCUSDT: [makeArticle({ ticker: 'BTCUSDT', ageMinutes: 30, polarity: 0.95, pos: 0.5, neg: 0.05 })] });
    const r = await shouldRejectByNews(candCrypto, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(true);
  });

  it('Crypto alt (POLUSDT-class) → PASSE (hors crypto_major scope)', async () => {
    const candCryptoAlt = { symbol: 'POLUSDT', assetClass: 'crypto_alt' };
    const news = makeEodhdNewsMock({ POLUSDT: [makeArticle({ ticker: 'POLUSDT', ageMinutes: 30, polarity: 0.99, pos: 0.5, neg: 0.05 })] });
    const r = await shouldRejectByNews(candCryptoAlt, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('service indispo → fail-safe, PASSE (ne bloque pas le trade)', async () => {
    const news = { getRecentNewsForTicker: async () => { throw new Error('db down'); } } as any;
    const r = await shouldRejectByNews(candUs, news, 4, DEFAULT_NET);
    expect(r.rejected).toBe(false);
  });

  it('seuil configurable — strict (0.4) ignore les news net=0.2', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.7, pos: 0.25, neg: 0.05 })] });
    expect((await shouldRejectByNews(candUs, news, 4, 0.15)).rejected).toBe(true);  // net=0.20 ≥ 0.15 → reject
    expect((await shouldRejectByNews(candUs, news, 4, 0.40)).rejected).toBe(false); // net=0.20 < 0.40 → pass
  });
});
