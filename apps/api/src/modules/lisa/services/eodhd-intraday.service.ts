import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * EodhdIntradayService — récupère les bougies intraday OHLCV depuis EODHD
 * pour donner à Lisa et à l'agent mécanique une vue réelle du price action
 * (et pas juste un snapshot instantané).
 *
 * Endpoint : GET /api/intraday/{ticker}?interval=5m&from={unix}&to={unix}
 * Intervals supportés : 1m, 5m, 1h
 *
 * Cache par (ticker, interval), TTL aligné sur l'interval (on refresh
 * quand une nouvelle bougie est probable d'exister).
 */

export interface Candle {
  timestamp: number;     // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  ticker: string;
  interval: '1m' | '5m' | '1h';
  candles: Candle[];
  asOf: number;
}

@Injectable()
export class EodhdIntradayService {
  private readonly logger = new Logger(EodhdIntradayService.name);
  private cache = new Map<string, CandleSeries>();

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    // P19j — Boot log to confirm key configuration in prod (essential debug
    // signal when fallback chain doesn't seem to fire). Mask all but last 4
    // chars to avoid leaking secrets in logs.
    const k = this.config.get<string>('EODHD_API_KEY');
    if (!k) {
      this.logger.warn('[eodhd] EODHD_API_KEY env var NOT SET — intraday fetches will silently return null');
    } else if (k === 'demo') {
      this.logger.warn('[eodhd] EODHD_API_KEY="demo" detected — intraday fetches treated as no-op (cf. apiKey() guard)');
    } else {
      const tail = k.length >= 4 ? k.slice(-4) : '****';
      this.logger.log(`[eodhd] provider initialized, key=***${tail} (length=${k.length})`);
    }
  }

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  private logCall(row: { ticker: string; success: boolean; statusCode?: number; latencyMs?: number; errorMessage?: string }): void {
    (async () => {
      try {
        await this.supabase.getClient().from('eodhd_request_log').insert({
          ticker: row.ticker,
          eodhd_ticker: row.ticker,
          source: 'eodhd',
          success: row.success,
          status_code: row.statusCode ?? null,
          latency_ms: row.latencyMs ?? null,
          called_by: 'intraday',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  private cacheTtlMs(interval: '1m' | '5m' | '1h'): number {
    // Refresh à mi-interval : on peut servir la même série tant que la
    // bougie courante n'est pas clôturée.
    if (interval === '1m') return 30_000;
    if (interval === '5m') return 2 * 60_000;
    return 20 * 60_000;
  }

  /**
   * Récupère les N dernières bougies pour un ticker et un interval.
   * defaultCount = 20 → couvre 1h40 en 5m, suffisant pour détecter
   * momentum, breakout, range.
   */
  /**
   * P19k.1 (29/04/2026 16:15 — emergency revert) — Le mapping `.KO → .KOSE`
   * de P19k était INCORRECT. La doc officielle EODHD (eodhd-claude-skills
   * repo, references/general/symbol-format.md) confirme :
   *
   *   | KO  | Korea Stock Exchange | 005930.KO (Samsung)  |
   *   | SHG | Shanghai             | 600519.SHG (Moutai)  |
   *   | SHE | Shenzhen             | 000001.SHE           |
   *
   * Donc `.KO` est BIEN le suffix EODHD pour Korea — pas besoin de
   * remapper. Seul Shanghai/Shenzhen nécessitent le mapping (scanner code
   * `.SS`/`.SZ` ≠ EODHD code `.SHG`/`.SHE`).
   *
   * Source initiale (comet diagnostic) erronée. P19k.1 corrige.
   */
  private normalizeForEodhdIntraday(eodhdTicker: string): string {
    if (!eodhdTicker.includes('.')) return eodhdTicker;
    const lastDot = eodhdTicker.lastIndexOf('.');
    const base = eodhdTicker.slice(0, lastDot);
    const suffix = eodhdTicker.slice(lastDot + 1).toUpperCase();
    switch (suffix) {
      case 'SS':   return `${base}.SHG`;    // Shanghai Stock Exchange (scanner→EODHD)
      case 'SZ':   return `${base}.SHE`;    // Shenzhen Stock Exchange (scanner→EODHD)
      default:     return eodhdTicker;       // .US, .LSE, .XETRA, .PA, .HK, .TO, .NSE, .BSE, .KO (Korea), .KQ (KOSDAQ), .AU
    }
  }

  async getCandles(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '5m',
    count = 20,
  ): Promise<CandleSeries | null> {
    // P19k — Normaliser le suffix avant cache key + URL pour cohérence.
    const normalized = this.normalizeForEodhdIntraday(eodhdTicker);
    const cacheKey = `${normalized}::${interval}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.cacheTtlMs(interval)) {
      return cached;
    }

    const key = this.apiKey();
    if (!key) {
      // P19j — Promote silent skip to warn (rate-limited 1×/cycle would be
      // ideal but ce service est appelé per-ticker, on accepte le verbatim
      // pour le debug — peut être promu cycle-aggregated dans une PR follow-up).
      this.logger.debug(`[eodhd] skipping fetch for ${eodhdTicker} — no API key (EODHD_API_KEY missing or 'demo')`);
      return null;
    }

    const intervalSeconds = interval === '1m' ? 60 : interval === '5m' ? 300 : 3600;
    const toUnix = Math.floor(Date.now() / 1000);
    const fromUnix = toUnix - count * intervalSeconds * 2; // x2 marge pour weekends/holidays

    const tStart = Date.now();
    try {
      const qs = new URLSearchParams({
        api_token: key,
        fmt: 'json',
        interval,
        from: String(fromUnix),
        to: String(toUnix),
      }).toString();
      const url = `https://eodhd.com/api/intraday/${encodeURIComponent(eodhdTicker)}?${qs}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;

      if (!res.ok) {
        // P19j — Promote silent failure to warn for visibility in Fly logs.
        // 401 = bad key, 402 = quota, 404 = ticker not found, 429 = rate-limit
        const body = await res.text().catch(() => '');
        this.logger.warn(`[eodhd] ${eodhdTicker} HTTP ${res.status} (${latencyMs}ms) body=${body.slice(0, 100)}`);
        this.logCall({ ticker: eodhdTicker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}` });
        return null;
      }

      const data = await res.json() as Array<Record<string, unknown>>;
      this.logCall({ ticker: eodhdTicker, success: true, statusCode: res.status, latencyMs });

      if (!Array.isArray(data) || data.length === 0) {
        this.logger.debug(`[eodhd] ${eodhdTicker} empty response (${latencyMs}ms)`);
        return null;
      }

      const candles: Candle[] = data
        .map((d) => ({
          timestamp: typeof d.timestamp === 'number' ? d.timestamp : Number(d.timestamp ?? 0),
          open: Number(d.open ?? 0),
          high: Number(d.high ?? 0),
          low: Number(d.low ?? 0),
          close: Number(d.close ?? 0),
          volume: Number(d.volume ?? 0),
        }))
        .filter((c) => c.timestamp > 0 && c.close > 0)
        .slice(-count);

      const series: CandleSeries = { ticker: eodhdTicker, interval, candles, asOf: Date.now() };
      this.cache.set(cacheKey, series);
      return series;
    } catch (e) {
      this.logger.warn(`Intraday fetch failed for ${eodhdTicker}: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: eodhdTicker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /**
   * Résumé compact des bougies récentes pour injection dans les prompts Lisa.
   * Format : "Intraday 5m (N): close trajectory → momentum read"
   */
  summarize(series: CandleSeries): string {
    const c = series.candles;
    if (c.length === 0) return 'no candles available';

    const first = c[0];
    const last = c[c.length - 1];
    const changePct = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;

    // Range high/low sur la période
    const high = Math.max(...c.map((k) => k.high));
    const low = Math.min(...c.map((k) => k.low));
    const rangePct = low > 0 ? ((high - low) / low) * 100 : 0;

    // Position du close actuel dans le range (0 = bottom, 1 = top)
    const pctInRange = high > low ? (last.close - low) / (high - low) : 0.5;

    // Momentum : close > open sur les N/2 dernières bougies ?
    const recentHalf = c.slice(-Math.max(5, Math.floor(c.length / 2)));
    const bullishCandles = recentHalf.filter((k) => k.close > k.open).length;
    const momentumRead = bullishCandles / recentHalf.length > 0.6
      ? 'bullish momentum'
      : bullishCandles / recentHalf.length < 0.4
        ? 'bearish momentum'
        : 'choppy / no clear trend';

    // Volume surge : la dernière bougie vs moyenne
    const avgVol = c.reduce((s, k) => s + k.volume, 0) / c.length;
    const volSurge = avgVol > 0 && last.volume > avgVol * 1.5 ? ' · VOL SURGE' : '';

    return [
      `${c.length} candles ${series.interval}`,
      `close=${last.close.toFixed(4)}`,
      `range=${low.toFixed(4)}-${high.toFixed(4)} (${rangePct.toFixed(2)}%)`,
      `pos_in_range=${pctInRange.toFixed(2)}`,
      `change=${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
      momentumRead,
    ].join(' · ') + volSurge;
  }
}
