import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EodhdNewsItem } from './eodhd-enrichment.service';

/**
 * TwitterService — flux X/Twitter via API v2 Recent Search.
 *
 * Auth : Bearer token (X API v2 Basic plan ~$100/mois pour ~10k tweets/mois,
 * Pro plan ~$5000/mois pour 1M tweets/mois). Sans clé valide, ce service
 * retourne [] proprement — le pipeline news fonctionne sans.
 *
 * Variables env :
 *  - TWITTER_BEARER_TOKEN (optionnel)
 *
 * Stratégie de query : focus sur les FinTwit de qualité en filtrant par
 * hashtags + mots-clés financiers + verified accounts. On évite les retweets
 * pour réduire le bruit.
 *
 * Exemple query construite : `($AAPL OR #AAPL) -is:retweet lang:en`
 *
 * Cache 5 min par symbole pour limiter le quota mensuel (vite épuisé sur
 * Basic plan).
 *
 * NOTE : sans X_API_KEY ce service est désactivé. C'est intentionnel —
 * l'utilisateur peut ajouter la clé plus tard et le pipeline s'enrichira
 * automatiquement.
 */
@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);
  private readonly cache: Map<string, { data: EodhdNewsItem[]; asOf: number }> = new Map();
  private readonly CACHE_MS = 5 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('TWITTER_BEARER_TOKEN'));
  }

  /** Top tweets récents pour un symbole. Retourne [] si non configuré. */
  async fetchForSymbol(symbol: string, maxResults = 20): Promise<EodhdNewsItem[]> {
    if (!this.isConfigured()) return [];

    const cacheKey = `sym:${symbol.toUpperCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.data;

    const token = this.config.get<string>('TWITTER_BEARER_TOKEN');
    if (!token) return [];

    // Query : cashtag $TICKER ou hashtag #TICKER, hors retweets, EN
    const query = encodeURIComponent(`($${symbol} OR #${symbol}) -is:retweet lang:en`);
    const fields = 'created_at,public_metrics,author_id,entities';
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=${Math.min(100, Math.max(10, maxResults))}&tweet.fields=${fields}`;

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        if (res.status === 429) this.logger.warn('twitter rate limit hit');
        else this.logger.debug(`twitter ${symbol} HTTP ${res.status}`);
        this.cache.set(cacheKey, { data: [], asOf: Date.now() });
        return [];
      }
      const json = await res.json() as TwitterSearchResponse;
      if (!json.data) {
        this.cache.set(cacheKey, { data: [], asOf: Date.now() });
        return [];
      }

      const items: EodhdNewsItem[] = json.data.slice(0, maxResults).map((t) => {
        const cashtags = (t.entities?.cashtags ?? []).map((c) => c.tag.toUpperCase());
        const hashtags = (t.entities?.hashtags ?? []).map((h) => h.tag.toUpperCase());
        const allTickers = [...new Set([...cashtags, ...hashtags])].slice(0, 5);
        const sentiment = this.heuristicSentiment(t);
        const text = (t.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
        const engagement = (t.public_metrics?.like_count ?? 0)
          + (t.public_metrics?.retweet_count ?? 0) * 2
          + (t.public_metrics?.reply_count ?? 0);

        return {
          title: text || `(tweet ${t.id ?? ''})`,
          date: t.created_at ?? new Date().toISOString(),
          symbols: allTickers.length > 0 ? allTickers : [symbol.toUpperCase()],
          sentiment,
          tags: [`engagement:${engagement}`],
          link: t.id ? `https://twitter.com/i/web/status/${t.id}` : null,
          sourceDomain: 'twitter.com',
          contentPreview: text,
          provider: 'twitter' as const,
        };
      });

      // Tri par engagement descendant (proxy importance)
      items.sort((a, b) => {
        const aE = parseInt(a.tags.find((t) => t.startsWith('engagement:'))?.slice(11) ?? '0', 10);
        const bE = parseInt(b.tags.find((t) => t.startsWith('engagement:'))?.slice(11) ?? '0', 10);
        return bE - aE;
      });

      this.cache.set(cacheKey, { data: items, asOf: Date.now() });
      return items;
    } catch (e) {
      this.logger.debug(`twitter fetch error: ${String(e).slice(0, 120)}`);
      this.cache.set(cacheKey, { data: [], asOf: Date.now() });
      return [];
    }
  }

  /** Batch fetch pour les symboles tenus. */
  async fetchBatch(symbols: string[]): Promise<EodhdNewsItem[]> {
    if (!this.isConfigured() || symbols.length === 0) return [];
    const tasks = symbols.slice(0, 6).map((s) => this.fetchForSymbol(s, 10));
    const results = await Promise.allSettled(tasks);
    return results
      .filter((r): r is PromiseFulfilledResult<EodhdNewsItem[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }

  // ────────────────────────────────────────────────────────────────────

  private heuristicSentiment(t: TwitterTweet): number | null {
    const text = (t.text ?? '').toLowerCase();
    let score = 0;
    const bullKws = ['🚀', '🌙', 'moon', 'calls', 'long', 'breakout', 'beat', 'bullish', 'lfg', 'pump'];
    const bearKws = ['🩸', '📉', 'puts', 'short', 'crash', 'rip', 'dump', 'miss', 'bearish', 'tank'];
    for (const k of bullKws) if (text.includes(k)) score += 0.15;
    for (const k of bearKws) if (text.includes(k)) score -= 0.15;
    if (score === 0) return null;
    return Math.max(-1, Math.min(1, score));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Twitter API v2 types (subset)
// ─────────────────────────────────────────────────────────────────────────────

interface TwitterSearchResponse {
  data?: TwitterTweet[];
  meta?: { result_count?: number };
}

interface TwitterTweet {
  id?: string;
  text?: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
  entities?: {
    cashtags?: Array<{ tag: string }>;
    hashtags?: Array<{ tag: string }>;
  };
}
