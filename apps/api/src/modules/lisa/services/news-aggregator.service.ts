import { Injectable, Logger } from '@nestjs/common';
import type { EodhdNewsItem, NewsProvider } from './eodhd-enrichment.service';
import { EodhdEnrichmentService } from './eodhd-enrichment.service';
import { StockTwitsService } from './stocktwits.service';
import { RedditService } from './reddit.service';
import { TwitterService } from './twitter.service';

/**
 * NewsAggregatorService — orchestre les 4 sources news (EODHD, StockTwits,
 * Reddit, Twitter), les fusionne en un flux unifié, gère les failures
 * partielles proprement.
 *
 * Chaque source est appelée en parallèle. Si une source échoue ou n'est
 * pas configurée (Reddit/Twitter sans clés), elle retourne [] et les
 * autres continuent. Aucun garde-fou bloquant — on prend ce qu'on peut.
 *
 * Le résultat est passé tel quel au NewsRanker qui se charge du scoring,
 * du dédoublonnage et de la détection de convergence cross-source.
 */
@Injectable()
export class NewsAggregatorService {
  private readonly logger = new Logger(NewsAggregatorService.name);

  constructor(
    private readonly eodhd: EodhdEnrichmentService,
    private readonly stocktwits: StockTwitsService,
    private readonly reddit: RedditService,
    private readonly twitter: TwitterService,
  ) {}

  /**
   * Agrège les news de toutes les sources.
   *
   * @param heldSymbols Tickers du portefeuille (utilisé par StockTwits
   *   et Twitter pour fetcher des flux ciblés en plus du flux général)
   * @param eodhdLimit Limite EODHD (défaut 30)
   */
  async aggregate(heldSymbols: string[], eodhdLimit = 30): Promise<AggregateResult> {
    const tStart = Date.now();
    const [eodhdRes, stocktwitsRes, redditRes, twitterRes] = await Promise.allSettled([
      this.eodhd.fetchRecentNews(undefined, eodhdLimit),
      this.stocktwits.fetchBatch(heldSymbols, true),
      this.reddit.fetchHotPosts(25),
      this.twitter.fetchBatch(heldSymbols),
    ]);

    const sources: ProviderStats[] = [];
    const all: EodhdNewsItem[] = [];

    const pushResult = (
      provider: NewsProvider,
      res: PromiseSettledResult<EodhdNewsItem[]>,
    ): void => {
      if (res.status === 'fulfilled') {
        // Force le provider tag (au cas où une source aurait oublié)
        const tagged = res.value.map((n) => ({ ...n, provider: n.provider ?? provider }));
        all.push(...tagged);
        sources.push({ provider, count: tagged.length, ok: true });
      } else {
        sources.push({ provider, count: 0, ok: false, error: String(res.reason).slice(0, 200) });
      }
    };

    pushResult('eodhd', eodhdRes);
    pushResult('stocktwits', stocktwitsRes);
    pushResult('reddit', redditRes);
    pushResult('twitter', twitterRes);

    const elapsedMs = Date.now() - tStart;
    this.logger.debug(
      `news aggregate ${all.length} items in ${elapsedMs}ms — ${sources.map((s) => `${s.provider}=${s.count}${s.ok ? '' : '✗'}`).join(' ')}`,
    );

    return { items: all, sources, elapsedMs };
  }

  /** État de configuration (utile pour endpoint diagnostique). */
  status(): {
    eodhd: boolean;
    stocktwits: boolean;
    reddit: boolean;
    twitter: boolean;
  } {
    return {
      eodhd: true, // toujours dispo si EODHD_API_KEY présent (géré côté service)
      stocktwits: true, // API publique sans clé
      reddit: this.reddit.isConfigured(),
      twitter: this.twitter.isConfigured(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AggregateResult {
  items: EodhdNewsItem[];
  sources: ProviderStats[];
  elapsedMs: number;
}

export interface ProviderStats {
  provider: NewsProvider;
  count: number;
  ok: boolean;
  error?: string;
}
