/**
 * EodhdNewsCollectorService — cron toutes les 30 min qui pull les news des
 * tickers actuellement dans l'univers du scanner. Étape 1 fondation.
 *
 * Stratégie de batch :
 *   - Récupère l'univers actif via `watchlist_universe` (US + EU + Asia)
 *   - + tickers du panier fixe gold/energy
 *   - Cap dur configurable `EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE` (default 50)
 *     pour ne pas exploser la quota EODHD (100k/jour, mais on est partagés).
 *   - 50 tickers × 48 cycles/jour = 2400 calls/jour = 2.4% du quota → safe.
 *
 * Window pull : 24h glissantes. Les news plus anciennes restent en DB,
 * dedupe via UNIQUE (ticker, external_id) côté EodhdNewsService.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdNewsService } from './eodhd-news.service';

@Injectable()
export class EodhdNewsCollectorService {
  private readonly logger = new Logger(EodhdNewsCollectorService.name);
  private readonly enabled: boolean;
  private readonly maxPerCycle: number;
  private collecting = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly news: EodhdNewsService,
  ) {
    this.enabled = (this.config.get<string>('EODHD_NEWS_PERSIST_ENABLED') ?? 'false').toLowerCase() === 'true';
    this.maxPerCycle = Number(this.config.get<string>('EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE') ?? '50');
    if (this.enabled) {
      this.logger.log(`[eodhd-news-collector] ENABLED (cron */30min, max=${this.maxPerCycle}/cycle)`);
    }
  }

  /** Toutes les 30 min, indépendant des sessions (news 24/7 even when markets closed). */
  @Cron('*/30 * * * *', { timeZone: 'UTC' })
  async cronCollect(): Promise<void> {
    if (!this.enabled || !this.news.isEnabled()) return;
    if (this.collecting) {
      this.logger.debug('[eodhd-news-collector] previous cycle still running, skip');
      return;
    }
    this.collecting = true;
    try {
      await this.runCollectCycle();
    } catch (e) {
      this.logger.warn(`[eodhd-news-collector] cycle failed: ${String(e).slice(0, 200)}`);
    } finally {
      this.collecting = false;
    }
  }

  /** Visible for tests. Pulls news pour `tickers` (ou univers actif si non fourni). */
  async runCollectCycle(tickers?: string[]): Promise<{ processed: number; persisted: number }> {
    const list = tickers ?? (await this.fetchActiveUniverse());
    if (list.length === 0) {
      this.logger.debug('[eodhd-news-collector] universe empty, skip');
      return { processed: 0, persisted: 0 };
    }
    // Cap dur pour ne pas exploser la quota
    const batch = list.slice(0, this.maxPerCycle);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

    let processed = 0;
    let persisted = 0;
    for (const ticker of batch) {
      const n = await this.news.fetchAndPersistOne(ticker, yesterday, today);
      processed++;
      persisted += n;
      // micro-pause anti-burst (50 tickers × 80ms = 4s)
      await new Promise((r) => setTimeout(r, 80));
    }
    this.logger.log(`[eodhd-news-collector] processed=${processed} persisted=${persisted}`);
    return { processed, persisted };
  }

  /**
   * Récupère l'univers actif côté DB : watchlist_universe (US+EU+Asia) + crypto majors.
   *
   * Crypto INCLUS (probé 23/05/2026 : EODHD news API supporte format `<BASE>.CC`
   * pour 9/10 majors avec sentiment). Le mapping USDT → .CC se fait dans
   * `EodhdNewsService.toEodhdNewsTicker`. On persiste sous le scanner symbol
   * (BTCUSDT) pour lookup direct par le filtre Phase 2.
   */
  private async fetchActiveUniverse(): Promise<string[]> {
    if (!this.supabase.isReady()) return CRYPTO_MAJORS;
    const { data, error } = await this.supabase
      .getClient()
      .from('watchlist_universe')
      .select('symbol')
      .limit(500);
    if (error || !data) {
      this.logger.debug(`[eodhd-news-collector] universe query err: ${error?.message ?? 'no data'}`);
      return CRYPTO_MAJORS;
    }
    const equity = (data as Array<{ symbol: string }>).map((r) => r.symbol);
    // Crypto majors ajoutés en tête (10 tickers, news 24/7 utile pour brief).
    return [...CRYPTO_MAJORS, ...equity];
  }
}

const CRYPTO_MAJORS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'POLUSDT',
];
