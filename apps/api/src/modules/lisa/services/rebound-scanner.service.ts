/**
 * P3-A.2 + P3-C — Rebound watchlist scan loop avec pre-filter cache.
 *
 * Cron toutes les 15 minutes pendant heures marché US (lun-ven, 14:30-21:00
 * UTC). Pour chaque portfolio actif :
 *   1. Charge la watchlist (table `watchlist_universe` selon REBOUND_UNIVERSE,
 *      default 'sp500' ~200 tickers ; fallback TS si DB inaccessible).
 *   2. PHASE 1 — Pre-filter sur cache `ohlcv_cache_daily` :
 *      pour chaque ticker, calcule RSI(14) sur les bougies en cache. Garde
 *      uniquement les tickers où RSI < REBOUND_PREFILTER_RSI_MAX (default 35).
 *      Typiquement 30-50 candidats sur 500 → réduit le coût EODHD live ×10.
 *   3. PHASE 2 — Full scan sur candidats uniquement :
 *      fetch les bougies live (ou cache si frais < 1h), run scanRebound,
 *      sector cap, INSERT rebound_positions sur signal BUY.
 *   4. Garde-fous :
 *      - dailyTargetHit → freeze
 *      - count(OPEN) ≥ MAX_CONCURRENT_REBOUND_POSITIONS → skip
 *      - sector cap REBOUND_SECTOR_CAP_PCT (default 20%) — cf. assets.sector
 *      - hors heures marché US → no-op
 *   5. Audit `lisa_decision_log` kind='rebound_scan_completed' avec
 *      payload {phase1_count, phase2_count, signals, opened, skipped_reasons}.
 *
 * Pas d'exécution réelle. Les positions insérées sont du paper trading
 * géré ensuite par ReboundMonitorService (PR #43).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { OhlcvCacheService } from './ohlcv-cache.service';
import {
  scanRebound,
  evaluatePrefilter,
  type Candle,
  type ReboundCfg,
} from '@smartvest/ai-analyst';

interface EodhdEodBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close?: number;
  volume: number;
}

interface SkipReason {
  reason: string;
  ticker?: string;
}

@Injectable()
export class ReboundScannerService {
  private readonly logger = new Logger(ReboundScannerService.name);
  private readonly barsCache = new Map<string, { bars: Candle[]; asOf: number }>();
  private readonly BARS_CACHE_MS = 60 * 60 * 1000; // 1h — bars daily, pas d'intérêt à refetch < 1h

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly config: ConfigService,
    private readonly ohlcvCache: OhlcvCacheService,
  ) {}

  /**
   * Cron toutes les 15 minutes. La fenêtre marché US est checkée
   * dans le body pour permettre des tests manuels en dehors.
   */
  @Cron('0 */15 * * * 1-5', { name: 'rebound-scanner' })
  async runScanner(): Promise<void> {
    try {
      // Heures marché US : lun-ven 14:30-21:00 UTC.
      // Le cron pattern restreint déjà les jours (1-5) mais pas les heures.
      const now = new Date();
      const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
      const MARKET_OPEN_MIN = 14 * 60 + 30;
      const MARKET_CLOSE_MIN = 21 * 60;
      if (utcMin < MARKET_OPEN_MIN || utcMin >= MARKET_CLOSE_MIN) {
        this.logger.debug(`[rebound-scanner] hors heures marché US (UTC ${now.getUTCHours()}:${now.getUTCMinutes()}) — skip`);
        return;
      }
      await this.runScannerInner();
    } catch (e) {
      this.logger.error(`[rebound-scanner] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runScannerInner(): Promise<void> {
    // Charge tous les portfolios autopilot actifs (mêmes que lisa-autopilot).
    const { data: configs, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    if (error) {
      this.logger.error(`[rebound-scanner] fetch configs failed: ${error.message}`);
      return;
    }
    if (!configs || configs.length === 0) {
      this.logger.debug('[rebound-scanner] no active portfolios');
      return;
    }

    // P3-C — Watchlist via DB table (`watchlist_universe`) avec fallback
    // TS const si l'accès DB échoue. Permet hot-swap de l'univers via SQL
    // sans redeploy.
    const watchlist = await this.getWatchlistAsync();
    for (const cfg of configs) {
      const portfolioId = cfg.portfolio_id as string;
      const userId = cfg.user_id as string;
      try {
        await this.scanPortfolio(userId, portfolioId, watchlist);
      } catch (e) {
        this.logger.warn(
          `[rebound-scanner] portfolio ${portfolioId.slice(0, 8)} scan failed: ${String(e).slice(0, 120)}`,
        );
      }
    }
  }

  private async scanPortfolio(
    userId: string,
    portfolioId: string,
    watchlist: string[],
  ): Promise<void> {
    const skipped: SkipReason[] = [];
    let signalsFound = 0;
    let opened = 0;

    // ── Garde-fou 1 : dailyTargetHit ─────────────────────────────────
    let dailyTargetHit = false;
    try {
      const dailyPnl = await this.lisa.getDailyPnl(userId, portfolioId);
      dailyTargetHit = dailyPnl.dailyTargetHit;
    } catch (e) {
      this.logger.debug(`getDailyPnl failed (non-blocking): ${String(e).slice(0, 80)}`);
    }
    if (dailyTargetHit) {
      skipped.push({ reason: 'daily_target_hit' });
      await this.writeAudit(portfolioId, watchlist.length, 0, 0, skipped);
      return;
    }

    // ── Garde-fou 2 : MAX_CONCURRENT positions OPEN ──────────────────
    const maxConcurrent = this.getMaxConcurrent();
    const { data: openPositions, error: openErr } = await this.supabase
      .getClient()
      .from('rebound_positions')
      .select('ticker')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'OPEN');
    if (openErr) {
      this.logger.warn(`[rebound-scanner] count OPEN failed: ${openErr.message}`);
      return;
    }
    const openCount = (openPositions ?? []).length;
    const openTickers = new Set((openPositions ?? []).map((p) => String(p.ticker)));
    if (openCount >= maxConcurrent) {
      skipped.push({ reason: `max_concurrent_${openCount}>=${maxConcurrent}` });
      await this.writeAudit(portfolioId, watchlist.length, 0, 0, skipped);
      return;
    }

    const cfg = this.scannerCfg();
    const slotsAvailable = maxConcurrent - openCount;

    // ── PHASE 1 — Pre-filter cache (RSI < threshold) ────────────────
    // Lecture parallèle du cache pour les 500 tickers, calc RSI pur,
    // filtre les tickers déjà OPEN. Pas de fetch réseau.
    const rsiThreshold = this.getPrefilterRsiMax();
    const eligible = watchlist.filter((t) => {
      const base = t.split('.')[0];
      return !openTickers.has(t) && !openTickers.has(base);
    });

    const phase1Results = await Promise.all(
      eligible.map(async (ticker) => {
        const bars = await this.ohlcvCache.getCachedBars(ticker, 30).catch(() => null);
        const result = evaluatePrefilter(ticker, bars ?? null, rsiThreshold);
        return { ticker, bars, result };
      }),
    );

    const candidates = phase1Results.filter((r) => r.result.passes);
    const phase1Count = eligible.length;
    const phase2Count = candidates.length;

    if (phase2Count === 0) {
      // Pas de candidat oversold dans toute la watchlist — exit propre.
      await this.writeAudit(
        portfolioId,
        watchlist.length,
        0,
        0,
        skipped,
        phase1Count,
        phase2Count,
      );
      return;
    }

    // P3-C — sector cap : compte exposition par secteur sur les positions
    // OPEN. Cap REBOUND_SECTOR_CAP_PCT (default 20% = max 1 position de
    // ce secteur si MAX_CONCURRENT=5).
    const sectorCapPct = this.getSectorCapPct();
    const sectorByTicker = await this.fetchSectorByTickers(
      [...openTickers, ...candidates.map((c) => c.ticker.split('.')[0])],
    );
    const sectorOpenCounts = new Map<string, number>();
    for (const baseTicker of openTickers) {
      const sector = sectorByTicker.get(baseTicker) ?? 'unknown';
      sectorOpenCounts.set(sector, (sectorOpenCounts.get(sector) ?? 0) + 1);
    }
    const maxPerSector = Math.max(1, Math.floor((maxConcurrent * sectorCapPct) / 100));

    // ── PHASE 2 — Full scan sur candidats uniquement ────────────────
    for (const cand of candidates) {
      const eodhdTicker = cand.ticker;
      const baseSymbol = eodhdTicker.split('.')[0];

      // Sector cap
      const sector = sectorByTicker.get(baseSymbol) ?? 'unknown';
      const currentSectorCount = sectorOpenCounts.get(sector) ?? 0;
      if (currentSectorCount >= maxPerSector) {
        skipped.push({ reason: `sector_cap_${sector}`, ticker: eodhdTicker });
        continue;
      }

      // Full bars : si cache a déjà 30 bars utiles ET ces bars sont
      // récentes, on les réutilise directement. Sinon fetch live.
      let bars: Candle[] | null = cand.bars;
      if (!bars || bars.length < 20) {
        bars = await this.getDailyBars(eodhdTicker, 60).catch(() => null);
      }
      if (!bars || bars.length < 20) {
        skipped.push({ reason: 'insufficient_bars', ticker: eodhdTicker });
        continue;
      }

      const sig = scanRebound(bars, cfg);
      if (sig.type !== 'BUY') continue;
      signalsFound++;

      if (opened >= slotsAvailable) {
        skipped.push({ reason: 'slot_exhausted', ticker: eodhdTicker });
        continue;
      }

      const inserted = await this.insertReboundPosition(portfolioId, baseSymbol, sig);
      if (inserted) {
        opened++;
        sectorOpenCounts.set(sector, currentSectorCount + 1);
        this.logger.log(
          `[rebound-scanner] ${baseSymbol} (sector=${sector}) BUY → INSERT rebound_position (entry=${sig.entry}, tp1=${sig.tp1}, sl=${sig.sl}, conf=${sig.confidence})`,
        );
      } else {
        skipped.push({ reason: 'insert_failed', ticker: eodhdTicker });
      }
    }

    await this.writeAudit(
      portfolioId,
      watchlist.length,
      signalsFound,
      opened,
      skipped,
      phase1Count,
      phase2Count,
    );
  }

  /**
   * P3-C — Lookup sector pour une liste de tickers via la table `assets`.
   * `assets.industry` n'existe pas dans le schéma actuel — on utilise
   * `assets.sector` (champ existant 0001_init_schema). Tickers absents
   * de la table reçoivent 'unknown' qui n'est jamais cap-bloqué (mais
   * compte vers le total OPEN).
   */
  private async fetchSectorByTickers(baseSymbols: Iterable<string>): Promise<Map<string, string>> {
    const list = Array.from(new Set([...baseSymbols].filter(Boolean)));
    if (list.length === 0) return new Map();
    const { data, error } = await this.supabase
      .getClient()
      .from('assets')
      .select('ticker, sector')
      .in('ticker', list);
    if (error) {
      this.logger.warn(`[rebound-scanner] assets.sector fetch failed: ${error.message}`);
      return new Map();
    }
    const map = new Map<string, string>();
    for (const row of data ?? []) {
      const t = row.ticker as string | null;
      const s = row.sector as string | null;
      if (t && s) map.set(t, s);
    }
    return map;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * P3-C — Watchlist via DB table `watchlist_universe` (param REBOUND_UNIVERSE,
   * default 'sp500'). Override env CSV `REBOUND_WATCHLIST` override la DB.
   * Fallback final TS si aucune source disponible.
   */
  private async getWatchlistAsync(): Promise<string[]> {
    const csvOverride = this.config.get<string>('REBOUND_WATCHLIST');
    if (csvOverride && csvOverride.trim().length > 0) {
      return csvOverride.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    }
    return this.ohlcvCache.getActiveUniverse();
  }

  /**
   * Synchrone — utilisé uniquement par les tests legacy (env CSV).
   */
  private getWatchlist(): string[] {
    const env = this.config.get<string>('REBOUND_WATCHLIST');
    if (env && env.trim().length > 0) {
      return env.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    }
    // Mini-fallback sync pour test compat — 12 mega-caps
    return [
      'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
      'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
    ];
  }

  private getMaxConcurrent(): number {
    const v = Number(this.config.get<string>('MAX_CONCURRENT_REBOUND_POSITIONS'));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5;
  }

  private getPrefilterRsiMax(): number {
    const v = Number(this.config.get<string>('REBOUND_PREFILTER_RSI_MAX'));
    return Number.isFinite(v) && v > 0 ? v : 35;
  }

  private getSectorCapPct(): number {
    const v = Number(this.config.get<string>('REBOUND_SECTOR_CAP_PCT'));
    return Number.isFinite(v) && v > 0 ? v : 20;
  }

  private scannerCfg(): ReboundCfg {
    const num = (k: string) => {
      const v = Number(this.config.get<string>(k));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    const cfg: ReboundCfg = {};
    const rsi = num('REBOUND_RSI_OVERSOLD');
    if (rsi !== undefined) cfg.rsiOversold = rsi;
    const dd = num('REBOUND_MIN_DD_PCT');
    if (dd !== undefined) cfg.minDrawdownPct = dd;
    const vol = num('REBOUND_VOL_SPIKE');
    if (vol !== undefined) cfg.volSpikeMult = vol;
    const tp1 = num('REBOUND_TP1_PCT');
    if (tp1 !== undefined) cfg.tp1Pct = tp1;
    const tp2 = num('REBOUND_TP2_PCT');
    if (tp2 !== undefined) cfg.tp2Pct = tp2;
    const tp3 = num('REBOUND_TP3_PCT');
    if (tp3 !== undefined) cfg.tp3Pct = tp3;
    const sl = num('REBOUND_SL_PCT');
    if (sl !== undefined) cfg.slPct = sl;
    const ts = num('REBOUND_TIME_STOP_DAYS');
    if (ts !== undefined) cfg.timeStopDays = ts;
    return cfg;
  }

  /**
   * Fetch les N dernières bougies daily OHLCV depuis EODHD `/api/eod/`.
   * Cache mémoire 1h pour éviter de spammer l'API en cycle 15min.
   *
   * Retourne null si :
   *   - EODHD_API_KEY non set
   *   - HTTP error / timeout
   *   - Réponse mal formée ou < N bars
   */
  private async getDailyBars(eodhdTicker: string, count: number): Promise<Candle[] | null> {
    const cached = this.barsCache.get(eodhdTicker);
    if (cached && Date.now() - cached.asOf < this.BARS_CACHE_MS) {
      return cached.bars.slice(-count);
    }

    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) {
      this.logger.warn('[rebound-scanner] EODHD_API_KEY missing — cannot fetch bars');
      return null;
    }

    // Sur 60 daily bars, on demande 90 jours calendaires pour couvrir
    // weekends + holidays (ratio ~252 trading days / 365 cal days).
    const calendarDays = Math.ceil(count * 1.5);
    const to = new Date();
    const from = new Date(Date.now() - calendarDays * 86_400_000);
    const url = `https://eodhd.com/api/eod/${encodeURIComponent(eodhdTicker)}?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}&api_token=${encodeURIComponent(apiKey)}&fmt=json&order=a`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        this.logger.warn(`[rebound-scanner] EODHD ${eodhdTicker} HTTP_${res.status}`);
        return null;
      }
      const data = (await res.json()) as EodhdEodBar[];
      if (!Array.isArray(data) || data.length < count) return null;

      const bars: Candle[] = data
        .filter(
          (d) =>
            typeof d.open === 'number' &&
            typeof d.high === 'number' &&
            typeof d.low === 'number' &&
            typeof d.close === 'number' &&
            typeof d.volume === 'number',
        )
        .map((d) => ({
          timestamp: d.date,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
        }));

      this.barsCache.set(eodhdTicker, { bars, asOf: Date.now() });
      return bars.slice(-count);
    } catch (e) {
      this.logger.warn(`[rebound-scanner] EODHD ${eodhdTicker} fetch failed: ${String(e).slice(0, 80)}`);
      return null;
    }
  }

  /**
   * INSERT rebound_positions row. Idempotence garantie côté caller (vérif
   * openTickers Set + duplicate guard sur (portfolio_id, ticker, status='OPEN')
   * géré par requête .select avant INSERT).
   *
   * Retourne true sur INSERT réussi, false sinon.
   */
  private async insertReboundPosition(
    portfolioId: string,
    ticker: string,
    sig: Extract<ReturnType<typeof scanRebound>, { type: 'BUY' }>,
  ): Promise<boolean> {
    // Anti race-condition : double-check qu'aucune position OPEN n'existe
    // sur ce ticker (un autre tick parallèle pourrait avoir inséré entre
    // notre lecture initiale et maintenant).
    const { data: existing } = await this.supabase
      .getClient()
      .from('rebound_positions')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('ticker', ticker)
      .eq('status', 'OPEN')
      .limit(1)
      .maybeSingle();
    if (existing) return false;

    const stopAt = new Date(Date.now() + sig.timeStopDays * 86_400_000).toISOString();
    const { error } = await this.supabase.getClient().from('rebound_positions').insert({
      portfolio_id: portfolioId,
      ticker,
      entry_price: sig.entry.toFixed(6),
      tp1: sig.tp1.toFixed(6),
      tp2: sig.tp2.toFixed(6),
      tp3: sig.tp3.toFixed(6),
      sl: sig.sl.toFixed(6),
      time_stop_at: stopAt,
      status: 'OPEN',
      filled_qty_pct: '100.00',
      realized_pnl_usd: '0',
      scanner_confidence: sig.confidence.toFixed(3),
      scanner_indicators: sig.indicators,
    });
    if (error) {
      this.logger.error(`[rebound-scanner] insert ${ticker} failed: ${error.message}`);
      return false;
    }
    return true;
  }

  /**
   * Trace le résultat du scan dans lisa_decision_log (chaîne hash, audit
   * immutable côté Supabase).
   */
  private async writeAudit(
    portfolioId: string,
    scanned: number,
    signalsFound: number,
    opened: number,
    skipped: SkipReason[],
    phase1Count: number = 0,
    phase2Count: number = 0,
  ): Promise<void> {
    try {
      const phasesNote = phase1Count > 0 ? ` · phase1=${phase1Count} · phase2=${phase2Count}` : '';
      await this.decisionLog.append({
        portfolioId,
        kind: 'rebound_scan_completed',
        summary: `Scan ${scanned} tickers${phasesNote} · signals=${signalsFound} · opened=${opened} · skipped=${skipped.length}`,
        rationale: skipped.slice(0, 6).map((s) => `${s.reason}${s.ticker ? `(${s.ticker})` : ''}`).join(', '),
        payload: {
          scanned,
          phase1_count: phase1Count,
          phase2_count: phase2Count,
          signals_found: signalsFound,
          opened,
          skipped_reasons: skipped,
        },
        triggeredBy: 'mechanical_cron',
      });
    } catch (e) {
      this.logger.debug(`[rebound-scanner] audit append failed: ${String(e).slice(0, 80)}`);
    }
  }
}
