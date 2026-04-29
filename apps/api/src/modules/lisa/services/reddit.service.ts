import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EodhdNewsItem } from './eodhd-enrichment.service';

/**
 * RedditService — flux retail/sentiment depuis Reddit (r/wallstreetbets,
 * r/stocks, r/investing, r/CryptoCurrency, r/options).
 *
 * Deux modes d'accès :
 *
 * 1. **OAuth client_credentials** (préférentiel quand approuvé Reddit)
 *    Variables env : REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET + REDDIT_USER_AGENT
 *    URL : https://oauth.reddit.com/r/{name}/hot?...
 *
 * 2. **RSS/JSON public** (P5-REDDIT-RSS-FALLBACK, no auth)
 *    Activé si :
 *      - REDDIT_USE_RSS=true (override explicite)
 *      - OU aucune credential OAuth présente
 *    URL : https://www.reddit.com/r/{name}/hot.json?limit=25
 *    Requiert User-Agent custom (REDDIT_USER_AGENT ou default
 *    'smartvest-news/1.0' — sinon 429 systématique).
 *    Rate limit ~60 req/min sans auth → cache 5 min.
 *
 * Dans les 2 modes, l'output est strictement identique (EodhdNewsItem),
 * et le rolling engagement history (PR E redditSpikeSigma) est conservé.
 */
@Injectable()
export class RedditService {
  private readonly logger = new Logger(RedditService.name);
  private accessToken: { value: string; expiresAt: number } | null = null;
  private readonly cache: Map<string, { data: EodhdNewsItem[]; asOf: number }> = new Map();

  /** P5-REDDIT-RSS-FALLBACK — Cache plus court en mode RSS public (rate
   *  limit Reddit ~60 req/min sans auth → 5 min suffit pour ne pas se
   *  faire ban tout en gardant la fraîcheur). */
  private get cacheMs(): number {
    return this.useRssMode() ? 5 * 60 * 1000 : 10 * 60 * 1000;
  }

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
    // P5-REDDIT-RSS-FALLBACK — RSS mode dispense des credentials OAuth.
    if (this.useRssMode()) return true;
    return Boolean(
      this.config.get<string>('REDDIT_CLIENT_ID')
      && this.config.get<string>('REDDIT_CLIENT_SECRET')
      && this.config.get<string>('REDDIT_USER_AGENT'),
    );
  }

  /**
   * P5-REDDIT-RSS-FALLBACK — Détecte si on doit utiliser le mode public.
   * Activé explicitement (REDDIT_USE_RSS=true) OU implicitement quand
   * aucune credential OAuth n'est présente. La logique préfère OAuth
   * quand dispo (rate limit plus généreux + user score plus précis).
   */
  private useRssMode(): boolean {
    const explicit = this.config.get<string>('REDDIT_USE_RSS');
    if (explicit === 'true' || explicit === '1') return true;
    const hasOAuth = Boolean(
      this.config.get<string>('REDDIT_CLIENT_ID')
      && this.config.get<string>('REDDIT_CLIENT_SECRET'),
    );
    return !hasOAuth;
  }

  /** P5-REDDIT-RSS-FALLBACK — User-Agent custom OBLIGATOIRE en mode RSS
   *  (axios/node-fetch default = 429 immédiat). Lit REDDIT_USER_AGENT,
   *  fallback safe.
   *
   *  P19f (29/04/2026, observed in prod) — Default UA `smartvest-news/1.0`
   *  receivait HTTP 403 Cloudflare sur 100% des subs. Reddit recommande
   *  le format `<platform>:<app-id>:<version> (by /u/<reddit-username>)`.
   *  Nouveau default conforme + plus discriminant.
   */
  private getUserAgent(): string {
    return this.config.get<string>('REDDIT_USER_AGENT')
      ?? 'web:smartvest-news:v1.1 (by /u/yannicke819-max)';
  }

  /**
   * P19f — Compteur per-cycle des subreddits bloqués (HTTP 403/429/auth-wall).
   * Reset au début de chaque `fetchHotPosts`. Si == subreddits.length à la fin
   * → log warn agrégé (au lieu de 5 × debug par sub) + flag potentiel degraded.
   */
  private blockedSubsThisCycle: string[] = [];
  /** P19f — Compteur cumulatif des cycles totalement bloqués (observability). */
  private totalBlockedCycles = 0;
  /** Exposé pour /lisa/debug-stats — pas de migration DB. */
  getTotalBlockedCycles(): number {
    return this.totalBlockedCycles;
  }

  /** Top hot posts sur les subreddits financiers, last 24h. */
  async fetchHotPosts(limit = 25): Promise<EodhdNewsItem[]> {
    if (!this.isConfigured()) return [];

    const cacheKey = `hot:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.cacheMs) return cached.data;

    // P5-REDDIT-RSS-FALLBACK — élargi à 5 subreddits (ajout `options`)
    // pour capter les flux retail options (squeeze candidats).
    const subreddits = ['wallstreetbets', 'stocks', 'investing', 'CryptoCurrency', 'options'];

    // P19f — Reset compteur per-cycle pour log agrégé en fin
    this.blockedSubsThisCycle = [];

    const tasks = subreddits.map((s) => this.fetchSubreddit(s, Math.ceil(limit / subreddits.length)));
    const results = await Promise.allSettled(tasks);
    const all = results
      .filter((r): r is PromiseFulfilledResult<EodhdNewsItem[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // P19f — Log agrégé une fois en fin de cycle si subs bloqués (au lieu de
    // 5 × debug par sub). Permet de visualiser la santé Reddit d'un coup d'œil.
    if (this.blockedSubsThisCycle.length > 0) {
      const mode = this.useRssMode() ? 'rss' : 'oauth';
      const allBlocked = this.blockedSubsThisCycle.length === subreddits.length;
      this.totalBlockedCycles += allBlocked ? 1 : 0;
      const sample = this.blockedSubsThisCycle.slice(0, 3).join(', ');
      const fixHint = mode === 'rss'
        ? ' — set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET to switch to OAuth (rate-limit 100/min vs ~60/min RSS, plus moins de 403)'
        : '';
      this.logger.warn(
        `[reddit:${mode}] ${this.blockedSubsThisCycle.length}/${subreddits.length} sub(s) blocked this cycle (sample: ${sample})${fixHint}`,
      );
    }

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
    if (this.useRssMode()) return this.fetchSubredditPublic(name, limit);
    return this.fetchSubredditOAuth(name, limit);
  }

  /**
   * P5-REDDIT-RSS-FALLBACK — Mode OAuth (préférentiel quand dispo).
   * Endpoint : oauth.reddit.com (rate limit 100 req/min/account).
   */
  private async fetchSubredditOAuth(name: string, limit: number): Promise<EodhdNewsItem[]> {
    const token = await this.getAccessToken();
    if (!token) return [];

    const url = `https://oauth.reddit.com/r/${name}/hot?limit=${limit}&t=day&raw_json=1`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': this.getUserAgent(),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.debug(`reddit oauth ${name} HTTP ${res.status}`);
        return [];
      }
      const json = await res.json() as RedditListing;
      return this.parseListing(json, name);
    } catch (e) {
      this.logger.debug(`reddit oauth ${name} fetch error: ${String(e).slice(0, 120)}`);
      return [];
    }
  }

  /**
   * P5-REDDIT-RSS-FALLBACK — Mode public (no auth, drop-in fallback).
   * Endpoint : www.reddit.com/r/{name}/hot.json (rate limit ~60 req/min).
   *
   * Pièges critiques :
   *  - User-Agent OBLIGATOIRE custom (default node-fetch → 429 immédiat)
   *  - Reddit renvoie parfois 200 + page HTML login si rate-limit
   *    soft → check Content-Type=application/json
   *  - 429 → backoff exponentiel (2 retries max, 1s puis 3s)
   *
   * P19f (29/04/2026) — Headers enrichis pour réduire les 403 Cloudflare :
   *  - Accept-Language en plus de Accept
   *  - Cache-Control / Pragma plus naturels
   *  - User-Agent au format Reddit-recommended `<platform>:<app-id>:<v> (by /u/<n>)`
   *  - Tracking blockedSubsThisCycle pour log agrégé fin de cycle
   *  - Promotion debug → warn agrégé (visibilité sans spam)
   *
   * Note : si 403 persiste après ces fixes, il faut OAuth Reddit (env
   * REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET → bascule auto en mode oauth).
   */
  private async fetchSubredditPublic(name: string, limit: number): Promise<EodhdNewsItem[]> {
    const url = `https://www.reddit.com/r/${name}/hot.json?limit=${limit}&raw_json=1`;
    const ua = this.getUserAgent();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': ua,
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
          },
          signal: AbortSignal.timeout(8000),
        });

        // Rate-limit : backoff exponentiel
        if (res.status === 429) {
          if (attempt < 2) {
            const wait = 1000 * Math.pow(3, attempt); // 1s, 3s
            this.logger.debug(`reddit rss ${name} 429, retry in ${wait}ms (${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          // P19f — track for end-of-cycle aggregated warn (no per-sub spam)
          this.blockedSubsThisCycle.push(`${name}@429`);
          return [];
        }

        if (!res.ok) {
          // P19f — track 403/4xx/5xx for aggregated warn. Log debug per-sub
          // reste utile pour grep ciblé en debug session.
          this.logger.debug(`reddit rss ${name} HTTP ${res.status}`);
          this.blockedSubsThisCycle.push(`${name}@${res.status}`);
          return [];
        }

        // Reddit peut 200 + page HTML login (auth wall) — check Content-Type
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
          this.logger.debug(`reddit rss ${name} non-JSON (Content-Type=${contentType.slice(0, 60)}) — auth wall ?`);
          this.blockedSubsThisCycle.push(`${name}@authwall`);
          return [];
        }

        const json = await res.json() as RedditListing;
        return this.parseListing(json, name);
      } catch (e) {
        this.logger.debug(`reddit rss ${name} fetch error: ${String(e).slice(0, 120)}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        // P19f — track final fetch error too
        this.blockedSubsThisCycle.push(`${name}@fetchError`);
        return [];
      }
    }
    return [];
  }

  /**
   * Parsing commun listing → EodhdNewsItem[].
   * Filtre sticky posts + posts sans données.
   */
  private parseListing(json: RedditListing, subreddit: string): EodhdNewsItem[] {
    if (!json.data?.children) return [];
    return json.data.children
      .filter((c): c is { kind: string; data: RedditPost } =>
        c.kind === 't3' && Boolean(c.data) && !c.data?.stickied)
      .map((c) => this.normalizePost(c.data, subreddit))
      .filter((p): p is EodhdNewsItem => p !== null);
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
