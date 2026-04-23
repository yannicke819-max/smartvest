import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { RealtimePriceService } from './realtime-price.service';

/**
 * EodhdEnrichmentService — wrappers autour des endpoints EODHD Premium
 * (plan All-In-One $99.99/mois inclut tout ce qui est utilisé ici) :
 *
 *  - /api/news : actualités financières filtrables par ticker
 *  - /api/economic-events : calendrier économique (FOMC, NFP, CPI, etc.)
 *  - /api/calendar/earnings : earnings calendar par ticker
 *  - /api/fundamentals/{sym} : fondamentaux détaillés d'un ticker
 *
 * Tout passe par le log eodhd_request_log pour respecter le hard cap
 * quota (95k/j). Caching par type de donnée pour minimiser la conso :
 *  - News : 5 min (turnover rapide)
 *  - Events calendar : 1h (stable intraday)
 *  - Earnings : 1h (dates fixes)
 *  - Fundamentals : 24h (quasi jamais de changement intraday)
 */
@Injectable()
export class EodhdEnrichmentService {
  private readonly logger = new Logger(EodhdEnrichmentService.name);

  // Caches en mémoire avec TTL par type
  private newsCache: { data: EodhdNewsItem[]; asOf: number } | null = null;
  private eventsCache: { data: EodhdEconomicEvent[]; asOf: number } | null = null;
  private earningsCache: Map<string, { data: EodhdEarning[]; asOf: number }> = new Map();
  private fundamentalsCache: Map<string, { data: EodhdFundamentalSummary | null; asOf: number }> = new Map();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly realtimePrice: RealtimePriceService,
  ) {}

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  /** Log fire-and-forget d'un appel EODHD pour le tracking quota. */
  private logCall(row: {
    ticker: string;
    success: boolean;
    statusCode?: number;
    latencyMs?: number;
    calledBy: string;
    errorMessage?: string;
  }): void {
    (async () => {
      try {
        await this.supabase.getClient().from('eodhd_request_log').insert({
          ticker: row.ticker,
          eodhd_ticker: row.ticker,
          source: 'eodhd',
          success: row.success,
          status_code: row.statusCode ?? null,
          latency_ms: row.latencyMs ?? null,
          called_by: row.calledBy,
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  /**
   * Récupère les news récentes filtrées par tickers (si fournis) ou globales.
   * Cache 5 minutes.
   */
  async fetchRecentNews(symbols?: string[], limit = 20): Promise<EodhdNewsItem[]> {
    const CACHE_MS = 5 * 60 * 1000;
    if (this.newsCache && Date.now() - this.newsCache.asOf < CACHE_MS) {
      return this.newsCache.data;
    }

    const key = this.apiKey();
    if (!key) return [];

    const tStart = Date.now();
    try {
      // EODHD News API : /api/news?api_token=X&s=SYMBOL&limit=N
      // Si plusieurs symbols, on prend general tickers trending (pas de filter)
      const symbolParam = symbols && symbols.length === 1 ? `&s=${encodeURIComponent(symbols[0])}` : '';
      const url = `https://eodhd.com/api/news?api_token=${key}&limit=${limit}${symbolParam}&fmt=json`;
      this.realtimePrice.recordEodhdCall();
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;

      if (!res.ok) {
        this.logCall({ ticker: 'NEWS', success: false, statusCode: res.status, latencyMs, calledBy: 'enrichment_news', errorMessage: `HTTP_${res.status}` });
        return [];
      }
      const raw = await res.json() as Array<Record<string, unknown>>;
      const items: EodhdNewsItem[] = (raw ?? []).slice(0, limit).map((n) => ({
        title: String(n.title ?? '').slice(0, 200),
        date: String(n.date ?? ''),
        symbols: Array.isArray(n.symbols) ? (n.symbols as string[]).slice(0, 5) : [],
        sentiment: extractSentiment(n),
        tags: Array.isArray(n.tags) ? (n.tags as string[]).slice(0, 5) : [],
      }));

      this.logCall({ ticker: 'NEWS', success: true, statusCode: res.status, latencyMs, calledBy: 'enrichment_news' });
      this.newsCache = { data: items, asOf: Date.now() };
      return items;
    } catch (e) {
      this.logCall({ ticker: 'NEWS', success: false, latencyMs: Date.now() - tStart, calledBy: 'enrichment_news', errorMessage: String(e).slice(0, 200) });
      return [];
    }
  }

  /**
   * Calendrier économique (CPI, NFP, FOMC, GDP, etc.) sur une fenêtre future.
   * Cache 1 heure.
   *
   * importanceMin défaut 1 (tous événements) pour maximiser la visibilité de
   * Lisa. Passer à 2 ou 3 si trop de bruit. EODHD importance : 1=low, 2=medium,
   * 3=high (FOMC, NFP, CPI, ECB…).
   */
  async fetchUpcomingEconomicEvents(daysAhead = 7, importanceMin: 1 | 2 | 3 = 1): Promise<EodhdEconomicEvent[]> {
    const CACHE_MS = 60 * 60 * 1000;
    if (this.eventsCache && Date.now() - this.eventsCache.asOf < CACHE_MS) {
      return this.eventsCache.data;
    }

    const key = this.apiKey();
    if (!key) return [];

    const tStart = Date.now();
    try {
      const now = new Date();
      const to = new Date(now.getTime() + daysAhead * 86_400_000);
      const fromStr = now.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      this.realtimePrice.recordEodhdCall();
      const url = `https://eodhd.com/api/economic-events?api_token=${key}&from=${fromStr}&to=${toStr}&limit=100&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;

      if (!res.ok) {
        this.logCall({ ticker: 'ECON', success: false, statusCode: res.status, latencyMs, calledBy: 'enrichment_econ', errorMessage: `HTTP_${res.status}` });
        return [];
      }
      const raw = await res.json() as Array<Record<string, unknown>>;
      const items: EodhdEconomicEvent[] = (raw ?? [])
        .map((e) => ({
          name: String(e.type ?? e.event ?? 'unknown'),
          country: String(e.country ?? ''),
          date: String(e.date ?? ''),
          importance: Number(e.importance ?? 1) as 1 | 2 | 3,
          estimate: e.estimate != null ? String(e.estimate) : null,
          previous: e.previous != null ? String(e.previous) : null,
        }))
        .filter((e) => e.importance >= importanceMin);

      this.logCall({ ticker: 'ECON', success: true, statusCode: res.status, latencyMs, calledBy: 'enrichment_econ' });
      this.eventsCache = { data: items, asOf: Date.now() };
      return items;
    } catch (e) {
      this.logCall({ ticker: 'ECON', success: false, latencyMs: Date.now() - tStart, calledBy: 'enrichment_econ', errorMessage: String(e).slice(0, 200) });
      return [];
    }
  }

  /**
   * Earnings calendar pour une liste de symboles, sur N jours à venir.
   * Cache 1 heure par symbole.
   */
  async fetchEarningsForSymbols(symbols: string[], daysAhead = 14): Promise<EodhdEarning[]> {
    if (symbols.length === 0) return [];
    const key = this.apiKey();
    if (!key) return [];

    const CACHE_MS = 60 * 60 * 1000;
    const now = Date.now();

    // Filter out already cached entries
    const toFetch = symbols.filter((s) => {
      const c = this.earningsCache.get(s);
      return !c || (now - c.asOf > CACHE_MS);
    });
    const cached = symbols
      .map((s) => this.earningsCache.get(s)?.data ?? [])
      .flat();

    if (toFetch.length === 0) return cached;

    const fromStr = new Date(now).toISOString().slice(0, 10);
    const toStr = new Date(now + daysAhead * 86_400_000).toISOString().slice(0, 10);

    const tStart = Date.now();
    try {
      this.realtimePrice.recordEodhdCall();
      const symList = toFetch.map((s) => encodeURIComponent(this.toEodhdTicker(s))).join(',');
      const url = `https://eodhd.com/api/calendar/earnings?api_token=${key}&symbols=${symList}&from=${fromStr}&to=${toStr}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;

      if (!res.ok) {
        this.logCall({ ticker: 'EARN', success: false, statusCode: res.status, latencyMs, calledBy: 'enrichment_earnings', errorMessage: `HTTP_${res.status}` });
        return cached;
      }
      const raw = await res.json() as { earnings?: Array<Record<string, unknown>> };
      const items: EodhdEarning[] = (raw.earnings ?? []).map((e) => ({
        symbol: String(e.code ?? e.symbol ?? ''),
        reportDate: String(e.report_date ?? ''),
        epsEstimate: e.estimate != null ? Number(e.estimate) : null,
        epsActual: e.actual != null ? Number(e.actual) : null,
        revenueEstimate: e.estimate_revenue != null ? Number(e.estimate_revenue) : null,
      }));

      // Repopule cache (même en cas de 0 résultats — évite refetch en boucle)
      for (const sym of toFetch) {
        this.earningsCache.set(sym, {
          data: items.filter((e) => e.symbol.toUpperCase().includes(sym.toUpperCase())),
          asOf: now,
        });
      }

      this.logCall({ ticker: 'EARN', success: true, statusCode: res.status, latencyMs, calledBy: 'enrichment_earnings' });
      return [...cached, ...items];
    } catch (e) {
      this.logCall({ ticker: 'EARN', success: false, latencyMs: Date.now() - tStart, calledBy: 'enrichment_earnings', errorMessage: String(e).slice(0, 200) });
      return cached;
    }
  }

  /**
   * Fondamentaux synthétiques d'un symbole (P/E, beta, revenue growth, div yield).
   * Cache 24h. Ne retourne rien pour crypto / FX / commodities (pas applicable).
   */
  async fetchKeyFundamentals(symbol: string): Promise<EodhdFundamentalSummary | null> {
    const s = symbol.toUpperCase();
    // Exclusions : classes d'actifs sans fondamentaux
    if (s.includes('USDT') || s.includes('USD.CC') || s.includes('.FOREX')
        || s.includes('.COMM') || s.includes('.BOND') || ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE'].includes(s)) {
      return null;
    }

    const CACHE_MS = 24 * 60 * 60 * 1000;
    const cached = this.fundamentalsCache.get(s);
    if (cached && Date.now() - cached.asOf < CACHE_MS) {
      return cached.data;
    }

    const key = this.apiKey();
    if (!key) return null;

    const tStart = Date.now();
      this.realtimePrice.recordEodhdCall();
    try {
      const ticker = this.toEodhdTicker(s);
      const url = `https://eodhd.com/api/fundamentals/${encodeURIComponent(ticker)}?api_token=${key}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const latencyMs = Date.now() - tStart;

      if (!res.ok) {
        this.logCall({ ticker: s, success: false, statusCode: res.status, latencyMs, calledBy: 'enrichment_fundamentals', errorMessage: `HTTP_${res.status}` });
        this.fundamentalsCache.set(s, { data: null, asOf: Date.now() });
        return null;
      }
      const raw = await res.json() as Record<string, unknown>;
      const summary = extractFundamentalSummary(raw);

      this.logCall({ ticker: s, success: true, statusCode: res.status, latencyMs, calledBy: 'enrichment_fundamentals' });
      this.fundamentalsCache.set(s, { data: summary, asOf: Date.now() });
      return summary;
    } catch (e) {
      this.logCall({ ticker: s, success: false, latencyMs: Date.now() - tStart, calledBy: 'enrichment_fundamentals', errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /** Helper : convertit un symbole SmartVest en ticker EODHD (ex: AAPL → AAPL.US). */
  private toEodhdTicker(symbol: string): string {
    const s = symbol.toUpperCase();
    if (s.includes('.')) return s;
    return `${s}.US`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EodhdNewsItem {
  title: string;
  date: string;
  symbols: string[];
  sentiment: number | null; // -1 (très négatif) → +1 (très positif), ou null si absent
  tags: string[];
}

export interface EodhdEconomicEvent {
  name: string;
  country: string;
  date: string;
  importance: 1 | 2 | 3; // 3 = high (FOMC, NFP, CPI)
  estimate: string | null;
  previous: string | null;
}

export interface EodhdEarning {
  symbol: string;
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
}

export interface EodhdFundamentalSummary {
  /** P/E ratio (trailing twelve months). null si N/A ou pertes. */
  pe: number | null;
  /** Forward P/E (basé sur projections analystes). */
  forwardPE: number | null;
  /** Revenue growth YoY en %. */
  revenueGrowthPct: number | null;
  /** Beta vs marché de référence. */
  beta: number | null;
  /** Dividend yield TTM en %. */
  dividendYieldPct: number | null;
  /** Market cap en USD. */
  marketCapUsd: number | null;
  /** Secteur (ex: "Technology"). */
  sector: string | null;
  /** Industrie (ex: "Software - Application"). */
  industry: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers d'extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractSentiment(n: Record<string, unknown>): number | null {
  const s = n.sentiment;
  if (typeof s === 'number') return Math.max(-1, Math.min(1, s));
  if (s && typeof s === 'object' && 'polarity' in s) {
    const p = (s as Record<string, unknown>).polarity;
    if (typeof p === 'number') return Math.max(-1, Math.min(1, p));
  }
  return null;
}

function extractFundamentalSummary(raw: Record<string, unknown>): EodhdFundamentalSummary {
  const highlights = (raw.Highlights ?? {}) as Record<string, unknown>;
  const valuation = (raw.Valuation ?? {}) as Record<string, unknown>;
  const general = (raw.General ?? {}) as Record<string, unknown>;
  const technicals = (raw.Technicals ?? {}) as Record<string, unknown>;

  const toNum = (v: unknown): number | null => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  };

  return {
    pe: toNum(highlights.PERatio) ?? toNum(valuation.TrailingPE),
    forwardPE: toNum(valuation.ForwardPE),
    revenueGrowthPct: toNum(highlights.QuarterlyRevenueGrowthYOY) != null
      ? (toNum(highlights.QuarterlyRevenueGrowthYOY) as number) * 100
      : null,
    beta: toNum(technicals.Beta),
    dividendYieldPct: toNum(highlights.DividendYield) != null
      ? (toNum(highlights.DividendYield) as number) * 100
      : null,
    marketCapUsd: toNum(highlights.MarketCapitalization),
    sector: typeof general.Sector === 'string' ? general.Sector : null,
    industry: typeof general.Industry === 'string' ? general.Industry : null,
  };
}
