/**
 * P3-A.2 — Rebound watchlist scan loop.
 *
 * Cron toutes les 15 minutes pendant heures marché US (lun-ven, 14:30-21:00
 * UTC). Pour chaque portfolio actif :
 *   1. Charge la watchlist (hardcodée pour le moment, cf. WATCHLIST_DEFAULT).
 *   2. Pour chaque ticker → fetch 60 daily bars via EODHD `/api/eod/`.
 *   3. Appel `scanRebound(history)`. Si BUY ET pas de position OPEN
 *      existante sur (portfolio_id, ticker) → INSERT rebound_positions.
 *   4. Garde-fous :
 *      - dailyTargetHit (cumul réalisé+latent ≥ DAILY_TARGET_USD) → freeze
 *      - count(OPEN) ≥ MAX_CONCURRENT_REBOUND_POSITIONS → skip
 *      - hors heures marché US → no-op
 *   5. Audit `lisa_decision_log` kind='rebound_scan_completed'.
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
import { scanRebound, type Candle, type ReboundCfg } from '@smartvest/ai-analyst';

/**
 * Watchlist par défaut : 12 tickers US liquides à mid/high cap, couvrant
 * tech méga-cap, semi, ETF index, énergie. Choix pour avoir une diversité
 * sectorielle sans table watchlist dédiée. Surchargeable par env
 * `REBOUND_WATCHLIST` (CSV).
 */
const WATCHLIST_DEFAULT = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
  'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
];

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

    const watchlist = this.getWatchlist();
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

    // ── Loop watchlist ───────────────────────────────────────────────
    const cfg = this.scannerCfg();
    const slotsAvailable = maxConcurrent - openCount;

    for (const eodhdTicker of watchlist) {
      // Duplicate guard : skip si position OPEN existe déjà sur ce ticker.
      const baseSymbol = eodhdTicker.split('.')[0];
      if (openTickers.has(eodhdTicker) || openTickers.has(baseSymbol)) {
        skipped.push({ reason: 'already_open', ticker: eodhdTicker });
        continue;
      }

      // Fetch bars (60 demandés, minimum 20 requis par scanRebound).
      const bars = await this.getDailyBars(eodhdTicker, 60).catch(() => null);
      if (!bars || bars.length < 20) {
        skipped.push({ reason: 'insufficient_bars', ticker: eodhdTicker });
        continue;
      }

      // Run scanner
      const sig = scanRebound(bars, cfg);
      if (sig.type !== 'BUY') {
        // Diagnostic dispo via sig.reason — on l'évite pour ne pas bloater
        // l'audit (la majorité des scans sont HOLD).
        continue;
      }
      signalsFound++;

      if (opened >= slotsAvailable) {
        skipped.push({ reason: 'slot_exhausted', ticker: eodhdTicker });
        continue;
      }

      // INSERT rebound_positions.
      const inserted = await this.insertReboundPosition(
        portfolioId,
        baseSymbol,
        sig,
      );
      if (inserted) {
        opened++;
        this.logger.log(
          `[rebound-scanner] ${baseSymbol} BUY signaled → INSERT rebound_position (entry=${sig.entry}, tp1=${sig.tp1}, sl=${sig.sl}, conf=${sig.confidence})`,
        );
      } else {
        skipped.push({ reason: 'insert_failed', ticker: eodhdTicker });
      }
    }

    await this.writeAudit(portfolioId, watchlist.length, signalsFound, opened, skipped);
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private getWatchlist(): string[] {
    const env = this.config.get<string>('REBOUND_WATCHLIST');
    if (env && env.trim().length > 0) {
      return env
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
    return WATCHLIST_DEFAULT;
  }

  private getMaxConcurrent(): number {
    const v = Number(this.config.get<string>('MAX_CONCURRENT_REBOUND_POSITIONS'));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5;
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
  ): Promise<void> {
    try {
      await this.decisionLog.append({
        portfolioId,
        kind: 'rebound_scan_completed',
        summary: `Scan ${scanned} tickers · signals=${signalsFound} · opened=${opened} · skipped=${skipped.length}`,
        rationale: skipped.slice(0, 6).map((s) => `${s.reason}${s.ticker ? `(${s.ticker})` : ''}`).join(', '),
        payload: { scanned, signals_found: signalsFound, opened, skipped_reasons: skipped },
        triggeredBy: 'mechanical_cron',
      });
    } catch (e) {
      this.logger.debug(`[rebound-scanner] audit append failed: ${String(e).slice(0, 80)}`);
    }
  }
}
