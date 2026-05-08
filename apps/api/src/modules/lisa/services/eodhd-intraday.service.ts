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
  /**
   * PR #285 — Total candles retournées par l'API EODHD AVANT filter
   * `close > 0`. Permet diagnostic Asia/exotic : EODHD peut retourner des
   * buckets avec close=null en pré-marché, lunch break, post-close.
   * `rawCount - candles.length` = nb candles avec close invalide.
   */
  rawCount?: number;
  /**
   * PR #285 — Le ticker effectivement envoyé dans l'URL (post-normalize).
   * Permet de détecter un éventuel mismatch entre input scanner et requête
   * EODHD (ex: legacy `.SZ` mappé vers `.SHE`).
   */
  requestedSymbol?: string;
}

/**
 * P19o.3 (29/04/2026) — Tick data row depuis `/api/ticks/{SYMBOL}`.
 * Schema officiel : `vendor/eodhd-claude-skills/skills/eodhd-api/references/endpoints/us-tick-data.md`.
 */
export interface RawTick {
  /** Timestamp en MILLISECONDES (cf. EODHD doc — différent de from/to en secondes) */
  timestamp: number;
  datetime?: string;
  price: number;
  volume: number;
  /** Market center code : NASDAQ=X/T/B/Q/R, NYSE=N/C/P/A, CBOE=K/Y/J/W/Z, IEX=V, OTC=S/u/U, **D=dark pool** */
  mkt?: string;
  /** Sale condition code (exchange-specific trade condition flags) */
  sl?: string;
  /** Sequence number pour ordering ticks intra-timestamp */
  seq?: number;
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
      // P20a backward-compat: scanner now uses SHG/SHE but legacy log entries may still carry SS/SZ.
      case 'SS':   return `${base}.SHG`;    // Shanghai (Yahoo Finance legacy → EODHD)
      case 'SZ':   return `${base}.SHE`;    // Shenzhen (Yahoo Finance legacy → EODHD)
      // P20a: TSE was wrong scanner code for Tokyo; correct suffix is .T. Kept for legacy entries.
      case 'TSE':  return `${base}.T`;      // Tokyo Stock Exchange (MIC alias → EODHD)
      default:     return eodhdTicker;       // .US .LSE .XETRA .PA .HK .T .TO .NSE .BSE .KO .KQ .SHG .SHE .AU
    }
  }

  /**
   * P19o (29/04/2026) — Fenêtre from/to par interval.
   *
   * L'ancienne formule `count * interval * 2` donnait ~2.16h pour 5m × 13
   * candles : trop étroit pour des micro-caps qui ne tradent pas en continu
   * (overnight, weekends, low-volume tickers) → array vide → coverage='none'
   * → UI Top 20 toutes lignes "—". Cf. issue #107.
   *
   * Ranges max EODHD intraday : 1m=120 jours, 5m=600 jours, 1h=7200 jours.
   * On reste très large par rapport au max ; le `.slice(-count)` en aval
   * garde uniquement les N candles les plus récentes côté client.
   */
  private windowForInterval(interval: '1m' | '5m' | '1h'): number {
    // P19r (29/04/2026 19:30 UTC) — 1m window bumped 24h → 48h.
    //
    // Constat prod (UI Lisa Top 20 : 1m = 1/20, KFRC US seul à avoir tf1m≠null,
    // 9/20 = Korea, 4/20 = India, 1/20 = AU) : 24h window ne couvre PAS la
    // dernière session de la majorité des marchés non-US.
    //
    // Sessions UTC :
    //   - KOSPI / KOSDAQ : 00:00–06:30 UTC Mon-Fri (Korea)
    //   - NSE India       : 03:45–10:00 UTC Mon-Fri
    //   - ASX Australia   : 23:00–05:00 UTC (overnight, prev day)
    //   - LSE / XETRA / PA : 08:00–16:30 UTC
    //   - NYSE / NASDAQ   : 14:30–21:00 UTC + after-hours 21:00–24:00
    //
    // À 19:30 UTC un mardi, 24h window remonte au lundi 19:30 UTC :
    //   - Korea Mon session 00:00–06:30 = OUTSIDE window (terminée 13h avant le
    //     début du window) → 0 candles 1m pour les KO/KQ
    //   - Korea Tue session = aujourd'hui 00:00–06:30 = inside window mais
    //     EODHD intraday peut avoir un délai T+1 sur certains plans
    //   - NSE Mon session = OUTSIDE
    //
    // 48h window capture systématiquement les 2 dernières sessions de TOUS
    // les marchés mondiaux. Coût négligeable car .slice(-count) limite la
    // payload côté client.
    if (interval === '1m') return 48 * 3600;          // 2 jours (fix asia/NSE/AU)
    if (interval === '5m') return 5 * 24 * 3600;      // 5 jours (couvre weekends)
    return 30 * 24 * 3600;                             // 30 jours pour 1h
  }

  /**
   * PR #284 — Limite de rétention EODHD intraday standard. Au-delà l'API
   * peut retourner empty silencieusement (selon plan), créant des sims
   * fantômes NO_DATA. On log explicite et on early-return null.
   *
   * Aligné avec les TTLs cache mais utilisé ici comme guard caller-side
   * pour les fetch range explicites (shadow simulator retro-sim).
   */
  static readonly RETENTION_LIMIT_SEC = 5 * 24 * 3600;  // 5 days

  async getCandles(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '5m',
    count = 20,
    options?: { fromTs?: number; toTs?: number },
  ): Promise<CandleSeries | null> {
    // Hotfix EODHD bypass — defense in depth : si un caller passe un symbol
    // sans suffix exchange (ex: legacy row "005940" au lieu de "005940.KO"),
    // logger un warn explicite plutôt que tomber en 404 silencieux. Default
    // .US comme fallback raisonnable (same comportement historique). Le caller
    // doit appliquer ensureEodhdSuffix() en amont pour les non-US.
    if (!eodhdTicker.includes('.')) {
      this.logger.warn(
        `[eodhd] ${eodhdTicker} missing exchange suffix — defaulting to .US (caller should pass full eodhdTicker, e.g. SAMSUNG.KO)`,
      );
      eodhdTicker = `${eodhdTicker}.US`;
    }
    // P19k — Normaliser le suffix avant cache key + URL pour cohérence.
    const normalized = this.normalizeForEodhdIntraday(eodhdTicker);

    // PR #284 — Mode range explicite : skip cache (range-specific), guard
    // retention 5 jours, désactive le slice(-count) (on prend tout le range).
    const useRange = options?.fromTs != null || options?.toTs != null;
    if (useRange && options?.fromTs != null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ageDays = (nowSec - options.fromTs) / 86400;
      if (ageDays > 5) {
        this.logger.warn(
          `[eodhd] ${eodhdTicker} EODHD_RETENTION_EXCEEDED : fromTs=${options.fromTs} (${ageDays.toFixed(1)}d ago) > 5d retention. Skipping fetch.`,
        );
        return null;
      }
    }

    const cacheKey = useRange
      ? `${normalized}::${interval}::${options?.fromTs ?? '_'}::${options?.toTs ?? '_'}`
      : `${normalized}::${interval}`;
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

    // PR #284 — Range explicite via options.fromTs/toTs override le default
    // (latest window). Permet retro-sim shadow signals avec window précise.
    const toUnix = options?.toTs ?? Math.floor(Date.now() / 1000);
    const fromUnix = options?.fromTs ?? (toUnix - this.windowForInterval(interval));

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

      const allCandles: Candle[] = data
        .map((d) => ({
          timestamp: typeof d.timestamp === 'number' ? d.timestamp : Number(d.timestamp ?? 0),
          open: Number(d.open ?? 0),
          high: Number(d.high ?? 0),
          low: Number(d.low ?? 0),
          close: Number(d.close ?? 0),
          volume: Number(d.volume ?? 0),
        }))
        .filter((c) => c.timestamp > 0 && c.close > 0);

      // PR #284 — En mode range, on prend toutes les candles dans la fenêtre
      // (pas de slice(-count) qui prendrait juste les dernières et perdrait
      // les candles utiles au caller). Le serveur EODHD a déjà restreint via
      // les query params from/to.
      const candles = useRange ? allCandles : allCandles.slice(-count);

      // PR #285 — rawCount = nb candles AVANT filter close>0 ; requestedSymbol
      // = ticker effectivement envoyé dans l'URL EODHD (peut différer de
      // l'input scanner après injection `.US` ou si normalize divergeait).
      // Permet diagnostic mismatch suffix.
      const series: CandleSeries = {
        ticker: eodhdTicker,
        interval,
        candles,
        asOf: Date.now(),
        rawCount: data.length,
        requestedSymbol: eodhdTicker,
      };
      this.cache.set(cacheKey, series);
      return series;
    } catch (e) {
      this.logger.warn(`Intraday fetch failed for ${eodhdTicker}: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: eodhdTicker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /**
   * P19o (29/04/2026) — Quote ponctuel via `/api/real-time/{SYMBOL}`.
   *
   * Use case : quand `getCandles()` retourne une série vide (ticker à trades
   * sparses), le scanner peut au moins peupler la colonne UI %change avec
   * un quote unique. La persistance multi-TF reste impossible avec un seul
   * point — pour ça il faut élargir la fenêtre intraday (cf. P19o ci-dessus).
   *
   * Endpoint : `GET /api/real-time/{SYMBOL}?api_token=&fmt=json`. Retourne
   * `{ code, timestamp, open, high, low, close, volume, change, change_p }`.
   * Ref : `vendor/eodhd-claude-skills/skills/eodhd-api/references/endpoints/live-price-data.md`
   */
  async getQuote(
    eodhdTicker: string,
  ): Promise<{ price: number; changePct: number; timestamp: number } | null> {
    const key = this.apiKey();
    if (!key) return null;
    const normalized = this.normalizeForEodhdIntraday(eodhdTicker);
    const tStart = Date.now();
    try {
      const url =
        `https://eodhd.com/api/real-time/${encodeURIComponent(normalized)}` +
        `?api_token=${encodeURIComponent(key)}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logger.debug(`[eodhd:real-time] ${normalized} HTTP ${res.status} (${latencyMs}ms)`);
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const price = Number(data?.close ?? 0);
      const changePct = Number(data?.change_p ?? 0);
      const timestamp =
        typeof data?.timestamp === 'number'
          ? data.timestamp
          : Math.floor(Date.now() / 1000);
      if (!Number.isFinite(price) || price <= 0) return null;
      return { price, changePct, timestamp };
    } catch {
      return null;
    }
  }

  /**
   * P19o.3 (29/04/2026) — Tick-by-tick fallback via `/api/ticks/{SYMBOL}`.
   *
   * Use case : quand `getCandles()` retourne une série vide même après
   * widening de la fenêtre (P19o), pour des tickers à trades sparses sans
   * intraday OHLCV pré-aggregé. Tick data couvre principalement les actions
   * US (NYSE/NASDAQ/CBOE/IEX/dark pools) et permet de reconstruire des
   * bars OHLCV par aggrégation.
   *
   * ⚠️ EODHD doc :
   *   - timestamps `from`/`to` en SECONDES (Unix)
   *   - timestamps RETOUR en MILLISECONDES (à convertir avant aggregate)
   *   - limit max 10000, default 100
   *   - field `mkt='D'` = dark pool trade (à inclure ou pas selon use case)
   *
   * Ref : `vendor/eodhd-claude-skills/skills/eodhd-api/references/endpoints/us-tick-data.md`
   */
  async getTickData(
    eodhdTicker: string,
    fromUnix: number,
    toUnix: number,
    limit = 100,
  ): Promise<RawTick[] | null> {
    const key = this.apiKey();
    if (!key) return null;
    const normalized = this.normalizeForEodhdIntraday(eodhdTicker);
    const tStart = Date.now();
    try {
      const qs = new URLSearchParams({
        api_token: key,
        fmt: 'json',
        from: String(Math.floor(fromUnix)),
        to: String(Math.floor(toUnix)),
        limit: String(Math.min(Math.max(1, limit), 10_000)),
      }).toString();
      const url = `https://eodhd.com/api/ticks/${encodeURIComponent(normalized)}?${qs}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.debug(
          `[eodhd:ticks] ${normalized} HTTP ${res.status} (${latencyMs}ms) body=${body.slice(0, 100)}`,
        );
        this.logCall({
          ticker: normalized,
          success: false,
          statusCode: res.status,
          latencyMs,
          errorMessage: `TICKS_HTTP_${res.status}`,
        });
        return null;
      }
      const data = (await res.json()) as Array<Record<string, unknown>>;
      this.logCall({ ticker: normalized, success: true, statusCode: res.status, latencyMs });
      if (!Array.isArray(data) || data.length === 0) return null;
      return data
        .map<RawTick>((d) => {
          const tick: RawTick = {
            timestamp: typeof d.timestamp === 'number' ? d.timestamp : Number(d.timestamp ?? 0),
            price: Number(d.price ?? 0),
            volume: Number(d.volume ?? 0),
            seq: typeof d.seq === 'number' ? d.seq : 0,
          };
          if (typeof d.datetime === 'string') tick.datetime = d.datetime;
          if (typeof d.mkt === 'string') tick.mkt = d.mkt;
          if (typeof d.sl === 'string') tick.sl = d.sl;
          return tick;
        })
        .filter((t) => t.price > 0 && t.timestamp > 0);
    } catch (e) {
      this.logger.debug(`[eodhd:ticks] ${normalized} fetch error: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * P19o.3 (29/04/2026) — Construit une CandleSeries OHLCV en aggrégant les
   * ticks par bucket d'interval (5m / 1m / 1h).
   *
   * Algorithme bucket : `bucketKey = floor(tickTimestampMs / intervalMs)`
   *   - open  = price du 1er tick du bucket
   *   - high  = max price
   *   - low   = min price
   *   - close = price du dernier tick (latest seq)
   *   - volume = somme volumes
   *
   * Note : on ne filtre pas les dark-pool ticks (`mkt='D'`) — ils représentent
   * de vrais volumes et l'aggrégation OHLCV doit les compter pour refléter
   * fidèlement le price action. Ré-évaluer si on observe des bars aberrants.
   */
  async getCandlesViaTicks(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '5m',
    count = 20,
    options?: { fromTs?: number; toTs?: number },
  ): Promise<CandleSeries | null> {
    // PR #284 — Range explicite override (cf. getCandles). Retention guard
    // identique : >5j → log warn + return null.
    const useRange = options?.fromTs != null || options?.toTs != null;
    if (useRange && options?.fromTs != null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ageDays = (nowSec - options.fromTs) / 86400;
      if (ageDays > 5) {
        this.logger.warn(
          `[eodhd:ticks] ${eodhdTicker} EODHD_RETENTION_EXCEEDED : fromTs=${options.fromTs} (${ageDays.toFixed(1)}d ago) > 5d. Skipping fetch.`,
        );
        return null;
      }
    }
    const toUnix = options?.toTs ?? Math.floor(Date.now() / 1000);
    const fromUnix = options?.fromTs ?? (toUnix - this.windowForInterval(interval));
    // Limit 5000 = compromis : sur ticker liquide ~100-500 ticks/5m → 5000 ticks
    // couvre 50-250 minutes ; sur micro-cap sparse ~5-20 ticks/5m → couvre 1-2j.
    const ticks = await this.getTickData(eodhdTicker, fromUnix, toUnix, 5000);
    if (!ticks || ticks.length === 0) return null;

    const intervalMs = (interval === '1m' ? 60 : interval === '5m' ? 300 : 3600) * 1000;
    const buckets = new Map<number, Candle>();
    for (const t of ticks) {
      // EODHD retourne timestamp en ms (cf. doc us-tick-data.md). Heuristique
      // défensive : si la valeur ressemble à des secondes (< 1e11), convertir.
      const tsMs = t.timestamp > 1e11 ? t.timestamp : t.timestamp * 1000;
      const bucketKey = Math.floor(tsMs / intervalMs);
      const bucketStartSec = Math.floor((bucketKey * intervalMs) / 1000);
      const existing = buckets.get(bucketKey);
      if (!existing) {
        buckets.set(bucketKey, {
          timestamp: bucketStartSec,
          open: t.price,
          high: t.price,
          low: t.price,
          close: t.price,
          volume: t.volume,
        });
      } else {
        existing.high = Math.max(existing.high, t.price);
        existing.low = Math.min(existing.low, t.price);
        // Ticks arrivent triés par seq, donc le dernier rencontré pour ce
        // bucket est le close.
        existing.close = t.price;
        existing.volume += t.volume;
      }
    }
    const sorted = [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
    // PR #284 — En mode range, on prend tout (pas de slice(-count)).
    const candles = useRange ? sorted : sorted.slice(-count);
    if (candles.length === 0) return null;
    const series: CandleSeries = {
      ticker: eodhdTicker,
      interval,
      candles,
      asOf: Date.now(),
      rawCount: ticks.length,        // PR #285 — diagnostic
      requestedSymbol: eodhdTicker,  // PR #285 — ce qui a été envoyé en URL
    };
    this.logger.log(
      `[eodhd:ticks] ${eodhdTicker} reconstructed ${candles.length} ${interval} bars from ${ticks.length} ticks`,
    );
    return series;
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
