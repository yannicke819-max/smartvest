/**
 * Phase C — Cache ATR par symbole (volatilité native).
 *
 * Objectif : skip dans le scanner les tickers dont l'ATR(14)/close > X%
 * (default 2.5%). Aligné avec la "Stratégie 2 Regime Detection" du brief
 * externe. Constat data 15j : 86% des stops EU/Asia small-cap proviennent
 * de tickers structurellement volatils dont le SL -1.5% est cassé par le
 * bruit normal.
 *
 * Architecture :
 *   - Cron daily 21:30 UTC : pull EODHD EOD (jour J-14 → J) pour l'univers
 *     actif (~200 tickers). Crypto via Binance klines daily.
 *   - Compute ATR(14) via True Range moyen mobile.
 *   - UPSERT dans symbol_atr_cache.
 *   - Lecture côté scanner : 1 query indexed (PK) par candidat — O(1).
 *
 * Gating : SYMBOL_ATR_CACHE_REFRESH_ENABLED (default false). Sans flag,
 * pas d'écriture. Lecture (getAtrRatio) renvoie null si table vide → gate
 * scanner fail-open (conservateur, ne bloque rien tant qu'on n'a pas data).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

const ATR_PERIOD = 14;
const FETCH_TIMEOUT_MS = 12_000;
const REFRESH_MAX_CONCURRENT = 5;

interface DailyCandle {
  date: string;
  high: number;
  low: number;
  close: number;
  previousClose?: number;
}

@Injectable()
export class SymbolAtrCacheService {
  private readonly logger = new Logger(SymbolAtrCacheService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('SYMBOL_ATR_CACHE_REFRESH_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) this.logger.log('[atr-cache] refresh ENABLED (cron daily 21:30 UTC)');
  }

  /**
   * True Range formula (Wilder) : max(high-low, |high-prevClose|, |low-prevClose|).
   * ATR(N) = SMA simple des True Ranges sur N périodes (variante de base).
   * Pour le 1er point sans prevClose, TR = high - low.
   */
  static computeAtr(candles: DailyCandle[], period = ATR_PERIOD): number | null {
    if (candles.length < period) return null;
    const trs: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : c.previousClose ?? null;
      if (prevClose === null) {
        trs.push(c.high - c.low);
      } else {
        trs.push(Math.max(
          c.high - c.low,
          Math.abs(c.high - prevClose),
          Math.abs(c.low - prevClose),
        ));
      }
    }
    // Prendre les N derniers TR, moyenne simple.
    const lastN = trs.slice(-period);
    if (lastN.length < period) return null;
    return lastN.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Lecture côté scanner — O(1) PK lookup. Renvoie null si pas cache → caller
   * fail-open (pas de gate appliqué).
   */
  async getAtrRatio(symbol: string): Promise<number | null> {
    if (!this.supabase.isReady()) return null;
    const { data, error } = await this.supabase
      .getClient()
      .from('symbol_atr_cache')
      .select('atr_ratio_pct, computed_at')
      .eq('symbol', symbol)
      .limit(1);
    if (error || !data || data.length === 0) return null;
    // Stale si > 48h (cron daily peut louper 1 jour sans danger)
    const ageHours = (Date.now() - new Date(data[0].computed_at).getTime()) / 3_600_000;
    if (ageHours > 48) return null;
    return Number(data[0].atr_ratio_pct);
  }

  /** 21:30 UTC daily lun-ven. */
  @Cron('30 21 * * 1-5', { timeZone: 'UTC' })
  async cronDailyRefresh(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.refreshUniverse();
    } catch (e) {
      this.logger.warn(`[atr-cache] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** Visible pour test/CLI. Pull EOD + compute + upsert pour l'univers. */
  async refreshUniverse(): Promise<{ processed: number; persisted: number; failed: number }> {
    if (!this.enabled) return { processed: 0, persisted: 0, failed: 0 };
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return { processed: 0, persisted: 0, failed: 0 };

    const universe = await this.fetchUniverseTickers();
    if (universe.length === 0) {
      this.logger.debug('[atr-cache] universe empty');
      return { processed: 0, persisted: 0, failed: 0 };
    }

    let persisted = 0;
    let failed = 0;
    // Concurrence limitée (5 in-flight max).
    for (let i = 0; i < universe.length; i += REFRESH_MAX_CONCURRENT) {
      const batch = universe.slice(i, i + REFRESH_MAX_CONCURRENT);
      const results = await Promise.allSettled(
        batch.map((s) => this.refreshOne(s, apiKey)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value === true) persisted++;
        else failed++;
      }
    }
    this.logger.log(`[atr-cache] refresh processed=${universe.length} persisted=${persisted} failed=${failed}`);
    return { processed: universe.length, persisted, failed };
  }

  /** Pull 30 jours EOD + compute ATR + upsert. Equity uniquement (crypto déférée). */
  private async refreshOne(symbol: string, apiKey: string): Promise<boolean> {
    if (symbol.endsWith('USDT')) return false; // Crypto skip pour V1
    try {
      const url =
        `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
        `?period=d&order=a&fmt=json&api_token=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return false;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return false;
      const rows = body as Array<{ date: string; high: number; low: number; close: number }>;
      const candles: DailyCandle[] = rows.slice(-30).map((r) => ({
        date: r.date, high: Number(r.high), low: Number(r.low), close: Number(r.close),
      }));
      const atr = SymbolAtrCacheService.computeAtr(candles);
      if (atr === null || atr <= 0) return false;
      const lastClose = candles[candles.length - 1].close;
      if (!Number.isFinite(lastClose) || lastClose <= 0) return false;
      const atrRatioPct = (atr / lastClose) * 100;

      if (!this.supabase.isReady()) return false;
      const { error } = await this.supabase.getClient()
        .from('symbol_atr_cache')
        .upsert({
          symbol,
          atr_14d: atr,
          close_at_compute: lastClose,
          atr_ratio_pct: atrRatioPct,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'symbol' });
      return !error;
    } catch {
      return false;
    }
  }

  /** Univers à refresh : watchlist_universe.tickers flatten + dedupe (equity only). */
  private async fetchUniverseTickers(): Promise<string[]> {
    if (!this.supabase.isReady()) return [];
    const { data, error } = await this.supabase
      .getClient()
      .from('watchlist_universe')
      .select('tickers')
      .limit(500);
    if (error || !data) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of data as Array<{ tickers?: string[] | null }>) {
      const list = Array.isArray(row.tickers) ? row.tickers : [];
      for (const t of list) {
        const sym = String(t).trim().toUpperCase();
        if (sym.length > 0 && !sym.endsWith('USDT') && !seen.has(sym)) {
          seen.add(sym); out.push(sym);
        }
      }
    }
    return out;
  }
}
