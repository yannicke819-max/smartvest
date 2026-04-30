import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataProvider, ProviderAsset } from '../market-data-provider.interface';
import { InstrumentQuote } from '../../dto/instrument-quote.dto';
import { PriceBar } from '../../dto/price-bar.dto';
import { EodRealtimeQuote, EodEodBar } from './eod-types';
import { normalizeEodRealtimeQuote, normalizeEodBar } from './eod-normalizer';

const BASE_URL = 'https://eodhd.com/api';

/**
 * P19u (30/04/2026 08:30 UTC HOTFIX RATE-LIMIT) — Concurrency guard +
 * retry on 402/429 + quote cache 60s.
 *
 * Bug observed prod : `fetchQuotes` parallelisé via Promise.allSettled sur
 * 9 tickers + scanner top-gainers en parallèle = burst > 1000 req/min →
 * EODHD répond HTTP 402 (rate limit per-minute exceeded).
 *
 * Fix :
 *   - Concurrency cap : max 50 calls EODHD parallèles (sema simple).
 *   - Retry on 402/429 : exponential backoff 1s/2s/4s, max 3 tries.
 *     Lit Retry-After header si présent.
 *   - Cache 60s sur quotes (ETF macro bougent peu sur 1 min).
 *   - Dédup intra-batch : si 2 calls même ticker dans le batch → 1 seul.
 */
const QUOTE_CACHE_TTL_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]; // exponential backoff
const MAX_PARALLEL_CALLS = 50;

@Injectable()
export class EodProvider implements MarketDataProvider {
  readonly name = 'eodhd';
  private readonly logger = new Logger(EodProvider.name);

  /** P19u — Cache quotes par ticker. */
  private quoteCache = new Map<string, { quote: InstrumentQuote; asOf: number }>();

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('EODHD_API_KEY') ?? 'demo';
  }

  /**
   * P19u — Throttled fetch avec retry on 402/429.
   * Retourne null si exhausted (toutes retries échouées).
   */
  private async fetchWithRetry(url: string, label: string): Promise<Response | null> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res;
      // 402 = Payment Required (daily exhausted) ou rate per-minute
      // 429 = Too Many Requests (rate per-minute)
      if (res.status === 402 || res.status === 429) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          this.logger.warn(
            `[eod:retry] ${label} HTTP ${res.status} after ${RETRY_DELAYS_MS.length} retries — giving up`,
          );
          return res;
        }
        // Lire Retry-After header (en secondes ou date HTTP)
        const retryAfter = res.headers.get('Retry-After');
        let delayMs = RETRY_DELAYS_MS[attempt];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            delayMs = Math.min(parsed * 1000, 30_000); // cap 30s pour éviter blocage cron
          }
        }
        this.logger.debug(
          `[eod:retry] ${label} HTTP ${res.status} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}, sleep ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Other errors : no retry
      return res;
    }
    return null;
  }

  async fetchQuotes(assets: ProviderAsset[]): Promise<InstrumentQuote[]> {
    if (assets.length === 0) return [];

    // P19u — Dédup intra-batch + cache hit pré-fetch
    const now = Date.now();
    const uniqueAssets = new Map<string, ProviderAsset>();
    for (const a of assets) {
      if (!uniqueAssets.has(a.providerTicker)) uniqueAssets.set(a.providerTicker, a);
    }

    const results: InstrumentQuote[] = [];
    const toFetch: ProviderAsset[] = [];
    for (const [_, asset] of uniqueAssets) {
      const cached = this.quoteCache.get(asset.providerTicker);
      if (cached && now - cached.asOf < QUOTE_CACHE_TTL_MS) {
        results.push(cached.quote);
      } else {
        toFetch.push(asset);
      }
    }

    if (toFetch.length === 0) return results;

    // P19u — Concurrency guard : process by chunks de MAX_PARALLEL_CALLS
    const errors: string[] = [];
    for (let i = 0; i < toFetch.length; i += MAX_PARALLEL_CALLS) {
      const chunk = toFetch.slice(i, i + MAX_PARALLEL_CALLS);
      await Promise.allSettled(
        chunk.map(async (asset) => {
          try {
            const url = `${BASE_URL}/real-time/${encodeURIComponent(asset.providerTicker)}?api_token=${this.apiKey}&fmt=json`;
            const res = await this.fetchWithRetry(url, asset.ticker);
            if (!res || !res.ok) {
              throw new Error(`HTTP ${res?.status ?? 'no_response'}`);
            }
            const raw: EodRealtimeQuote = await res.json();
            const normalized = normalizeEodRealtimeQuote(raw, asset);
            results.push(normalized);
            // P19u — Cache fill TTL 60s
            this.quoteCache.set(asset.providerTicker, { quote: normalized, asOf: Date.now() });
          } catch (err) {
            errors.push(`${asset.ticker}: ${(err as Error).message}`);
          }
        }),
      );
    }

    if (errors.length > 0) {
      this.logger.warn(`fetchQuotes errors: ${errors.join(', ')}`);
    }
    return results;
  }

  async fetchDailyBars(
    assets: ProviderAsset[],
    fromDate: string,
    toDate: string,
  ): Promise<PriceBar[]> {
    if (assets.length === 0) return [];

    const results: PriceBar[] = [];
    const errors: string[] = [];

    // P19u — Concurrency cap aussi sur fetchDailyBars
    for (let i = 0; i < assets.length; i += MAX_PARALLEL_CALLS) {
      const chunk = assets.slice(i, i + MAX_PARALLEL_CALLS);
      await Promise.allSettled(
        chunk.map(async (asset) => {
          try {
            const url =
              `${BASE_URL}/eod/${encodeURIComponent(asset.providerTicker)}` +
              `?api_token=${this.apiKey}&fmt=json&from=${fromDate}&to=${toDate}&period=d`;
            const res = await this.fetchWithRetry(url, asset.ticker);
            if (!res || !res.ok) {
              throw new Error(`HTTP ${res?.status ?? 'no_response'}`);
            }
            const bars: EodEodBar[] = await res.json();
            for (const bar of bars) {
              results.push(normalizeEodBar(bar, asset));
            }
          } catch (err) {
            errors.push(`${asset.ticker}: ${(err as Error).message}`);
          }
        }),
      );
    }

    if (errors.length > 0) {
      this.logger.warn(`fetchDailyBars errors: ${errors.join(', ')}`);
    }
    return results;
  }
}
