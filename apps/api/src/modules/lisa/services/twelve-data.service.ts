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
  private readonly creditTracker = new CreditTracker({
    perMinuteLimit: 7,
    perDayLimit: 750,
  });

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    const key = this.config.get<string>('TWELVEDATA_API_KEY');
    if (!key || key.trim() === '') {
      this.apiKey = null;
      this.logger.warn('[twelvedata] TWELVEDATA_API_KEY not set — all methods will return null');
    } else {
      this.apiKey = key;
      const tail = key.length >= 4 ? key.slice(-4) : '****';
      this.logger.log(`[twelvedata] provider initialized, key=***${tail} (length=${key.length})`);
    }
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
        `[twelvedata] rate limit reached (minute=${this.creditTracker.getMinuteWindowSize()}/7, daily=${this.creditTracker.getDailyUsage()}/750) — skip ${endpoint} ${symbol}`,
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
