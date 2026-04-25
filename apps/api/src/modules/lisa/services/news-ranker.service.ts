import { Injectable, Logger } from '@nestjs/common';
import type { EodhdNewsItem, NewsProvider } from './eodhd-enrichment.service';

/**
 * NewsRankerService — pipeline de tri/scoring/dédup des news EODHD avant
 * injection dans le briefing Lisa.
 *
 * Avant ce service : Lisa recevait les 10 news les plus récentes en vrac,
 * sans pertinence par rapport au portefeuille, sans pondération source,
 * sans déduplication. Une news Netflix sur "recession" pouvait squatter
 * une slot critique alors que le portefeuille tient GLD/BTC.
 *
 * Score final (0-100) sur 4 axes pondérés :
 *  - Relevance (40%) : la news touche-t-elle un ticker tenu / une classe
 *    d'actif tenue / un thème macro ?
 *  - Impact (25%) : magnitude du sentiment + mots-clés catalyseur
 *    (Fed/CPI/earnings/guidance/downgrade) → prior d'impact bps
 *  - Freshness (20%) : décroissance exponentielle ; demi-vie 12h en
 *    long_horizon, 3h en hyper_active
 *  - Source tier (15%) : tier 1 = Reuters/Bloomberg/WSJ ; tier 2 =
 *    CNBC/MarketWatch/Yahoo ; tier 3 = blogs/aggregators
 *
 * Filtre dédup : titres dont le hash n-gram est >70% identique → conserve
 * le score max et compte les "réplicas" comme signal de couverture média.
 */
@Injectable()
export class NewsRankerService {
  private readonly logger = new Logger(NewsRankerService.name);

  /**
   * Source tier mapping. Sources premium (Reuters, Bloomberg) ont un
   * scoreMultiplier élevé ; blogs/aggregators non-vérifiés sont déclassés.
   * Liste évolutive — toute source absente reçoit tier 3 par défaut.
   */
  private static readonly SOURCE_TIERS: Record<string, 1 | 2 | 3> = {
    'reuters.com': 1,
    'bloomberg.com': 1,
    'wsj.com': 1,
    'ft.com': 1,
    'apnews.com': 1,
    'bbc.com': 1,
    'cnbc.com': 2,
    'marketwatch.com': 2,
    'yahoo.com': 2,
    'finance.yahoo.com': 2,
    'businesswire.com': 2,
    'prnewswire.com': 2,
    'forbes.com': 2,
    'barrons.com': 2,
    'investing.com': 2,
    'seekingalpha.com': 2,
    'thefly.com': 2,
    // Plateformes retail sentiment structurées — tier 2.
    // StockTwits agrège des votes Bullish/Bearish + cashtags structurés ;
    // ce n'est pas Reuters mais c'est un signal mesurable, pas un blog.
    'stocktwits.com': 2,
    'benzinga.com': 3,
    'fool.com': 3,
    'zacks.com': 3,
    'streetinsider.com': 3,
  };

  /**
   * Mots-clés catalyseur high-impact. Présence dans le titre = +30 sur
   * impactScore (cap 100). Liste évolutive.
   */
  private static readonly CATALYST_KEYWORDS = [
    // Macro Fed / banques centrales
    'fomc', 'fed cut', 'fed hike', 'rate cut', 'rate hike', 'powell',
    'ecb', 'lagarde', 'boj', 'pboc',
    // Indicateurs clés
    'cpi', 'pce', 'nfp', 'jobless', 'gdp', 'pmi', 'ism',
    // Corporate
    'earnings', 'guidance', 'beats', 'misses', 'downgrade', 'upgrade',
    'merger', 'acquisition', 'buyback', 'dividend cut', 'bankruptcy',
    'sec investigation', 'recall', 'fda approval',
    // Geopolitics / risk-off
    'war', 'invasion', 'sanctions', 'oil shock', 'oil spike',
    // Crypto
    'etf approval', 'sec sues', 'hack', 'liquidation cascade',
    // Generic shock
    'crash', 'plunge', 'surge', 'soar', 'breakout',
  ];

  /**
   * Mapping tickers → secteur grossier. Pour relevance "même secteur que
   * positions tenues". Liste évolutive. Tickers absents = pas de mapping
   * sectoriel (relevance par symbole exact uniquement).
   */
  private static readonly SECTOR_MAP: Record<string, string> = {
    // Tech mega-caps
    AAPL: 'tech', MSFT: 'tech', GOOGL: 'tech', GOOG: 'tech', META: 'tech',
    AMZN: 'tech', NVDA: 'tech', TSLA: 'auto-tech', AMD: 'tech', INTC: 'tech',
    NFLX: 'tech', CRM: 'tech', ORCL: 'tech', ADBE: 'tech',
    // Finance
    JPM: 'finance', BAC: 'finance', GS: 'finance', MS: 'finance', C: 'finance',
    WFC: 'finance', BLK: 'finance', V: 'payments', MA: 'payments',
    // Healthcare
    JNJ: 'healthcare', UNH: 'healthcare', PFE: 'healthcare', LLY: 'healthcare',
    MRK: 'healthcare', ABBV: 'healthcare',
    // Energy
    XOM: 'energy', CVX: 'energy', COP: 'energy',
    // Defensive
    KO: 'consumer-staples', PEP: 'consumer-staples', WMT: 'retail',
    PG: 'consumer-staples', COST: 'retail',
    // Semis
    KLAC: 'semis', AMAT: 'semis', LRCX: 'semis', ASML: 'semis', AVGO: 'semis',
    ALAB: 'semis', SMCI: 'semis',
    // Crypto/blockchain proxies
    BTC: 'crypto', ETH: 'crypto', SOL: 'crypto', BNB: 'crypto',
    COIN: 'crypto-equity', MSTR: 'crypto-equity',
    // Gold/safe haven
    GLD: 'gold', GDX: 'gold', GDXJ: 'gold', SLV: 'gold',
    // Bonds / rates
    TLT: 'bonds', IEF: 'bonds', SHY: 'bonds', HYG: 'bonds',
    // Broad
    SPY: 'broad-us', QQQ: 'broad-us', IWM: 'broad-us', DIA: 'broad-us',
  };

  /**
   * Trie + scrore + dédoublonne les news, retourne top N.
   *
   * @param news Brut depuis EODHD
   * @param heldSymbols Tickers actuellement détenus (ex: ['GLD', 'BTC'])
   * @param halfLifeHours Demi-vie de la fraîcheur (12h défaut, 3h en hyper_active)
   * @param maxItems Nombre max à retourner après tri (10 défaut)
   */
  rank(
    news: EodhdNewsItem[],
    heldSymbols: string[],
    halfLifeHours = 12,
    maxItems = 10,
  ): RankedNewsItem[] {
    const heldSet = new Set(heldSymbols.map((s) => s.toUpperCase()));
    const heldSectors = new Set(
      heldSymbols
        .map((s) => NewsRankerService.SECTOR_MAP[s.toUpperCase()])
        .filter((v): v is string => Boolean(v)),
    );
    const now = Date.now();

    const scored: RankedNewsItem[] = news.map((n) => {
      const articleSymbols = (n.symbols ?? []).map((s) => s.toUpperCase());
      const articleSectors = articleSymbols
        .map((s) => NewsRankerService.SECTOR_MAP[s])
        .filter((v): v is string => Boolean(v));

      // ── Relevance ──────────────────────────────────────────────────
      let relevanceScore = 0;
      let relevanceReason = '';
      const directHit = articleSymbols.find((s) => heldSet.has(s));
      const sectorHit = articleSectors.find((s) => heldSectors.has(s));
      const isMacro = this.isMacroNews(n.title, n.tags);
      if (directHit) {
        relevanceScore = 100;
        relevanceReason = `direct hit ${directHit}`;
      } else if (sectorHit) {
        relevanceScore = 60;
        relevanceReason = `sector match ${sectorHit}`;
      } else if (isMacro) {
        relevanceScore = 50;
        relevanceReason = 'macro/Fed';
      } else if (articleSymbols.length === 0) {
        relevanceScore = 25; // général sans tickers = bruit modéré
        relevanceReason = 'general';
      } else {
        relevanceScore = 5;
        relevanceReason = `unrelated (${articleSymbols.slice(0, 2).join(',')})`;
      }

      // ── Impact ────────────────────────────────────────────────────
      // Sentiment EODHD est très généreux (~+0.99/+1.0 sur la majorité des
      // headlines financières "positives par framing"). On clip à 0.7 si
      // pas de catalyst keyword pour éviter que tout passe à impact 100.
      // Un vrai catalyseur (Fed/CPI/earnings/...) lève ce plafond.
      const titleLower = n.title.toLowerCase();
      const catalystHit = NewsRankerService.CATALYST_KEYWORDS.find((kw) =>
        titleLower.includes(kw),
      );
      const rawSent = n.sentiment !== null ? Math.abs(n.sentiment) : 0.3;
      const sentClipped = catalystHit ? rawSent : Math.min(0.7, rawSent);
      const sentMag = sentClipped * 100;
      const impactScore = Math.min(100, sentMag + (catalystHit ? 30 : 0));
      const impactReason = catalystHit
        ? `sentiment ${sentMag.toFixed(0)} + catalyst "${catalystHit}"`
        : `sentiment ${sentMag.toFixed(0)} (clipped)`;

      // ── Freshness ─────────────────────────────────────────────────
      const ageMs = n.date ? Math.max(0, now - new Date(n.date).getTime()) : 0;
      const ageHours = ageMs / 3_600_000;
      const freshnessScore = Math.max(0, 100 * Math.exp(-ageHours / halfLifeHours));

      // ── Source tier ───────────────────────────────────────────────
      const tier = n.sourceDomain
        ? (NewsRankerService.SOURCE_TIERS[n.sourceDomain] ?? 3)
        : 3;
      const sourceScore = tier === 1 ? 100 : tier === 2 ? 70 : 35;

      // ── Final weighted score ──────────────────────────────────────
      const finalScore =
        0.4 * relevanceScore +
        0.25 * impactScore +
        0.2 * freshnessScore +
        0.15 * sourceScore;

      return {
        title: n.title,
        date: n.date,
        symbols: articleSymbols,
        sentiment: n.sentiment,
        tags: n.tags,
        link: n.link,
        sourceDomain: n.sourceDomain,
        contentPreview: n.contentPreview,
        provider: n.provider ?? 'eodhd',
        scores: {
          relevance: Math.round(relevanceScore),
          impact: Math.round(impactScore),
          freshness: Math.round(freshnessScore),
          source: Math.round(sourceScore),
          convergence: 0, // calculé après dédup
          final: Math.round(finalScore),
        },
        rationale: {
          relevance: relevanceReason,
          impact: impactReason,
          ageHours: Math.round(ageHours * 10) / 10,
          sourceTier: tier,
          catalyst: catalystHit ?? null,
          isMacro,
          directHit: directHit ?? null,
          sectorHit: sectorHit ?? null,
          providers: [(n.provider ?? 'eodhd') as NewsProvider],
        },
        replicaCount: 1,
      };
    });

    // ── Dédup par similarité titre + agrégation cross-source ────────
    const deduped = this.dedupByTitleSimilarity(scored, 0.7);

    // ── Convergence boost : bonus si plusieurs providers distincts ──
    //    couvrent le même thème (cluster post-dédup). +5 par provider
    //    additionnel, capé à +20. La logique part du replicaCount + des
    //    providers agrégés pendant la dédup.
    //
    // Pénalité relevance basse : si rel < 20 (news non liée aux positions
    // tenues), on retire 25 pts au final même si impact/freshness sont
    // élevés. Empêche les news off-topic de saturer le bucket pertinent
    // juste parce que le sentiment NLP de l'agrégateur est généreux.
    for (const item of deduped) {
      const distinctProviders = item.rationale.providers.length;
      const convergenceBoost = Math.min(20, Math.max(0, (distinctProviders - 1) * 7));
      item.scores.convergence = convergenceBoost;
      const irrelevancePenalty = item.scores.relevance < 20 ? 25 : 0;
      item.scores.final = Math.max(0, Math.min(100, Math.round(
        0.4 * item.scores.relevance
        + 0.25 * item.scores.impact
        + 0.2 * item.scores.freshness
        + 0.15 * item.scores.source
        + convergenceBoost
        - irrelevancePenalty,
      )));
    }

    // ── Tri + cap ──────────────────────────────────────────────────
    deduped.sort((a, b) => b.scores.final - a.scores.final);
    return deduped.slice(0, maxItems);
  }

  /**
   * Sépare les news rangées en 3 buckets pour le briefing :
   *  - Pertinentes (score ≥ 60) : injectées en détail
   *  - Bruit (score 30-60) : mentionnées en compte
   *  - Écartées (score < 30) : silencieuses
   *
   * Seuils relevés (50→60, 25→30) après observation que sentiment EODHD
   * généreux + impact 100 systématique faisait passer trop de news
   * off-topic dans le bucket pertinent. Combiné avec la pénalité
   * irrelevance -25, le bucket pertinent ne contient plus que les vrais
   * direct hits / catalyseurs / convergences cross-source.
   */
  bucket(ranked: RankedNewsItem[]): NewsBuckets {
    return {
      relevant: ranked.filter((r) => r.scores.final >= 60),
      noise: ranked.filter((r) => r.scores.final >= 30 && r.scores.final < 60),
      discarded: ranked.filter((r) => r.scores.final < 30),
    };
  }

  /**
   * Format texte injecté dans le briefing Lisa. Substitut au mapping naïf
   * actuel (10 headlines + sentiment). Inclut score + rationale par news,
   * permet à Lisa de calibrer son attention.
   */
  formatForBriefing(buckets: NewsBuckets): string {
    if (buckets.relevant.length === 0 && buckets.noise.length === 0) {
      return '(aucune news pertinente détectée — pipeline filtré strict)';
    }

    const lines: string[] = [];
    if (buckets.relevant.length > 0) {
      lines.push(`📰 News pertinentes (${buckets.relevant.length}) — score ≥ 60/100 :`);
      for (const r of buckets.relevant) {
        const tags: string[] = [];
        if (r.rationale.directHit) tags.push(`💼${r.rationale.directHit}`);
        if (r.rationale.sectorHit) tags.push(`🏷️${r.rationale.sectorHit}`);
        if (r.rationale.isMacro) tags.push('🌐macro');
        if (r.rationale.catalyst) tags.push(`⚡${r.rationale.catalyst}`);
        if (r.replicaCount > 1) tags.push(`📡×${r.replicaCount}`);
        // Convergence cross-source : signal renforcé si 2+ providers
        if (r.rationale.providers.length > 1) {
          tags.push(`🔀${r.rationale.providers.join('+')} (+${r.scores.convergence})`);
        }
        const sent = r.sentiment !== null
          ? (r.sentiment >= 0 ? `+${(r.sentiment * 100).toFixed(0)}` : `${(r.sentiment * 100).toFixed(0)}`)
          : '?';
        lines.push(
          `  [${r.scores.final}] ${r.title.slice(0, 110)} ` +
          `(prov=${r.provider} src=${r.sourceDomain ?? '?'} tier=${r.rationale.sourceTier} ` +
          `age=${r.rationale.ageHours}h sent=${sent} ${tags.join(' ')})`,
        );
      }
    }
    if (buckets.noise.length > 0) {
      lines.push(`📰 Bruit (${buckets.noise.length} news, score 30-60) — survol seulement, pas un trigger d'action.`);
      for (const n of buckets.noise.slice(0, 5)) {
        lines.push(`  [${n.scores.final}] ${n.title.slice(0, 90)}`);
      }
    }
    if (buckets.discarded.length > 0) {
      lines.push(`📰 ${buckets.discarded.length} news écartées (score < 30, hors-périmètre).`);
    }
    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private isMacroNews(title: string, tags: string[]): boolean {
    const lower = title.toLowerCase();
    const tagLower = (tags ?? []).map((t) => t.toLowerCase());
    const macroKws = ['fed', 'fomc', 'cpi', 'pce', 'inflation', 'recession',
      'gdp', 'unemployment', 'jobless', 'powell', 'ecb', 'boj',
      'oil price', 'crude', 'dollar', 'dxy', 'yield', 'treasury',
      'geopolitic', 'sanctions', 'tariff', 'trade war'];
    return macroKws.some((kw) => lower.includes(kw))
      || tagLower.some((t) => ['macro', 'central-bank', 'monetary-policy'].includes(t));
  }

  /** Dedup par Jaccard similarity sur 3-grams de titres normalisés. */
  private dedupByTitleSimilarity(
    items: RankedNewsItem[],
    threshold: number,
  ): RankedNewsItem[] {
    const result: RankedNewsItem[] = [];
    const ngramsCache: Set<string>[] = [];

    for (const item of items) {
      const tNgrams = this.titleNgrams(item.title);
      let mergedInto: number | null = null;
      for (let i = 0; i < result.length; i++) {
        const sim = this.jaccard(tNgrams, ngramsCache[i]);
        if (sim >= threshold) {
          mergedInto = i;
          break;
        }
      }
      if (mergedInto !== null) {
        const existing = result[mergedInto];
        existing.replicaCount += 1;
        // Agrège les providers distincts (pour calcul convergence)
        const allProviders = new Set<NewsProvider>([
          ...existing.rationale.providers,
          ...item.rationale.providers,
        ]);
        existing.rationale.providers = Array.from(allProviders);
        // Garde le meilleur score, mais préserve replicaCount + providers
        if (item.scores.final > existing.scores.final) {
          result[mergedInto] = {
            ...item,
            replicaCount: existing.replicaCount,
            rationale: { ...item.rationale, providers: existing.rationale.providers },
          };
          ngramsCache[mergedInto] = tNgrams;
        }
      } else {
        result.push(item);
        ngramsCache.push(tNgrams);
      }
    }
    return result;
  }

  private titleNgrams(title: string): Set<string> {
    const norm = title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = norm.split(' ').filter((t) => t.length > 2);
    const ngrams = new Set<string>();
    for (let i = 0; i < tokens.length - 2; i++) {
      ngrams.add(tokens.slice(i, i + 3).join(' '));
    }
    return ngrams;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RankedNewsItem {
  title: string;
  date: string;
  symbols: string[];
  sentiment: number | null;
  tags: string[];
  link: string | null;
  sourceDomain: string | null;
  contentPreview: string | null;
  provider: NewsProvider;
  scores: {
    relevance: number;
    impact: number;
    freshness: number;
    source: number;
    /** Boost cross-source (0-20). Calculé post-dédup en fonction du
     *  nombre de providers distincts ayant couvert le thème. */
    convergence: number;
    final: number;
  };
  rationale: {
    relevance: string;
    impact: string;
    ageHours: number;
    sourceTier: 1 | 2 | 3;
    catalyst: string | null;
    isMacro: boolean;
    directHit: string | null;
    sectorHit: string | null;
    /** Liste des providers distincts ayant couvert ce thème post-dédup. */
    providers: NewsProvider[];
  };
  /** Nombre d'articles dédoublonnés sur ce thème (≥1, signal de couverture). */
  replicaCount: number;
}

export interface NewsBuckets {
  relevant: RankedNewsItem[];
  noise: RankedNewsItem[];
  discarded: RankedNewsItem[];
}
