import { Injectable, Logger } from '@nestjs/common';
import type { EodhdNewsItem } from './eodhd-enrichment.service';

/**
 * StockTwitsService — flux retail sentiment depuis l'API publique StockTwits.
 *
 * StockTwits est un Twitter spécialisé trading. Pas d'auth, pas de quota
 * dur (rate-limit ~200/h par IP). Données :
 *  - Sentiment retail consolidé par symbole (bullish/bearish votes)
 *  - Top messages trending par symbole + globalement
 *
 * Endpoints utilisés (tous JSON public, pas d'OAuth) :
 *  - /streams/symbol/{ticker}.json      → flux dédié à un symbole
 *  - /streams/trending.json             → trending global
 *
 * Chaque message StockTwits est converti en NewsItem au format unifié.
 * Le `sentiment` numérique vient de l'agrégation Bullish/Bearish votes.
 *
 * Cache 5min par symbole pour limiter le rate.
 */
@Injectable()
export class StockTwitsService {
  private readonly logger = new Logger(StockTwitsService.name);
  private readonly cache: Map<string, { data: EodhdNewsItem[]; asOf: number }> = new Map();
  private readonly CACHE_MS = 5 * 60 * 1000;

  /**
   * Fetch trending général (sans symbole) — sert de proxy pour repérer
   * les tickers qui chauffent côté retail.
   */
  async fetchTrending(limit = 20): Promise<EodhdNewsItem[]> {
    return this.fetchStream('trending', undefined, limit);
  }

  /**
   * Fetch flux dédié à un symbole. Si le ticker n'existe pas sur
   * StockTwits, retourne []. Pas d'erreur levée.
   *
   * StockTwits utilise un suffixe spécifique pour le crypto :
   *   BTC  → BTC.X
   *   ETH  → ETH.X
   *   SOL  → SOL.X
   * Pour les actions / ETF, le ticker brut suffit (AAPL, GLD, SPY...).
   */
  async fetchForSymbol(symbol: string, limit = 15): Promise<EodhdNewsItem[]> {
    const stocktwitsSymbol = this.toStockTwitsSymbol(symbol);
    return this.fetchStream('symbol', stocktwitsSymbol, limit);
  }

  /**
   * Map ticker SmartVest → format StockTwits.
   *  - Crypto natif (BTC/ETH/SOL/...) → suffixe `.X`
   *  - Crypto-equity proxies (COIN/MSTR/MARA/...) → ticker brut
   *  - Equity / ETF → ticker brut
   */
  private toStockTwitsSymbol(symbol: string): string {
    const s = symbol.toUpperCase();
    const cryptoNative = new Set([
      'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT',
      'MATIC', 'LINK', 'UNI', 'LTC', 'BCH', 'ATOM', 'NEAR', 'APT',
    ]);
    if (cryptoNative.has(s) && !s.endsWith('.X')) return `${s}.X`;
    return s;
  }

  /**
   * Batch : fetch StockTwits pour une liste de symboles + trending.
   * Dédoublonné côté NewsAggregator. Cap pour limiter rate.
   */
  async fetchBatch(symbols: string[], includeTrending = true): Promise<EodhdNewsItem[]> {
    const tasks: Promise<EodhdNewsItem[]>[] = [];
    if (includeTrending) tasks.push(this.fetchTrending(15));
    for (const s of symbols.slice(0, 8)) {
      tasks.push(this.fetchForSymbol(s, 10));
    }
    const results = await Promise.allSettled(tasks);
    return results
      .filter((r): r is PromiseFulfilledResult<EodhdNewsItem[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }

  // ────────────────────────────────────────────────────────────────────

  private async fetchStream(
    kind: 'symbol' | 'trending',
    symbol: string | undefined,
    limit: number,
  ): Promise<EodhdNewsItem[]> {
    const cacheKey = kind === 'trending' ? 'trending' : `sym:${symbol?.toUpperCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) {
      return cached.data;
    }

    const url = kind === 'trending'
      ? 'https://api.stocktwits.com/api/2/streams/trending.json'
      : `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol ?? '')}.json`;

    try {
      // User-Agent obligatoire : Node fetch n'en met pas par défaut et
      // StockTwits rate-limit / bloque les requêtes anonymes.
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'smartvest-news/1.0 (+personal investment simulation)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        // 404 = ticker pas listé sur StockTwits (ex: ETF obscur). Le reste
        // est anormal (429 rate-limit, 403 bloqué, 5xx down). On log au
        // niveau warn pour visibilité Fly.
        if (res.status === 404) {
          this.logger.debug(`stocktwits ${kind} ${symbol ?? ''} 404 (not listed)`);
        } else {
          this.logger.warn(`stocktwits ${kind} ${symbol ?? ''} HTTP ${res.status}`);
        }
        this.cache.set(cacheKey, { data: [], asOf: Date.now() });
        return [];
      }
      const json = await res.json() as StockTwitsResponse;
      if (json.response?.status !== 200 || !Array.isArray(json.messages)) {
        this.logger.warn(`stocktwits ${kind} ${symbol ?? ''} bad response: status=${json.response?.status} hasMessages=${Array.isArray(json.messages)}`);
        this.cache.set(cacheKey, { data: [], asOf: Date.now() });
        return [];
      }
      this.logger.debug(`stocktwits ${kind} ${symbol ?? ''} OK ${json.messages.length} messages`);

      const items: EodhdNewsItem[] = json.messages.slice(0, limit).map((m) => {
        const tickers = (m.symbols ?? []).map((s) => (s.symbol ?? '').toUpperCase()).filter((s) => s);
        const sentiment = this.parseStockTwitsSentiment(m);
        const body = (m.body ?? '').slice(0, 200);
        return {
          title: body || `(StockTwits message ${m.id ?? ''})`,
          date: m.created_at ?? new Date().toISOString(),
          symbols: tickers.slice(0, 5),
          sentiment,
          tags: [],
          link: m.id ? `https://stocktwits.com/message/${m.id}` : null,
          sourceDomain: 'stocktwits.com',
          contentPreview: body.length > 0 ? body : null,
          provider: 'stocktwits' as const,
        };
      });

      this.cache.set(cacheKey, { data: items, asOf: Date.now() });
      return items;
    } catch (e) {
      this.logger.debug(`stocktwits fetch error: ${String(e).slice(0, 120)}`);
      this.cache.set(cacheKey, { data: [], asOf: Date.now() });
      return [];
    }
  }

  /** StockTwits expose entities.sentiment.basic = "Bullish" | "Bearish" | null. */
  private parseStockTwitsSentiment(msg: StockTwitsMessage): number | null {
    const basic = msg.entities?.sentiment?.basic;
    if (basic === 'Bullish') return 0.7;
    if (basic === 'Bearish') return -0.7;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StockTwits API types (subset)
// ─────────────────────────────────────────────────────────────────────────────

interface StockTwitsResponse {
  response?: { status?: number };
  messages?: StockTwitsMessage[];
}

interface StockTwitsMessage {
  id?: number;
  body?: string;
  created_at?: string;
  symbols?: Array<{ symbol?: string }>;
  entities?: {
    sentiment?: { basic?: 'Bullish' | 'Bearish' | null };
  };
}
