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

    // P3-D fix 5 — cap retail social (StockTwits + Reddit + Twitter) à
    // STOCKTWITS_MAX_RATIO du total pour éviter que Lisa raisonne
    // narrativement sur des flux retail bruyants. EODHD (Reuters/Bloomberg
    // tier 1) reste prioritaire. Ratio configurable via env, default 30%.
    const cappedAll = capRetailSocialItems(all, this.STOCKTWITS_MAX_RATIO);
    const droppedRetail = all.length - cappedAll.length;
    if (droppedRetail > 0) {
      this.logger.debug(
        `[news-aggregator] capped retail social: -${droppedRetail} items dropped to respect ${(this.STOCKTWITS_MAX_RATIO * 100).toFixed(0)}% ratio`,
      );
    }

    const elapsedMs = Date.now() - tStart;
    this.logger.debug(
      `news aggregate ${cappedAll.length}/${all.length} items in ${elapsedMs}ms — ${sources.map((s) => `${s.provider}=${s.count}${s.ok ? '' : '✗'}`).join(' ')}`,
    );

    return { items: cappedAll, sources, elapsedMs };
  }

  /** P3-D — Plafond retail social (StockTwits/Reddit/Twitter) sur le
   *  briefing news fourni à Lisa. Default 0.30 (30%). Surchargeable via
   *  env STOCKTWITS_MAX_RATIO mais on garde le name pour compat. */
  private readonly STOCKTWITS_MAX_RATIO = 0.30;

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
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P3-D — Plafonne les items retail (stocktwits/reddit/twitter) à
 * `maxRatio` du total. Conserve les items EODHD entiers (tier 1
 * Reuters/Bloomberg/MarketWatch). Coupe d'abord les items retail
 * sans symbole reconnu (les plus bruyants).
 *
 * Pure function pour test direct.
 */
export function capRetailSocialItems(
  items: EodhdNewsItem[],
  maxRatio: number,
): EodhdNewsItem[] {
  const RETAIL: NewsProvider[] = ['stocktwits', 'reddit', 'twitter'];
  const isRetail = (n: EodhdNewsItem) => RETAIL.includes((n.provider ?? 'eodhd') as NewsProvider);

  const eodhd = items.filter((n) => !isRetail(n));
  const retail = items.filter((n) => isRetail(n));

  if (items.length === 0) return [];
  // total cible où retail = maxRatio × total → eodhd = (1 - maxRatio) × total
  // donc total max = eodhd / (1 - maxRatio), et retailKeep = total - eodhd
  if (maxRatio <= 0) return eodhd;
  if (maxRatio >= 1) return items;
  const totalMax = Math.floor(eodhd.length / (1 - maxRatio));
  const retailKeep = Math.max(0, totalMax - eodhd.length);
  if (retail.length <= retailKeep) return items; // ratio déjà respecté

  // Priorisation : items retail avec symbole > sans symbole
  const retailWithSym = retail.filter((n) => n.symbols && n.symbols.length > 0);
  const retailNoSym = retail.filter((n) => !n.symbols || n.symbols.length === 0);
  const kept = [...retailWithSym, ...retailNoSym].slice(0, retailKeep);
  return [...eodhd, ...kept];
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
