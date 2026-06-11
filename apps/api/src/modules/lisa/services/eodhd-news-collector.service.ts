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
    this.maxPerCycle = Number(this.config.get<string>('EODHD_NEWS_COLLECTOR_MAX_PER_CYCLE') ?? '80');
    if (this.enabled) {
      this.logger.log(`[eodhd-news-collector] ENABLED (cron */30min, max=${this.maxPerCycle}/cycle)`);
    }
  }

  /** Toutes les 30 min, indépendant des sessions (news 24/7 even when markets closed). */
  // 29/05/2026 — bump 30min → 10min : latence ingestion observée 30-40 min
  // pre-bump (article publié 03:58 UTC → fetched 04:30 UTC). Pour le scalping
  // TRADER, 30 min de retard est trop. EODHD plan ALL-IN-ONE (100k calls/jour)
  // donne marge largement suffisante pour 144 calls/jour vs 48 actuels.
  @Cron('*/10 * * * *', { timeZone: 'UTC' })
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

  /** Visible for tests. Pulls news pour `tickers` (ou positions tenues + univers si non fourni). */
  async runCollectCycle(tickers?: string[]): Promise<{ processed: number; persisted: number }> {
    // FIX 11/06/2026 — POSITION-AWARE. Avant : le collecteur ne ramassait que les
    // `maxPerCycle` PREMIERS tickers de l'univers (10 crypto + ~40 US mega-caps),
    // sans jamais tourner → les positions EU/Asia (et la plupart des US tenues plus
    // bas dans l'univers, ex ARM/NXPI @ pos 700+) n'avaient JAMAIS de news → panel
    // veille vide. On collecte désormais les POSITIONS OUVERTES EN PREMIER (tous
    // portefeuilles), puis on remplit le reste du budget avec l'univers scanner.
    // La veille news ne sert que sur ce qu'on TIENT → priorité absolue.
    let list: string[];
    if (tickers) {
      list = tickers;
    } else {
      const held = await this.fetchHeldPositionSymbols();
      const universe = await this.fetchActiveUniverse();
      const seen = new Set<string>();
      list = [];
      for (const t of [...held, ...universe]) {
        const s = t.trim().toUpperCase();
        if (s.length > 0 && !seen.has(s)) {
          seen.add(s);
          list.push(s);
        }
      }
    }
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
   * Symboles des positions ACTUELLEMENT ouvertes (tous portefeuilles) — priorité
   * absolue de la collecte news : la veille news ne sert que sur ce qu'on TIENT.
   * Garantit que chaque position tenue (US + EU + Asia + crypto) a ses news, peu
   * importe sa place dans l'univers (les EU étaient @position 700-1161 → jamais
   * atteintes avant ce fix).
   */
  private async fetchHeldPositionSymbols(): Promise<string[]> {
    if (!this.supabase.isReady()) return [];
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol')
      .eq('status', 'open')
      .limit(1000);
    if (error || !data) {
      this.logger.debug(`[eodhd-news-collector] held positions query err: ${error?.message ?? 'no data'}`);
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of data as Array<{ symbol?: string | null }>) {
      const s = String(r.symbol ?? '').trim().toUpperCase();
      if (s.length > 0 && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  /**
   * Récupère l'univers actif côté DB : watchlist_universe (US+EU+Asia) + crypto majors.
   *
   * FIX 23/05/2026 : la colonne s'appelle `tickers` (text[]) PAS `symbol`. Avant
   * fix : query 404 → fallback crypto seul (10 tickers) → on perdait ~80 tickers
   * equity de l'univers et la DB news était sous-alimentée.
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
      .select('tickers')
      .limit(500);
    if (error || !data) {
      this.logger.debug(`[eodhd-news-collector] universe query err: ${error?.message ?? 'no data'}`);
      return CRYPTO_MAJORS;
    }
    // Flatten le text[] de chaque row + dedupe.
    const seen = new Set<string>();
    const equity: string[] = [];
    for (const row of data as Array<{ tickers?: string[] | null }>) {
      const list = Array.isArray(row.tickers) ? row.tickers : [];
      for (const t of list) {
        const sym = String(t).trim().toUpperCase();
        if (sym.length > 0 && !seen.has(sym)) { seen.add(sym); equity.push(sym); }
      }
    }
    // Crypto majors ajoutés en tête (10 tickers, news 24/7 utile pour brief).
    return [...CRYPTO_MAJORS, ...equity];
  }
}

const CRYPTO_MAJORS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'POLUSDT',
];
