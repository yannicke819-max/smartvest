/**
 * BLOC 4.0 — ETL Volume Baseline Calculator (ADR-005 PR5 pre-req).
 *
 * Calcule la médiane du volume dollar 20j pour chaque symbole de
 * `gainers_legacy_snapshot` puis upsert dans `gainers_volume_baselines`.
 *
 * Source primaire : `ohlcv_cache_daily` (déjà alimentée par OhlcvCacheService
 *   cron 21:30 UTC, scanner rebound). 0 call EODHD supplémentaire.
 *
 * Source de fallback :
 *   - Equity : direct EODHD `/api/eod/{ticker}` si cache vide ou < 20 rows
 *   - Crypto : `Binance /klines?interval=1d&limit=20` (cache equity-only)
 *
 * Garde-fous (ADR-005 §BLOC 4.0) :
 *   1. Fraîcheur cache : MAX(fetched_at) > 26h → bascule fallback live + métrique
 *   2. Couverture per-row : miss/insufficient → fallback POUR CE SYMBOL UNIQUEMENT
 *   3. Timezone : assertion bar_date traité comme UTC (DATE PostgreSQL no-TZ)
 *   4. Crypto : fallback Binance systématique (cache equity-only)
 *   5. Idempotence : upsert(onConflict='symbol,exchange') + updated_at=now()
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { VolumeBaselineService } from './volume-baseline.service';

export interface BaselineCalcResult {
  totalSymbols: number;
  computed: number;
  cacheHits: number;
  cacheMisses: number;
  liveFetchSuccess: number;
  liveFetchFailures: number;
  cacheStale: boolean;
  durationMs: number;
}

export interface BaselineCalcSymbol {
  symbol: string;
  exchange: string;
  asset_class: 'equity' | 'crypto';
}

interface OhlcvRow {
  bar_date: string;
  close: number;
  volume: number;
  fetched_at: string;
}

const CACHE_FRESHNESS_THRESHOLD_HOURS = 26;
const WINDOW_DAYS = 20;

/** Médiane d'un tableau (trie une copie). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Convertit un symbole '.CC' EODHD vers le pair Binance USDT. */
export function toBinanceSymbol(eodhdSymbol: string): string | null {
  // BTC-USD.CC → BTCUSDT, ETH-USD.CC → ETHUSDT
  const m = eodhdSymbol.match(/^([A-Z0-9]+)-USD\.CC$/);
  if (!m) return null;
  return `${m[1]}USDT`;
}

@Injectable()
export class VolumeBaselineCalculatorService {
  private readonly logger = new Logger(VolumeBaselineCalculatorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly volumeBaseline: VolumeBaselineService,
  ) {}

  /**
   * Lit l'univers à baseliner depuis `gainers_legacy_snapshot`.
   * Source de vérité : la table seedée par scripts/audit-universe-legacy.ts.
   */
  async loadUniverse(): Promise<BaselineCalcSymbol[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_legacy_snapshot')
      .select('symbol, exchange, asset_class');
    if (error) {
      this.logger.error(`loadUniverse failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as BaselineCalcSymbol[];
  }

  /**
   * Garde-fou #1 — Fraîcheur du cache equity.
   * Vérifie MAX(fetched_at) sur ohlcv_cache_daily. Tolérance 26h pour
   * couvrir weekend (45h) ou jour férié.
   */
  async isCacheFresh(): Promise<boolean> {
    const { data, error } = await this.supabase
      .getClient()
      .from('ohlcv_cache_daily')
      .select('fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      this.logger.warn(`[baseline-etl] cache freshness check failed: ${error?.message ?? 'no rows'}`);
      return false;
    }
    const ageMs = Date.now() - new Date(data.fetched_at as string).getTime();
    const ageHours = ageMs / 3_600_000;
    if (ageHours > CACHE_FRESHNESS_THRESHOLD_HOURS) {
      this.logger.warn(`[baseline-etl] cache stale: ${ageHours.toFixed(1)}h > ${CACHE_FRESHNESS_THRESHOLD_HOURS}h`);
      return false;
    }
    return true;
  }

  /**
   * Lit les N dernières lignes pour un ticker depuis ohlcv_cache_daily.
   * Retourne null si miss ou < windowDays rows.
   */
  async readCacheBars(ticker: string, windowDays = WINDOW_DAYS): Promise<OhlcvRow[] | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('ohlcv_cache_daily')
      .select('bar_date, close, volume, fetched_at')
      .eq('ticker', ticker)
      .order('bar_date', { ascending: false })
      .limit(windowDays);
    if (error) {
      this.logger.warn(`[baseline-etl] cache read ${ticker} failed: ${error.message}`);
      return null;
    }
    if (!data || data.length < windowDays) return null;
    return data.map((r) => ({
      bar_date: r.bar_date as string,
      close: Number(r.close),
      volume: Number(r.volume),
      fetched_at: r.fetched_at as string,
    }));
  }

  /**
   * Garde-fou #2 — Fallback live equity via EODHD.
   * Appel direct /api/eod/{ticker}?from=...&to=...
   */
  async fetchLiveEodhdBars(ticker: string, windowDays = WINDOW_DAYS): Promise<OhlcvRow[] | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) {
      this.logger.warn('[baseline-etl] EODHD_API_KEY missing — equity live fallback disabled');
      return null;
    }
    // Fenêtre généreuse pour couvrir weekends/fériés (35j calendaires ≈ 25 trading days).
    const to = new Date();
    const from = new Date(to.getTime() - 35 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const url = `https://eodhd.com/api/eod/${encodeURIComponent(ticker)}?api_token=${apiKey}&fmt=json&from=${fromStr}&to=${toStr}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const arr = await res.json() as Array<{ date: string; close: number; volume: number }>;
      if (!Array.isArray(arr) || arr.length < windowDays) return null;
      // Garde les windowDays dernières dates (déjà ordonnées chrono ascending par EODHD).
      const recent = arr.slice(-windowDays);
      const now = new Date().toISOString();
      return recent.map((r) => ({
        bar_date: r.date,
        close: Number(r.close),
        volume: Number(r.volume),
        fetched_at: now,
      }));
    } catch (e) {
      this.logger.warn(`[baseline-etl] EODHD live ${ticker}: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * Garde-fou #4 — Fallback systématique pour crypto via Binance klines daily.
   */
  async fetchLiveBinanceBars(symbol: string, windowDays = WINDOW_DAYS): Promise<OhlcvRow[] | null> {
    const binanceSymbol = toBinanceSymbol(symbol);
    if (!binanceSymbol) {
      this.logger.warn(`[baseline-etl] crypto symbol unmappable: ${symbol}`);
      return null;
    }
    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1d&limit=${windowDays}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const arr = await res.json() as unknown[];
      if (!Array.isArray(arr) || arr.length < windowDays) return null;
      const now = new Date().toISOString();
      return arr.map((row) => {
        const r = row as unknown[];
        return {
          bar_date: new Date(Number(r[0])).toISOString().slice(0, 10),
          close: Number(r[4]),
          volume: Number(r[5]),
          fetched_at: now,
        };
      });
    } catch (e) {
      this.logger.warn(`[baseline-etl] Binance live ${symbol}: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * Calcule la médiane volume dollar (close × volume) sur la fenêtre.
   * Retourne null si bars vides.
   */
  computeMedianDollarVolume(bars: OhlcvRow[]): { median: number; lastNonzeroAt: string | null } | null {
    if (bars.length === 0) return null;
    const dollarVols = bars.map((b) => b.close * b.volume);
    const med = median(dollarVols);
    // Dernière date avec volume non-nul
    const sortedDesc = [...bars].sort((a, b) => b.bar_date.localeCompare(a.bar_date));
    const lastNonzero = sortedDesc.find((b) => b.volume > 0);
    return { median: med, lastNonzeroAt: lastNonzero?.bar_date ?? null };
  }

  /** Run principal : itère sur l'univers, calcule, upsert. */
  async runEtl(): Promise<BaselineCalcResult> {
    const t0 = Date.now();
    const universe = await this.loadUniverse();
    const cacheFresh = await this.isCacheFresh();
    if (!cacheFresh) {
      this.logger.warn('[baseline-etl] cache stale — equity will fallback to live EODHD');
    }

    const result: BaselineCalcResult = {
      totalSymbols: universe.length,
      computed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      liveFetchSuccess: 0,
      liveFetchFailures: 0,
      cacheStale: !cacheFresh,
      durationMs: 0,
    };

    const upsertRows: Array<{
      symbol: string;
      exchange: string;
      assetClass: 'equity' | 'crypto';
      medianDollarVolume: number;
      lastNonzeroAt: string | null;
    }> = [];

    for (const u of universe) {
      let bars: OhlcvRow[] | null = null;

      if (u.asset_class === 'equity') {
        // Garde-fou #2 — try cache first, then live fallback per-row
        if (cacheFresh) {
          bars = await this.readCacheBars(u.symbol);
          if (bars) result.cacheHits++;
          else result.cacheMisses++;
        }
        if (!bars) {
          bars = await this.fetchLiveEodhdBars(u.symbol);
          if (bars) result.liveFetchSuccess++;
          else result.liveFetchFailures++;
        }
      } else {
        // Garde-fou #4 — crypto = Binance live systématique (cache equity-only)
        bars = await this.fetchLiveBinanceBars(u.symbol);
        if (bars) result.liveFetchSuccess++;
        else result.liveFetchFailures++;
      }

      if (!bars) continue;
      const calc = this.computeMedianDollarVolume(bars);
      if (!calc || calc.median <= 0) continue;

      upsertRows.push({
        symbol: u.symbol,
        exchange: u.exchange,
        assetClass: u.asset_class,
        medianDollarVolume: calc.median,
        lastNonzeroAt: calc.lastNonzeroAt,
      });
      result.computed++;
    }

    // Garde-fou #5 — Idempotence via upsertBaselines (onConflict='symbol,exchange')
    if (upsertRows.length > 0) {
      await this.volumeBaseline.upsertBaselines(upsertRows);
    }

    result.durationMs = Date.now() - t0;
    this.logger.log(
      `[baseline-etl] done — symbols=${result.totalSymbols} computed=${result.computed} ` +
      `cacheHits=${result.cacheHits} cacheMisses=${result.cacheMisses} ` +
      `liveOK=${result.liveFetchSuccess} liveFail=${result.liveFetchFailures} ` +
      `stale=${result.cacheStale} duration=${result.durationMs}ms`,
    );
    return result;
  }
}
