/**
 * P3-C — Cron quotidien de population du cache `ohlcv_cache_daily`.
 *
 * Tourne une fois par jour à 21:30 UTC (15-30 min post-close NYSE
 * pour laisser EODHD le temps de publier la dernière bougie). Pour
 * chaque ticker dans la watchlist active :
 *   - Détermine la dernière bar_date en cache
 *   - Si gap >= 1 jour calendaire → fetch les bougies manquantes via
 *     EODHD `/api/eod/{ticker}` sur la fenêtre [last+1, today]
 *   - UPSERT (idempotent sur la PK ticker+bar_date)
 *
 * Throttling : sémaphore 10 req/sec pour rester sous la limite EODHD.
 * Fail-fast si > 50% des fetches échouent → log error global, le cron
 * suivant retentera demain.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

interface EodhdEodBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close?: number;
  volume: number;
}

interface CacheRow {
  ticker: string;
  bar_date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

@Injectable()
export class OhlcvCacheService {
  private readonly logger = new Logger(OhlcvCacheService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Cron quotidien 21:30 UTC, lun-ven. Surchargeable via env
   * `OHLCV_CACHE_REFRESH_CRON` (cf. CLAUDE.md règle universe).
   */
  @Cron('30 21 * * 1-5', { name: 'ohlcv-cache-refresh' })
  async runRefresh(): Promise<void> {
    try {
      await this.runRefreshInner();
    } catch (e) {
      this.logger.error(`[ohlcv-cache] refresh failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runRefreshInner(): Promise<void> {
    const tickers = await this.getActiveUniverse();
    if (tickers.length === 0) {
      this.logger.warn('[ohlcv-cache] active universe empty — skip');
      return;
    }
    this.logger.log(`[ohlcv-cache] refreshing ${tickers.length} tickers`);

    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) {
      this.logger.error('[ohlcv-cache] EODHD_API_KEY missing — abort');
      return;
    }

    const rps = Number(this.config.get<string>('OHLCV_FETCH_RPS')) || 10;
    let success = 0;
    let failed = 0;
    let upserted = 0;

    for (const batch of chunks(tickers, rps)) {
      const t0 = Date.now();
      const results = await Promise.all(
        batch.map((ticker) => this.refreshTicker(ticker, apiKey).catch(() => null)),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r === null) {
          failed++;
        } else {
          success++;
          upserted += r;
        }
      }
      // Throttling : ne pas dépasser `rps` req/sec.
      const elapsed = Date.now() - t0;
      if (elapsed < 1000) {
        await sleep(1000 - elapsed);
      }
    }

    if (failed > tickers.length / 2) {
      this.logger.error(
        `[ohlcv-cache] data provider degraded: ${failed}/${tickers.length} failed`,
      );
    } else {
      this.logger.log(
        `[ohlcv-cache] done: ${success} ok, ${failed} failed, ${upserted} bars upserted`,
      );
    }
  }

  /**
   * Public — utilisé par les tests pour invoquer la logique sans
   * passer par le cron timer.
   */
  async refreshAll(): Promise<void> {
    return this.runRefreshInner();
  }

  /**
   * Fetch + UPSERT pour un ticker. Retourne le nombre de bars insérées
   * ou throw si fetch échoue.
   */
  private async refreshTicker(ticker: string, apiKey: string): Promise<number> {
    const lastDate = await this.getLastCachedDate(ticker);
    const today = new Date().toISOString().slice(0, 10);
    const fromDate =
      lastDate
        ? new Date(new Date(lastDate).getTime() + 86_400_000).toISOString().slice(0, 10)
        : new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

    if (fromDate >= today) return 0; // déjà à jour

    const url = `https://eodhd.com/api/eod/${encodeURIComponent(ticker)}?from=${fromDate}&to=${today}&api_token=${encodeURIComponent(apiKey)}&fmt=json&order=a`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const data = (await res.json()) as EodhdEodBar[];
    if (!Array.isArray(data) || data.length === 0) return 0;

    const rows: CacheRow[] = data
      .filter(
        (d) =>
          typeof d.open === 'number' &&
          typeof d.high === 'number' &&
          typeof d.low === 'number' &&
          typeof d.close === 'number' &&
          typeof d.volume === 'number' &&
          d.open > 0 &&
          d.high > 0 &&
          d.low > 0 &&
          d.close > 0 &&
          d.volume >= 0 &&
          d.high >= d.low,
      )
      .map((d) => ({
        ticker,
        bar_date: d.date,
        open: String(d.open),
        high: String(d.high),
        low: String(d.low),
        close: String(d.close),
        volume: String(d.volume),
      }));

    if (rows.length === 0) return 0;

    const { error } = await this.supabase
      .getClient()
      .from('ohlcv_cache_daily')
      .upsert(rows, { onConflict: 'ticker,bar_date' });
    if (error) throw new Error(`upsert_${error.code ?? 'fail'}: ${error.message}`);
    return rows.length;
  }

  /**
   * Public — lit les N dernières bougies en cache pour un ticker.
   * Utilisé par le scanner phase 1 (pre-filter RSI) pour éviter le
   * fetch live sur 500 tickers à chaque tick.
   */
  async getCachedBars(
    ticker: string,
    limit: number,
  ): Promise<Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('ohlcv_cache_daily')
      .select('bar_date, open, high, low, close, volume')
      .eq('ticker', ticker)
      .order('bar_date', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.warn(`getCachedBars ${ticker} failed: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) return null;
    // Inverse pour avoir l'ordre chronologique attendu par scanRebound.
    return data
      .map((r) => ({
        timestamp: r.bar_date as string,
        open: parseFloat(r.open as string),
        high: parseFloat(r.high as string),
        low: parseFloat(r.low as string),
        close: parseFloat(r.close as string),
        volume: parseInt(r.volume as string, 10),
      }))
      .reverse();
  }

  /**
   * Récupère la liste de tickers de la watchlist active.
   * Lit `watchlist_universe` table via le nom env `REBOUND_UNIVERSE`
   * (default 'sp500'). Fallback TS constants si DB inaccessible.
   */
  async getActiveUniverse(): Promise<string[]> {
    const name = this.config.get<string>('REBOUND_UNIVERSE') ?? 'sp500';
    const { data, error } = await this.supabase
      .getClient()
      .from('watchlist_universe')
      .select('tickers')
      .eq('name', name)
      .maybeSingle();
    if (error) {
      this.logger.warn(`watchlist_universe ${name} fetch failed: ${error.message}`);
    }
    const tickers = (data?.tickers as string[] | undefined) ?? null;
    if (tickers && tickers.length > 0) return tickers;
    // Fallback TS constant
    return fallbackTsUniverse(name);
  }

  private async getLastCachedDate(ticker: string): Promise<string | null> {
    const { data } = await this.supabase
      .getClient()
      .from('ohlcv_cache_daily')
      .select('bar_date')
      .eq('ticker', ticker)
      .order('bar_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.bar_date as string | undefined) ?? null;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackTsUniverse(name: string): string[] {
  // Mini-fallback : si DB inaccessible, on tombe sur mega12 (le plus
  // conservateur, évite de faire saturer EODHD).
  const MEGA12 = [
    'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
    'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
  ];
  if (name === 'sp500' || name === 'nasdaq100' || name === 'mega12') {
    return MEGA12;
  }
  return MEGA12;
}
