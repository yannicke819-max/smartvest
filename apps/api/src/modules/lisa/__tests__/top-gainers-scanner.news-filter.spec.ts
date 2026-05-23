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

function makeArticle(opts: {
  ticker: string;
  ageMinutes: number;
  polarity: number;
}): PersistedNewsArticle {
  return {
    ticker: opts.ticker,
    external_id: `art_${Math.random().toString(36).slice(2)}`,
    published_at: new Date(Date.now() - opts.ageMinutes * 60_000).toISOString(),
    title: 'Test news title',
    content: null,
    source_url: null,
    sentiment_polarity: opts.polarity,
    sentiment_neg: null,
    sentiment_neu: null,
    sentiment_pos: null,
    tags: [],
    related_symbols: [],
  };
}

/**
 * Unit du PREDICATE pur du filtre — extrait pour testabilité sans dépendances
 * sur l'objet scanner monolithique. Le comportement réel est identique
 * (cf. top-gainers-scanner.service.ts:2410+).
 */
async function shouldRejectByNews(
  candidate: { symbol: string; assetClass: string },
  newsService: { getRecentNewsForTicker: (t: string, h: number) => Promise<PersistedNewsArticle[]> } | undefined,
  newsAgeHours: number,
  newsMinSentiment: number,
): Promise<{ rejected: boolean; reason?: string }> {
  if (newsAgeHours <= 0) return { rejected: false };
  if (!newsService) return { rejected: false };
  if (!candidate.symbol.endsWith('.US')) return { rejected: false };
  if (candidate.assetClass !== 'us_equity_large' && candidate.assetClass !== 'us_equity_small_mid') return { rejected: false };
  try {
    const recent = await newsService.getRecentNewsForTicker(candidate.symbol, newsAgeHours);
    const strongPos = recent.find(
      (n) => typeof n.sentiment_polarity === 'number' && n.sentiment_polarity >= newsMinSentiment,
    );
    return strongPos
      ? { rejected: true, reason: `polarity=${strongPos.sentiment_polarity}` }
      : { rejected: false };
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

  it('OFF par défaut (newsAgeHours=0) → passe', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.99 })] });
    const r = await shouldRejectByNews(candUs, news, 0, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('ON + news strong_pos fraîche US small-mid → REJETÉ', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.99 })] });
    const r = await shouldRejectByNews(candUs, news, 4, 0.5);
    expect(r.rejected).toBe(true);
    expect(r.reason).toContain('0.99');
  });

  it('ON + news strong_pos fraîche US large → REJETÉ aussi', async () => {
    const news = makeEodhdNewsMock({ 'NKE.US': [makeArticle({ ticker: 'NKE.US', ageMinutes: 60, polarity: 0.75 })] });
    const r = await shouldRejectByNews(candUsLarge, news, 4, 0.5);
    expect(r.rejected).toBe(true);
  });

  it('ON + news polarity SOUS le seuil (0.3 < 0.5) → PASSE', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.30 })] });
    const r = await shouldRejectByNews(candUs, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('ON + news négative (polarity -0.7) → PASSE (le filtre ne bloque QUE strong_pos)', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: -0.7 })] });
    const r = await shouldRejectByNews(candUs, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('ON + aucune news → PASSE', async () => {
    const news = makeEodhdNewsMock({});
    const r = await shouldRejectByNews(candUs, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('EU ticker même avec news strong_pos → PASSE (couverture EODHD EU médiocre)', async () => {
    const news = makeEodhdNewsMock({ 'BARC.LSE': [makeArticle({ ticker: 'BARC.LSE', ageMinutes: 30, polarity: 0.9 })] });
    const r = await shouldRejectByNews(candEu, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('Asia ticker → PASSE (0% couverture EODHD)', async () => {
    const news = makeEodhdNewsMock({ '005930.KO': [makeArticle({ ticker: '005930.KO', ageMinutes: 30, polarity: 0.99 })] });
    const r = await shouldRejectByNews(candAsia, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('Crypto → PASSE (pas de news ticker-spécifique EODHD)', async () => {
    const news = makeEodhdNewsMock({ BTCUSDT: [makeArticle({ ticker: 'BTCUSDT', ageMinutes: 30, polarity: 0.99 })] });
    const r = await shouldRejectByNews(candCrypto, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('service indispo → fail-safe, PASSE (ne bloque pas le trade)', async () => {
    const news = { getRecentNewsForTicker: async () => { throw new Error('db down'); } } as any;
    const r = await shouldRejectByNews(candUs, news, 4, 0.5);
    expect(r.rejected).toBe(false);
  });

  it('seuil configurable — strict (0.8) ignore les news polarity=0.7', async () => {
    const news = makeEodhdNewsMock({ 'AAP.US': [makeArticle({ ticker: 'AAP.US', ageMinutes: 30, polarity: 0.7 })] });
    expect((await shouldRejectByNews(candUs, news, 4, 0.5)).rejected).toBe(true);
    expect((await shouldRejectByNews(candUs, news, 4, 0.8)).rejected).toBe(false);
  });
});
