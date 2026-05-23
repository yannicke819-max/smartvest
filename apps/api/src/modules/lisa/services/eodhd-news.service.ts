/**
 * EodhdNewsService — pull + persistance news ticker-spécifiques (étape 1).
 *
 * Endpoint EODHD : GET /api/news?s=TICKER&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&fmt=json
 *
 * Payload typique :
 *   { date, title, content, link, sentiment: { polarity, neg, neu, pos }, symbols, tags }
 *
 * Persistance dans `eodhd_news_articles`. Dedupe via UNIQUE (ticker, external_id)
 * où external_id = hash stable (date + 32 1ers chars du titre).
 *
 * Gating : `EODHD_NEWS_PERSIST_ENABLED` (default false). Tant que false, aucune
 * écriture, aucun appel API.
 *
 * Queries publiques :
 *   - `getRecentNewsForTicker(ticker, hoursBack)` : lit la DB, jamais l'API live
 *   - `fetchAndPersist(tickers, fromDate, toDate)` : pull API + UPSERT
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { createHash } from 'node:crypto';

export interface PersistedNewsArticle {
  ticker: string;
  external_id: string;
  published_at: string; // ISO
  title: string;
  content: string | null;
  source_url: string | null;
  sentiment_polarity: number | null;
  sentiment_neg: number | null;
  sentiment_neu: number | null;
  sentiment_pos: number | null;
  tags: string[];
  related_symbols: string[];
}

interface EodhdNewsRaw {
  date?: string;
  title?: string;
  content?: string;
  link?: string;
  sentiment?: { polarity?: number; neg?: number; neu?: number; pos?: number };
  symbols?: string[];
  tags?: string[];
}

const EODHD_BASE = 'https://eodhd.com/api/news';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_LIMIT = 50;

@Injectable()
export class EodhdNewsService {
  private readonly logger = new Logger(EodhdNewsService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('EODHD_NEWS_PERSIST_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) this.logger.log('[eodhd-news] persist ENABLED');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Hash stable pour dedupe : titre normalisé + date jour. */
  static computeExternalId(date: string, title: string): string {
    const day = date.slice(0, 10);
    const normalizedTitle = title.trim().toLowerCase().slice(0, 200);
    return createHash('sha256').update(`${day}|${normalizedTitle}`).digest('hex').slice(0, 24);
  }

  /** Convertit un article EODHD brut → row à persister. */
  static toRow(ticker: string, raw: EodhdNewsRaw): PersistedNewsArticle | null {
    if (!raw.date || !raw.title) return null;
    const s = raw.sentiment ?? {};
    return {
      ticker,
      external_id: this.computeExternalId(raw.date, raw.title),
      published_at: new Date(raw.date).toISOString(),
      title: raw.title.slice(0, 500),
      content: raw.content ? raw.content.slice(0, 5000) : null,
      source_url: raw.link ?? null,
      sentiment_polarity: typeof s.polarity === 'number' ? s.polarity : null,
      sentiment_neg: typeof s.neg === 'number' ? s.neg : null,
      sentiment_neu: typeof s.neu === 'number' ? s.neu : null,
      sentiment_pos: typeof s.pos === 'number' ? s.pos : null,
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 20) : [],
      related_symbols: Array.isArray(raw.symbols) ? raw.symbols.slice(0, 20) : [],
    };
  }

  /**
   * Pull EODHD news pour un ticker sur une fenêtre [fromDate, toDate] (YYYY-MM-DD).
   * Persiste avec UPSERT (idempotent via UNIQUE (ticker, external_id)).
   * Renvoie le nombre de rows insérées/uptodate.
   */
  async fetchAndPersistOne(ticker: string, fromDate: string, toDate: string): Promise<number> {
    if (!this.enabled) return 0;
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return 0;

    const url =
      `${EODHD_BASE}?s=${encodeURIComponent(ticker)}` +
      `&from=${fromDate}&to=${toDate}&limit=${MAX_LIMIT}` +
      `&api_token=${encodeURIComponent(apiKey)}&fmt=json`;

    let articles: EodhdNewsRaw[];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        this.logger.debug(`[eodhd-news] ${ticker} HTTP ${res.status}`);
        return 0;
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return 0;
      articles = body as EodhdNewsRaw[];
    } catch (e) {
      this.logger.debug(`[eodhd-news] ${ticker} fetch err: ${String(e).slice(0, 80)}`);
      return 0;
    }

    if (articles.length === 0) return 0;
    const rows = articles
      .map((a) => EodhdNewsService.toRow(ticker, a))
      .filter((r): r is PersistedNewsArticle => r !== null);
    if (rows.length === 0) return 0;
    if (!this.supabase.isReady()) return 0;

    const { error } = await this.supabase
      .getClient()
      .from('eodhd_news_articles')
      .upsert(rows, { onConflict: 'ticker,external_id', ignoreDuplicates: true });
    if (error) {
      this.logger.warn(`[eodhd-news] ${ticker} upsert failed: ${error.message}`);
      return 0;
    }
    return rows.length;
  }

  /**
   * Lit la DB pour récupérer les news d'un ticker dans la fenêtre [now - hoursBack, now].
   * Strict DB-read, jamais d'appel API live (pour ne pas exploser le budget côté
   * scanner candidate loop où ça pourrait être hit fréquemment).
   */
  async getRecentNewsForTicker(ticker: string, hoursBack: number): Promise<PersistedNewsArticle[]> {
    if (!this.supabase.isReady()) return [];
    const cutoff = new Date(Date.now() - hoursBack * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('eodhd_news_articles')
      .select('ticker, external_id, published_at, title, content, source_url, sentiment_polarity, sentiment_neg, sentiment_neu, sentiment_pos, tags, related_symbols')
      .eq('ticker', ticker)
      .gte('published_at', cutoff)
      .order('published_at', { ascending: false });
    if (error || !data) return [];
    return data as PersistedNewsArticle[];
  }
}
