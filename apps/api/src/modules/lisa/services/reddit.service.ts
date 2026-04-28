import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EodhdNewsItem } from './eodhd-enrichment.service';

/**
 * RedditService — flux retail/sentiment depuis Reddit (r/wallstreetbets,
 * r/stocks, r/investing, r/CryptoCurrency).
 *
 * Auth : OAuth client_credentials (gratuit, créer une app sur
 * https://www.reddit.com/prefs/apps en mode "script", récupérer
 * client_id + client_secret + user-agent custom).
 *
 * Variables env requises :
 *  - REDDIT_CLIENT_ID
 *  - REDDIT_CLIENT_SECRET
 *  - REDDIT_USER_AGENT (ex: "smartvest-news/1.0 by u/yourname")
 *
 * Si une de ces variables est absente, le service est désactivé proprement
 * (retourne []). Pas d'erreur levée — le pipeline news fonctionne sans.
 *
 * Subreddits exploités :
 *  - wallstreetbets : sentiment retail US options/meme stocks
 *  - stocks : analyse plus posée
 *  - investing : long-term sentiment
 *  - CryptoCurrency : crypto specific
 *
 * Détection de tickers : regex \$TICKER ou TICKER en MAJUSCULES dans le
 * titre. Sentiment : heuristique sur upvote_ratio + score + flair (DD = +,
 * Loss = -, Gain = +).
 */
@Injectable()
export class RedditService {
  private readonly logger = new Logger(RedditService.name);
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly cache: Map<string, { data: EodhdNewsItem[]; asOf: number }> = new Map();
  private readonly CACHE_MS = 10 * 60 * 1000; // 10 min (Reddit rate limit strict)

  /**
   * P1 PR E — Rolling history des engagements pour computing redditSpikeSigma.
   *
   * Chaque appel `fetchHotPosts` push la somme des scores des posts du
   * cycle dans cet historique. Sigma = (current - mean) / stddev, calculé
   * sur les N derniers samples.
   *
   * Capacité 24 (≈ 4h à 1 cycle / 10min cache). En mémoire, perdu au
   * redeploy — la sigma redevient null pendant les 10 premiers cycles
   * post-redeploy (insufficient samples), puis reprend.
   *
   * Pour une sigma plus robuste cross-redeploy, persister dans une table
   * `reddit_engagement_history` est une PR future.
   */
  private readonly engagementHistory: number[] = [];
  private readonly ENGAGEMENT_HISTORY_MAX = 24;
  private readonly ENGAGEMENT_MIN_SAMPLES_FOR_SIGMA = 10;

  // Tickers communs détectables — on évite de matcher des mots de 3 lettres
  // génériques (THE, AND, FOR…). Mapping élargi côté NewsRanker SECTOR_MAP.
  private static readonly KNOWN_TICKERS = new Set([
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NVDA', 'TSLA', 'AMD',
    'INTC', 'NFLX', 'CRM', 'ORCL', 'ADBE', 'JPM', 'BAC', 'GS', 'MS',
    'WFC', 'V', 'MA', 'JNJ', 'UNH', 'PFE', 'LLY', 'XOM', 'CVX', 'KO',
    'PEP', 'WMT', 'COST', 'KLAC', 'AMAT', 'LRCX', 'ASML', 'AVGO', 'COIN',
    'MSTR', 'GLD', 'GDX', 'SLV', 'TLT', 'IEF', 'HYG', 'SPY', 'QQQ', 'IWM',
    'BTC', 'ETH', 'SOL', 'BNB', 'GME', 'AMC', 'PLTR', 'SOFI', 'NIO',
    'RIVN', 'LCID', 'F', 'GM', 'BABA', 'PYPL', 'SQ', 'SNOW', 'NET',
    'CRWD', 'DDOG', 'ZM', 'HOOD', 'ALAB', 'SMCI',
  ]);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('REDDIT_CLIENT_ID')
      && this.config.get<string>('REDDIT_CLIENT_SECRET')
      && this.config.get<string>('REDDIT_USER_AGENT'),
    );
  }

  /** Top hot posts sur les subreddits financiers, last 24h. */
  async fetchHotPosts(limit = 25): Promise<EodhdNewsItem[]> {
    if (!this.isConfigured()) return [];

    const cacheKey = `hot:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.data;

    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'CryptoCurrency'];
    const tasks = subreddits.map((s) => this.fetchSubreddit(s, Math.ceil(limit / subreddits.length)));
    const results = await Promise.allSettled(tasks);
    const all = results
      .filter((r): r is PromiseFulfilledResult<EodhdNewsItem[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // Tri par score descendant (proxy importance) + cap
    all.sort((a, b) => {
      const aScore = parseInt(a.tags.find((t) => t.startsWith('score:'))?.slice(6) ?? '0', 10);
      const bScore = parseInt(b.tags.find((t) => t.startsWith('score:'))?.slice(6) ?? '0', 10);
      return bScore - aScore;
    });
    const out = all.slice(0, limit);
    this.cache.set(cacheKey, { data: out, asOf: Date.now() });

    // P1 PR E — record engagement (somme des scores) pour rolling sigma.
    // Note : ne push QUE si on a vraiment fetché (cache hit ne re-push pas).
    this.recordEngagement(out);

    return out;
  }

  /**
   * P1 PR E — Push la somme des scores des posts dans l'historique
   * d'engagement (capped à ENGAGEMENT_HISTORY_MAX). Ignoré si items vide.
   */
  private recordEngagement(items: EodhdNewsItem[]): void {
    if (items.length === 0) return;
    const totalScore = items.reduce((sum, item) => {
      const scoreTag = item.tags.find((t) => t.startsWith('score:'));
      const score = scoreTag ? parseInt(scoreTag.slice(6), 10) : 0;
      return sum + (Number.isFinite(score) && score > 0 ? score : 0);
    }, 0);
    this.engagementHistory.push(totalScore);
    if (this.engagementHistory.length > this.ENGAGEMENT_HISTORY_MAX) {
      this.engagementHistory.shift();
    }
  }

  /**
   * P1 PR E — Z-score de l'engagement courant vs rolling baseline.
   *
   * Sigma = (current - mean(history)) / stddev(history).
   *
   * Retourne null si :
   *  - Insufficient samples (<10)
   *  - Stddev = 0 (tous les samples identiques, division par zéro)
   *
   * Le classifier teste `redditSpikeSigma > 5` pour trigger NEWS_SHOCK.
   */
  getSpikeSigma(): number | null {
    if (this.engagementHistory.length < this.ENGAGEMENT_MIN_SAMPLES_FOR_SIGMA) {
      return null;
    }
    const current = this.engagementHistory[this.engagementHistory.length - 1];
    const baseline = this.engagementHistory.slice(0, -1); // exclut le sample courant
    if (baseline.length === 0) return null;
    const mean = baseline.reduce((s, x) => s + x, 0) / baseline.length;
    const variance = baseline.reduce((s, x) => s + (x - mean) * (x - mean), 0) / baseline.length;
    const stddev = Math.sqrt(variance);
    if (stddev === 0) return null;
    return (current - mean) / stddev;
  }

  /**
   * P1 PR E — Test helper / admin reset.
   */
  resetEngagementHistory(): void {
    this.engagementHistory.length = 0;
  }

  // ────────────────────────────────────────────────────────────────────

  private async fetchSubreddit(name: string, limit: number): Promise<EodhdNewsItem[]> {
    const token = await this.getAccessToken();
    if (!token) return [];

    const url = `https://oauth.reddit.com/r/${name}/hot?limit=${limit}&t=day&raw_json=1`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': this.config.get<string>('REDDIT_USER_AGENT') ?? 'smartvest-news/1.0',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.debug(`reddit ${name} HTTP ${res.status}`);
        return [];
      }
      const json = await res.json() as RedditListing;
      if (!json.data?.children) return [];

      return json.data.children
        .filter((c): c is { kind: string; data: RedditPost } =>
          c.kind === 't3' && Boolean(c.data) && !c.data?.stickied)
        .map((c) => this.normalizePost(c.data, name))
        .filter((p): p is EodhdNewsItem => p !== null);
    } catch (e) {
      this.logger.debug(`reddit ${name} fetch error: ${String(e).slice(0, 120)}`);
      return [];
    }
  }

  private normalizePost(post: RedditPost, subreddit: string): EodhdNewsItem | null {
    const title = post.title?.slice(0, 200) ?? '';
    if (!title) return null;
    const tickers = this.extractTickers(title);
    const sentiment = this.heuristicSentiment(post);
    const created = post.created_utc
      ? new Date(post.created_utc * 1000).toISOString()
      : new Date().toISOString();

    return {
      title,
      date: created,
      symbols: tickers.slice(0, 5),
      sentiment,
      tags: [
        `score:${post.score ?? 0}`,
        `r/${subreddit}`,
        ...(post.link_flair_text ? [`flair:${post.link_flair_text.slice(0, 30)}`] : []),
      ],
      link: post.permalink ? `https://reddit.com${post.permalink}` : null,
      sourceDomain: `reddit.com/r/${subreddit}`,
      contentPreview: post.selftext ? post.selftext.slice(0, 400) : null,
      provider: 'reddit' as const,
    };
  }

  /** Détecte $TICKER ou TICKER (4+ majuscules) si présent dans KNOWN_TICKERS. */
  private extractTickers(text: string): string[] {
    const found = new Set<string>();
    // Format $TICKER
    const dollarMatches = text.match(/\$([A-Z]{1,5})\b/g) ?? [];
    for (const m of dollarMatches) {
      const t = m.slice(1);
      if (RedditService.KNOWN_TICKERS.has(t)) found.add(t);
    }
    // Format ALL CAPS standalone (pour BTC, ETH, GME, etc.)
    const capsMatches = text.match(/\b[A-Z]{2,5}\b/g) ?? [];
    for (const m of capsMatches) {
      if (RedditService.KNOWN_TICKERS.has(m)) found.add(m);
    }
    return Array.from(found);
  }

  /**
   * Heuristique sentiment Reddit :
   *  - flair "Loss" / "DD" / "YOLO" / "Gain" → biais clair
   *  - upvote_ratio >= 0.85 + score élevé → +0.5
   *  - upvote_ratio < 0.55 → -0.5 (controverse)
   *  - mots-clés titre "rip", "crash", "puts" → -0.3 ; "moon", "calls", "lfg" → +0.3
   */
  private heuristicSentiment(post: RedditPost): number | null {
    const flair = (post.link_flair_text ?? '').toLowerCase();
    if (flair.includes('loss')) return -0.7;
    if (flair.includes('gain')) return 0.7;
    if (flair.includes('dd')) return 0.3; // DD posts généralement bullish
    if (flair.includes('shitpost') || flair.includes('meme')) return null;

    const titleLower = (post.title ?? '').toLowerCase();
    let score = 0;
    const bullKws = ['moon', 'calls', 'long', 'lfg', 'rocket', 'breakout', 'beat'];
    const bearKws = ['puts', 'short', 'crash', 'rip', 'bagholder', 'dump', 'miss'];
    for (const k of bullKws) if (titleLower.includes(k)) score += 0.2;
    for (const k of bearKws) if (titleLower.includes(k)) score -= 0.2;

    if (score === 0) {
      const ratio = post.upvote_ratio ?? 0.5;
      if (ratio >= 0.85 && (post.score ?? 0) > 100) return 0.4;
      if (ratio < 0.55) return -0.4;
      return null;
    }
    return Math.max(-1, Math.min(1, score));
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) {
      return this.accessToken.value;
    }
    const id = this.config.get<string>('REDDIT_CLIENT_ID');
    const secret = this.config.get<string>('REDDIT_CLIENT_SECRET');
    const ua = this.config.get<string>('REDDIT_USER_AGENT');
    if (!id || !secret || !ua) return null;

    try {
      const auth = Buffer.from(`${id}:${secret}`).toString('base64');
      const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ua,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        this.logger.warn(`reddit auth failed HTTP ${res.status}`);
        return null;
      }
      const json = await res.json() as { access_token?: string; expires_in?: number };
      if (!json.access_token) return null;
      this.accessToken = {
        value: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000, // 60s buffer
      };
      return this.accessToken.value;
    } catch (e) {
      this.logger.warn(`reddit auth error: ${String(e).slice(0, 120)}`);
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reddit API types (subset)
// ─────────────────────────────────────────────────────────────────────────────

interface RedditListing {
  data?: {
    children?: Array<{ kind: string; data?: RedditPost }>;
  };
}

interface RedditPost {
  title?: string;
  selftext?: string;
  created_utc?: number;
  score?: number;
  upvote_ratio?: number;
  permalink?: string;
  link_flair_text?: string | null;
  stickied?: boolean;
}
