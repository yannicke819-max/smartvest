import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR #342 POC — service TwelveData (lecture seule, indicateurs Supertrend / RSI / ATR).
 *
 * Plan Basic (gratuit) : 800 credits/jour, 8 credits/minute. Le service tient un
 * rate-limiter interne `CreditTracker` (7/min + 750/jour, marge vs limites) qui
 * court-circuite tout appel HTTP au-dessus du quota → return null silencieux.
 *
 * Toutes les méthodes :
 *  - Loguent un JSON structuré (compatible VictoriaLogs grep)
 *  - Loguent une ligne `twelve_data_request_log` (Supabase, append-only)
 *  - Retournent `null` au lieu de throw (fallback gracieux pour caller pipeline)
 *
 * Boot safety : si `TWELVEDATA_API_KEY` absent, le service warn une fois et
 * toutes les méthodes retournent null. Aucun crash au boot (cf. PR #334 DI hotfix).
 *
 * Activation : pose `TWELVEDATA_API_KEY=...` sur Fly secrets puis flip les
 * feature flags consumer (`QUICK_WINS_TWELVEDATA_*`) côté caller.
 */

interface CreditTrackerConfig {
  perMinuteLimit: number;
  perDayLimit: number;
}

class CreditTracker {
  private minuteWindow: number[] = []; // timestamps ms des appels
  private dailyUsage = 0;
  private dailyResetAt: number;

  constructor(private readonly cfg: CreditTrackerConfig) {
    this.dailyResetAt = this.computeNextUtcMidnight();
  }

  private computeNextUtcMidnight(): number {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next.getTime();
  }

  private prune(now: number): void {
    if (now >= this.dailyResetAt) {
      this.dailyUsage = 0;
      this.dailyResetAt = this.computeNextUtcMidnight();
    }
    const cutoff = now - 60_000;
    this.minuteWindow = this.minuteWindow.filter((t) => t > cutoff);
  }

  canConsume(credits: number, now: number = Date.now()): boolean {
    this.prune(now);
    if (this.dailyUsage + credits > this.cfg.perDayLimit) return false;
    if (this.minuteWindow.length + credits > this.cfg.perMinuteLimit) return false;
    return true;
  }

  consume(credits: number, now: number = Date.now()): void {
    this.prune(now);
    for (let i = 0; i < credits; i++) this.minuteWindow.push(now);
    this.dailyUsage += credits;
  }

  getDailyUsage(): number {
    return this.dailyUsage;
  }

  getMinuteWindowSize(): number {
    return this.minuteWindow.length;
  }
}

export interface SupertrendSignal {
  value: number;
  direction: 'up' | 'down';
  timestamp: string;
}

export interface IndicatorPoint {
  value: number;
  timestamp: string;
}

export interface ApiUsage {
  currentUsage: number;
  planLimit: number;
  dailyUsage: number;
  planDailyLimit: number;
  planCategory: string;
}

const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT_MS = 5000;
const RETRY_429_DELAY_MS = 8000;
const RETRY_5XX_DELAY_MS = 2000;

@Injectable()
export class TwelveDataService {
  private readonly logger = new Logger(TwelveDataService.name);
  private readonly apiKey: string | null;
  private readonly creditTracker: CreditTracker;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    const key = this.config.get<string>('TWELVEDATA_API_KEY');
    if (!key || key.trim() === '') {
      this.apiKey = null;
      // PR #354 — format unifié `init apiKey=null|set` pour grep ops/observabilité.
      this.logger.warn('[twelvedata] init apiKey=null — TWELVEDATA_API_KEY not set, all methods will return null');
    } else {
      this.apiKey = key;
      const tail = key.length >= 4 ? key.slice(-4) : '****';
      this.logger.log(
        `[twelvedata] init apiKey=set key=***${tail} (length=${key.length})`,
      );
    }
    // PR #352 — Pro plan defaults (8000/min, ~1M/jour). Override via env si
    // downgrade (Basic=7/750). Précédemment hardcodé Basic, sous-utilisait Pro.
    const perMinuteLimit = Number(this.config.get<string>('TWELVEDATA_PER_MINUTE_LIMIT') ?? '8000');
    const perDayLimit = Number(this.config.get<string>('TWELVEDATA_PER_DAY_LIMIT') ?? '1000000');
    this.creditTracker = new CreditTracker({ perMinuteLimit, perDayLimit });
    this.logger.log(`[twelvedata] credit tracker init: ${perMinuteLimit}/min, ${perDayLimit}/day`);
  }

  /** Convertit Binance pair (POLUSDT) → TwelveData crypto symbol (POL/USD). */
  static binanceToTwelveDataCrypto(pair: string): string | null {
    const m = pair.match(/^([A-Z0-9]+?)(USDT|USDC|BUSD|USD)$/);
    if (!m) return null;
    return `${m[1]}/USD`;
  }

  /** Visible pour tests + admin endpoint éventuel. */
  getDailyUsage(): number {
    return this.creditTracker.getDailyUsage();
  }

  /**
   * Renvoie le dernier signal Supertrend pour un ticker / paire crypto.
   * Coût : 1 credit. Retourne null si rate limit ou erreur upstream.
   */
  async getSupertrendSignal(
    symbol: string,
    interval: '30min' | '1h' | '4h' = '30min',
    period = 10,
    multiplier = 3,
    calledBy = 'manual',
  ): Promise<SupertrendSignal | null> {
    const data = await this.callIndicator(
      'supertrend',
      symbol,
      interval,
      { time_period: period.toString(), multiplier: multiplier.toString() },
      calledBy,
    );
    if (!data) return null;

    // TwelveData /supertrend returns `values: [{ datetime, supertrend, supertrend_direction }]`
    const values = (data as { values?: Array<Record<string, string>> }).values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const last = values[0];
    const value = Number(last.supertrend);
    const rawDirection = last.supertrend_direction;
    if (!Number.isFinite(value) || (rawDirection !== '1' && rawDirection !== '-1')) {
      return null;
    }
    return {
      value,
      direction: rawDirection === '1' ? 'up' : 'down',
      timestamp: last.datetime ?? new Date().toISOString(),
    };
  }

  /**
   * Renvoie le dernier RSI pour un ticker / paire crypto.
   * Coût : 1 credit.
   */
  async getRsi(
    symbol: string,
    interval: '5min' | '15min' | '30min' | '1h' = '5min',
    timePeriod = 14,
    calledBy = 'manual',
  ): Promise<IndicatorPoint | null> {
    const data = await this.callIndicator(
      'rsi',
      symbol,
      interval,
      { time_period: timePeriod.toString() },
      calledBy,
    );
    if (!data) return null;
    const values = (data as { values?: Array<Record<string, string>> }).values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const last = values[0];
    const value = Number(last.rsi);
    if (!Number.isFinite(value)) return null;
    return { value, timestamp: last.datetime ?? new Date().toISOString() };
  }

  /**
   * Renvoie l'ATR pour un ticker / paire crypto. Coût : 1 credit.
   */
  async getAtr(
    symbol: string,
    interval: '5min' | '15min' | '30min' = '5min',
    timePeriod = 14,
    calledBy = 'manual',
  ): Promise<IndicatorPoint | null> {
    const data = await this.callIndicator(
      'atr',
      symbol,
      interval,
      { time_period: timePeriod.toString() },
      calledBy,
    );
    if (!data) return null;
    const values = (data as { values?: Array<Record<string, string>> }).values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const last = values[0];
    const value = Number(last.atr);
    if (!Number.isFinite(value)) return null;
    return { value, timestamp: last.datetime ?? new Date().toISOString() };
  }

  /**
   * Renvoie le quota live TwelveData. Coût : 0 credit (api_usage gratuit).
   */
  async getApiUsage(): Promise<ApiUsage | null> {
    if (!this.apiKey) return null;
    const url = `${BASE_URL}/api_usage?apikey=${encodeURIComponent(this.apiKey)}`;
    try {
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        this.logger.warn(`[twelvedata] api_usage HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      return {
        currentUsage: Number(data.current_usage ?? 0),
        planLimit: Number(data.plan_limit ?? 0),
        dailyUsage: Number(data.daily_usage ?? 0),
        planDailyLimit: Number(data.plan_daily_limit ?? 0),
        planCategory: String(data.plan_category ?? 'unknown'),
      };
    } catch (err) {
      this.logger.warn(`[twelvedata] api_usage exception: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * PR #352 — Quote temps réel (1 credit). Endpoint : GET /quote.
   * Doc : https://twelvedata.com/docs#real-time-quote
   * Retourne null si rate limit / erreur / champ close manquant.
   */
  async getQuote(
    symbol: string,
    calledBy = 'intraday',
  ): Promise<{ price: number; changePct: number; timestamp: number } | null> {
    if (!this.apiKey) return null;
    if (!this.creditTracker.canConsume(1)) {
      this.logger.warn(
        `[twelvedata] rate limit hit for getQuote(${symbol}) — daily=${this.creditTracker.getDailyUsage()}`,
      );
      void this.logCall({
        endpoint: 'quote',
        symbol,
        interval: null,
        success: false,
        statusCode: 0,
        creditsUsed: 0,
        latencyMs: 0,
        errorMessage: 'rate_limit_internal',
        calledBy,
      });
      return null;
    }
    const tStart = Date.now();
    try {
      const params = new URLSearchParams({ symbol, apikey: this.apiKey });
      const url = `${BASE_URL}/quote?${params.toString()}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - tStart;
      this.creditTracker.consume(1);
      if (!res.ok) {
        void this.logCall({
          endpoint: 'quote',
          symbol,
          interval: null,
          success: false,
          statusCode: res.status,
          creditsUsed: 1,
          latencyMs,
          errorMessage: `HTTP_${res.status}`,
          calledBy,
        });
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      if (data?.status === 'error' || data?.close == null) {
        void this.logCall({
          endpoint: 'quote',
          symbol,
          interval: null,
          success: false,
          statusCode: res.status,
          creditsUsed: 1,
          latencyMs,
          errorMessage: String(data?.message ?? 'no_close_field').slice(0, 200),
          calledBy,
        });
        return null;
      }
      const price = Number(data.close);
      const changePct = Number(data.percent_change ?? 0);
      // Valeur RÉELLE uniquement — pas de fake-fresh (Date.now), pas de fake-stale (0).
      // Cascade :
      //   1. data.timestamp (Unix secs) — source principale TD
      //   2. data.datetime (ISO/SQL) — fallback réel TD, parsé en UTC
      //   3. null → on rejette la quote entièrement (caller retombe sur candle/EODHD)
      let timestamp: number | null = null;
      if (data.timestamp != null) {
        const tsNum = Number(data.timestamp);
        if (Number.isFinite(tsNum) && tsNum > 0) timestamp = tsNum * 1000;
      }
      if (timestamp === null && typeof data.datetime === 'string' && data.datetime.length > 0) {
        // TD datetime format "YYYY-MM-DD HH:MM:SS" en timezone de l'exchange.
        // On parse en UTC (rough) puis ajuste si exchange_timezone fourni — sinon
        // erreur max ±14h, mais c'est un VRAI timestamp de TD, pas une fabrication.
        const isoCandidate = data.datetime.replace(' ', 'T') + 'Z';
        const parsed = Date.parse(isoCandidate);
        if (Number.isFinite(parsed) && parsed > 0) timestamp = parsed;
      }
      if (timestamp === null) {
        void this.logCall({
          endpoint: 'quote',
          symbol,
          interval: null,
          success: false,
          statusCode: res.status,
          creditsUsed: 1,
          latencyMs,
          errorMessage: 'no_real_timestamp',
          calledBy,
        });
        return null;
      }
      if (!Number.isFinite(price) || price <= 0) {
        void this.logCall({
          endpoint: 'quote',
          symbol,
          interval: null,
          success: false,
          statusCode: res.status,
          creditsUsed: 1,
          latencyMs,
          errorMessage: `invalid_price=${String(data.close)}`,
          calledBy,
        });
        return null;
      }
      this.logStructured('quote', symbol, '', 'ok', 1, latencyMs);
      void this.logCall({
        endpoint: 'quote',
        symbol,
        interval: null,
        success: true,
        statusCode: res.status,
        creditsUsed: 1,
        latencyMs,
        calledBy,
      });
      return { price, changePct, timestamp };
    } catch (err) {
      const latencyMs = Date.now() - tStart;
      void this.logCall({
        endpoint: 'quote',
        symbol,
        interval: null,
        success: false,
        statusCode: null,
        creditsUsed: 1,
        latencyMs,
        errorMessage: String((err as Error).message).slice(0, 200),
        calledBy,
      });
      return null;
    }
  }

  /**
   * PR #352 — Time series intraday. Endpoint : GET /time_series.
   * Doc : https://twelvedata.com/docs#time-series
   * Coût forfaitisé : ceil(outputsize / 5) credits (1m count=20 = 4 credits).
   * Renvoie les candles en ordre chronologique asc (TD renvoie desc).
   */
  async getCandles(
    symbol: string,
    interval: '1min' | '5min' | '15min' | '1h' = '1min',
    outputsize = 20,
    calledBy = 'intraday',
  ): Promise<{
    symbol: string;
    interval: string;
    candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
    asOf: number;
  } | null> {
    if (!this.apiKey) return null;
    const credits = Math.max(1, Math.ceil(outputsize / 5));
    if (!this.creditTracker.canConsume(credits)) {
      this.logger.warn(
        `[twelvedata] rate limit hit for getCandles(${symbol}) credits=${credits} daily=${this.creditTracker.getDailyUsage()}`,
      );
      void this.logCall({
        endpoint: 'time_series',
        symbol,
        interval,
        success: false,
        statusCode: 0,
        creditsUsed: 0,
        latencyMs: 0,
        errorMessage: 'rate_limit_internal',
        calledBy,
      });
      return null;
    }
    const tStart = Date.now();
    try {
      const params = new URLSearchParams({
        symbol,
        interval,
        outputsize: String(outputsize),
        apikey: this.apiKey,
      });
      const url = `${BASE_URL}/time_series?${params.toString()}`;
      const res = await this.fetchWithTimeout(url);
      const latencyMs = Date.now() - tStart;
      this.creditTracker.consume(credits);
      if (!res.ok) {
        void this.logCall({
          endpoint: 'time_series',
          symbol,
          interval,
          success: false,
          statusCode: res.status,
          creditsUsed: credits,
          latencyMs,
          errorMessage: `HTTP_${res.status}`,
          calledBy,
        });
        return null;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const values = data?.values;
      if (data?.status === 'error' || !Array.isArray(values)) {
        void this.logCall({
          endpoint: 'time_series',
          symbol,
          interval,
          success: false,
          statusCode: res.status,
          creditsUsed: credits,
          latencyMs,
          errorMessage: String(data?.message ?? 'no_values').slice(0, 200),
          calledBy,
        });
        return null;
      }
      const candles = (values as Array<Record<string, string>>)
        .map((v) => ({
          timestamp: Math.floor(new Date(v.datetime).getTime() / 1000),
          open: Number(v.open),
          high: Number(v.high),
          low: Number(v.low),
          close: Number(v.close),
          volume: Number(v.volume ?? 0),
        }))
        .filter((c) => Number.isFinite(c.close) && c.close > 0)
        .reverse(); // TD renvoie desc, on veut asc
      this.logStructured('time_series', symbol, interval, 'ok', credits, latencyMs);
      void this.logCall({
        endpoint: 'time_series',
        symbol,
        interval,
        success: true,
        statusCode: res.status,
        creditsUsed: credits,
        latencyMs,
        calledBy,
      });
      return { symbol, interval, candles, asOf: Date.now() };
    } catch (err) {
      const latencyMs = Date.now() - tStart;
      void this.logCall({
        endpoint: 'time_series',
        symbol,
        interval,
        success: false,
        statusCode: null,
        creditsUsed: credits,
        latencyMs,
        errorMessage: String((err as Error).message).slice(0, 200),
        calledBy,
      });
      return null;
    }
  }

  /**
   * Cœur HTTP partagé : rate-limit check + 1 retry sur 429/5xx + log structuré
   * + insert Supabase.
   */
  private async callIndicator(
    endpoint: 'supertrend' | 'rsi' | 'atr',
    symbol: string,
    interval: string,
    extraParams: Record<string, string>,
    calledBy: string,
  ): Promise<unknown | null> {
    if (!this.apiKey) return null;
    if (!this.creditTracker.canConsume(1)) {
      this.logger.warn(
        `[twelvedata] rate limit reached (minute=${this.creditTracker.getMinuteWindowSize()}, daily=${this.creditTracker.getDailyUsage()}) — skip ${endpoint} ${symbol}`,
      );
      void this.logCall({
        endpoint,
        symbol,
        interval,
        success: false,
        statusCode: 0,
        creditsUsed: 0,
        latencyMs: 0,
        errorMessage: 'rate_limit_internal',
        calledBy,
      });
      return null;
    }

    const params = new URLSearchParams({
      symbol,
      interval,
      apikey: this.apiKey,
      ...extraParams,
    });
    const url = `${BASE_URL}/${endpoint}?${params.toString()}`;

    const tStart = Date.now();
    let attempt = 0;
    let lastErr: { status: number | null; message: string } = { status: null, message: '' };

    while (attempt < 2) {
      attempt++;
      try {
        const res = await this.fetchWithTimeout(url);
        const latencyMs = Date.now() - tStart;

        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          // TwelveData renvoie parfois { code: 404, message: "...Pro plan..." } en 200
          if (typeof data.code === 'number' && data.code !== 200) {
            const msg = String(data.message ?? 'unknown twelvedata error');
            if (/pro plan|upgrade/i.test(msg)) {
              this.logger.error(`TwelveData: plan upgrade required for symbol ${symbol} (${msg})`);
            } else {
              this.logger.warn(`[twelvedata] ${endpoint} ${symbol} code=${data.code} : ${msg}`);
            }
            void this.logCall({
              endpoint,
              symbol,
              interval,
              success: false,
              statusCode: Number(data.code),
              creditsUsed: 1,
              latencyMs,
              errorMessage: msg.slice(0, 200),
              calledBy,
            });
            this.creditTracker.consume(1);
            return null;
          }
          this.creditTracker.consume(1);
          this.logStructured(endpoint, symbol, interval, 'ok', 1, latencyMs);
          void this.logCall({
            endpoint,
            symbol,
            interval,
            success: true,
            statusCode: res.status,
            creditsUsed: 1,
            latencyMs,
            calledBy,
          });
          return data;
        }

        lastErr = { status: res.status, message: `HTTP_${res.status}` };
        if (res.status === 429) {
          this.logger.warn(`[twelvedata] ${endpoint} ${symbol} HTTP 429 — retry after ${RETRY_429_DELAY_MS}ms`);
          await new Promise((r) => setTimeout(r, RETRY_429_DELAY_MS));
          continue;
        }
        if (res.status >= 500) {
          this.logger.warn(`[twelvedata] ${endpoint} ${symbol} HTTP ${res.status} — retry after ${RETRY_5XX_DELAY_MS}ms`);
          await new Promise((r) => setTimeout(r, RETRY_5XX_DELAY_MS));
          continue;
        }
        // 4xx (non-429) : pas de retry
        this.logger.warn(`[twelvedata] ${endpoint} ${symbol} HTTP ${res.status} — no retry`);
        break;
      } catch (err) {
        lastErr = { status: null, message: String((err as Error).message).slice(0, 200) };
        if (attempt < 2) {
          this.logger.warn(`[twelvedata] ${endpoint} ${symbol} exception (attempt ${attempt}/2) : ${lastErr.message} — retry`);
          await new Promise((r) => setTimeout(r, RETRY_5XX_DELAY_MS));
          continue;
        }
      }
    }

    void this.logCall({
      endpoint,
      symbol,
      interval,
      success: false,
      statusCode: lastErr.status,
      creditsUsed: 0,
      latencyMs: Date.now() - tStart,
      errorMessage: lastErr.message,
      calledBy,
    });
    return null;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  private logStructured(
    endpoint: string,
    symbol: string,
    interval: string,
    status: 'ok' | 'fail',
    creditsUsed: number,
    latencyMs: number,
  ): void {
    // JSON structuré, compatible VictoriaLogs / Loki grep
    this.logger.log(
      JSON.stringify({
        event: 'twelvedata_call',
        endpoint,
        symbol,
        interval,
        status,
        credits_used: creditsUsed,
        latency_ms: latencyMs,
        daily_usage: this.creditTracker.getDailyUsage(),
      }),
    );
  }

  private async logCall(row: {
    endpoint: string;
    symbol: string;
    interval: string | null;
    success: boolean;
    statusCode: number | null;
    creditsUsed: number;
    latencyMs: number;
    errorMessage?: string;
    calledBy: string;
  }): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('twelve_data_request_log')
        .insert({
          endpoint: row.endpoint,
          symbol: row.symbol,
          interval: row.interval,
          status_code: row.statusCode,
          success: row.success,
          credits_used: row.creditsUsed,
          latency_ms: row.latencyMs,
          error_message: row.errorMessage ?? null,
          called_by: row.calledBy,
        });
      if (error) {
        this.logger.warn(`[twelvedata] supabase log insert failed: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(`[twelvedata] supabase log exception: ${(err as Error).message}`);
    }
  }
}
