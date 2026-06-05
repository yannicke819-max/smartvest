/**
 * Mode OVERSOLD — Scanner mean-reversion swing (PR-2 de docs/mode-oversold-spec.md).
 *
 * INVERSE exact du scanner gainers : on achète ce qui a CHUTÉ (pas monté),
 * en swing (hold J+10, pas scalp), 1×/jour post-close US (pas 5min).
 *
 * Edge validé 3-fold sur prix réels EODHD (session 04/06) :
 *   drop 1J entre -5% et -12% → hold J+10 → alpha +1.4% vs SPY, t=4.1, N=1416.
 *   Falling-knife <-12% EXCLU (alpha négatif confirmé, N=142).
 *
 * Cadence : 1 cron quotidien 21:15 UTC (15 min après la cloche US 21:00, pour
 * que la barre EOD du jour soit disponible chez EODHD).
 *
 * ISOLATION : ce service NE TOUCHE PAS top-gainers-scanner / mechanical-trading.
 * Il s'appuie uniquement sur les API publiques (paperBroker.openPositionDirect,
 * EODHD EOD fetch direct, DecisionLogService).
 *
 * Activation : env `OVERSOLD_SCANNER_ENABLED` (default 'true') ET au moins un
 * portfolio avec strategy_mode='oversold' + autopilot_enabled + kill_switch off.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import {
  buildOversoldCandidates,
  selectOversoldOpens,
  businessDaysSince,
  type OversoldConfig,
  type EodBar,
  type OversoldCandidate,
} from './oversold.helper';
import {
  analyzeIntradayRebound,
  passesIntradayReboundFilter,
  DEFAULT_INTRADAY_REBOUND_CONFIG,
  type IntradayReboundConfig,
} from './oversold-intraday.helper';
import { IntradayProviderRouter } from './intraday-provider-router.service';

/** Une position oversold enrichie pour l'UI dédiée (book summary). */
export interface OversoldBookPosition {
  symbol: string;
  entryPrice: number;
  currentPrice: number | null; // dernier close EOD (null si indispo)
  quantity: number;
  notionalUsd: number; // notionnel à l'entrée
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  dropPctAtEntry: number | null; // (entry/closePrev - 1)×100, recalculé EOD
  heldDays: number; // jours ouvrés écoulés depuis l'entrée
  daysRemaining: number; // holdDays - heldDays (≥ 0)
  stopPrice: number | null; // entry × (1 + stop_catastrophe%/100)
  distToStopPct: number | null; // marge avant stop catastrophe (positif = OK)
}

/** Synthèse du book oversold pour un portfolio (endpoint UI). */
export interface OversoldBookSummary {
  portfolioId: string;
  capitalUsd: number;
  openCount: number;
  deployedNotionalUsd: number;
  currentBookValueUsd: number; // Σ quantity × currentPrice (positions valorisées)
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number; // vs notionnel déployé
  realizedPnlUsd: number; // closed source=scanner_oversold
  realizedTrades: number;
  realizedWins: number;
  realizedWinRatePct: number | null;
  holdDaysTarget: number;
  stopCatastrophePct: number;
  dropBand: { min: number; max: number };
  asOf: string;
  positions: OversoldBookPosition[];
}

/** Row config oversold lue depuis lisa_session_configs. */
interface OversoldPortfolioRow {
  portfolio_id: string;
  oversold_drop_min_pct: number | string | null;
  oversold_drop_max_pct: number | string | null;
  oversold_hold_days: number | null;
  oversold_stop_catastrophe_pct: number | string | null;
  oversold_tp_pct: number | string | null;
  oversold_position_notional_usd: number | string | null;
  oversold_max_open_positions: number | null;
  oversold_universe: string | null;
}

/** Defaults issus de la migration 0191 (si une colonne est NULL en DB). */
const DEFAULTS = {
  dropMinPct: -12,
  dropMaxPct: -5,
  holdDays: 10,
  stopCatastrophePct: -15,
  tpPct: null as number | null,
  positionNotionalUsd: 1000,
  maxOpenPositions: 200,
  universe: 'russell1000',
};

@Injectable()
export class OversoldScannerService {
  private readonly logger = new Logger(OversoldScannerService.name);

  // Cap concurrence fetch EOD (rate-limit guard EODHD : ~1 call/symbole/jour,
  // mais on borne quand même pour ne pas ouvrir 1000 sockets simultanées).
  private readonly FETCH_CONCURRENCY = 6;
  private readonly FETCH_TIMEOUT_MS = 8000;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly config: ConfigService,
    private readonly intraday: IntradayProviderRouter,
  ) {}

  /** Gate env — désactivable sans redeploy via secret Fly. */
  private isEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_SCANNER_ENABLED') ?? 'true').toLowerCase() === 'true';
  }

  /**
   * Cron quotidien 21:15 UTC.
   * Format crontab nestjs (6 champs) : sec min hour day month weekday.
   */
  @Cron('0 15 21 * * *', { name: 'oversold-daily-scan', timeZone: 'UTC' })
  async runDailyScan(): Promise<void> {
    // Fail-safe global : jamais throw qui crashe le cron NestJS.
    try {
      if (!this.isEnabled()) {
        this.logger.debug('[oversold] OVERSOLD_SCANNER_ENABLED=false → skip cycle');
        return;
      }

      const portfolios = await this.loadOversoldPortfolios();
      if (portfolios.length === 0) {
        this.logger.debug('[oversold] aucun portfolio en mode oversold actif → skip');
        return;
      }

      for (const row of portfolios) {
        try {
          await this.scanPortfolio(row);
        } catch (err) {
          this.logger.error(
            `[oversold] scan portfolio ${row.portfolio_id.slice(0, 8)} échoué: ${String(err).slice(0, 300)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[oversold] runDailyScan exception globale: ${String(err).slice(0, 300)}`);
    }
  }

  /**
   * Charge les portfolios éligibles : mode oversold + autopilot ON + kill-switch OFF.
   */
  private async loadOversoldPortfolios(): Promise<OversoldPortfolioRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select(
        'portfolio_id, oversold_drop_min_pct, oversold_drop_max_pct, oversold_hold_days, ' +
          'oversold_stop_catastrophe_pct, oversold_tp_pct, oversold_position_notional_usd, ' +
          'oversold_max_open_positions, oversold_universe',
      )
      .eq('strategy_mode', 'oversold')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);
    if (error) {
      this.logger.warn(`[oversold] load portfolios failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as OversoldPortfolioRow[];
  }

  /** Normalise une row DB en config typée (avec defaults si NULL). */
  private resolveConfig(row: OversoldPortfolioRow): OversoldConfig {
    const num = (v: number | string | null, d: number): number => {
      if (v == null) return d;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : d;
    };
    const numOrNull = (v: number | string | null): number | null => {
      if (v == null) return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      dropMinPct: num(row.oversold_drop_min_pct, DEFAULTS.dropMinPct),
      dropMaxPct: num(row.oversold_drop_max_pct, DEFAULTS.dropMaxPct),
      holdDays: row.oversold_hold_days ?? DEFAULTS.holdDays,
      stopCatastrophePct: num(row.oversold_stop_catastrophe_pct, DEFAULTS.stopCatastrophePct),
      tpPct: numOrNull(row.oversold_tp_pct),
      positionNotionalUsd: num(row.oversold_position_notional_usd, DEFAULTS.positionNotionalUsd),
      maxOpenPositions: row.oversold_max_open_positions ?? DEFAULTS.maxOpenPositions,
      universe: row.oversold_universe ?? DEFAULTS.universe,
    };
  }

  /** Scan + ouverture pour un portfolio. */
  private async scanPortfolio(row: OversoldPortfolioRow): Promise<void> {
    const cfg = this.resolveConfig(row);
    const portfolioId = row.portfolio_id;

    // a. Charge l'univers depuis watchlist_universe.
    const tickers = await this.loadUniverse(cfg.universe);
    if (tickers.length === 0) {
      this.logger.warn(
        `[oversold] univers '${cfg.universe}' vide ou introuvable pour ${portfolioId.slice(0, 8)} → skip`,
      );
      return;
    }

    // f (anti-doublon) — symboles déjà ouverts sur ce portfolio.
    const openSymbols = await this.loadOpenSymbols(portfolioId);

    // b. Fetch EOD pour chaque ticker (cap concurrence) → bars.
    const barsBySymbol = await this.fetchUniverseBars(tickers);

    // c+d. Filtre + tri (pure helper, testable sans mock).
    const candidates = buildOversoldCandidates(barsBySymbol, cfg);
    const toOpen = selectOversoldOpens(candidates, openSymbols);

    let opened = 0;
    const errors: string[] = [];
    for (const cand of toOpen) {
      try {
        await this.openOversoldPosition(portfolioId, cand, cfg);
        opened++;
      } catch (err) {
        const msg = String(err).slice(0, 160);
        errors.push(`${cand.symbol}:${msg}`);
        this.logger.warn(`[oversold] open ${cand.symbol} échoué: ${msg}`);
      }
    }

    // g. Audit decision_log.
    await this.decisionLog
      .append({
        portfolioId,
        kind: 'oversold_scan_completed',
        summary: `Oversold scan: ${tickers.length} univers → ${candidates.length} candidats → ${opened} ouverts`,
        rationale:
          `Drop band [${cfg.dropMinPct}%, ${cfg.dropMaxPct}%], hold J+${cfg.holdDays}, ` +
          `notional $${cfg.positionNotionalUsd}, cap ${cfg.maxOpenPositions}. ` +
          (errors.length > 0 ? `Erreurs open: ${errors.slice(0, 5).join('; ')}` : 'Aucune erreur open.'),
        payload: {
          universe: cfg.universe,
          universe_size: tickers.length,
          candidates: candidates.length,
          opened,
          skipped_duplicates: candidates.filter((c) => openSymbols.has(c.symbol)).length,
          open_errors: errors.length,
          top_candidates: candidates.slice(0, 10).map((c) => ({
            symbol: c.symbol,
            drop_pct: Number(c.dropPct.toFixed(2)),
            close: c.closeJ,
          })),
        },
        triggeredBy: 'autopilot_cron',
        watchlistSource: 'mechanical',
        market: 'us_equity',
      })
      .catch((e) => this.logger.warn(`[oversold] decision_log append failed: ${String(e).slice(0, 160)}`));

    this.logger.log(
      `[oversold] portfolio=${portfolioId.slice(0, 8)} univers=${tickers.length} ` +
        `candidats=${candidates.length} ouverts=${opened}`,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // INTRADAY SCANNER — 6 ticks horaires pendant la session US (15-20 UTC).
  //
  // Différence vs runDailyScan (21:15 UTC) : applique en plus 4 filtres "rebond
  // confirmé" pour ne pas ouvrir des falling-knives intra-séance.
  // 1. drop EOD (close J vs close J-1) toujours dans [-12%, -5%]
  // 2. rebound depuis low_60min ≥ minReboundPct
  // 3. trend 15m ≥ minTrend15mPct
  // 4. bottom hors des N dernières bars (≥ 10 min de stabilisation)
  // 5. volume_last_30m / volume_first_30m ≥ minVolumeRatio
  // ────────────────────────────────────────────────────────────────────────────

  /** Gate env intraday. Opt-in (default false) — activer via OVERSOLD_INTRADAY_ENABLED=true. */
  private intradayEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_INTRADAY_ENABLED') ?? 'false').toLowerCase() === 'true';
  }

  private intradayConfig(): IntradayReboundConfig {
    const num = (key: string, dflt: number) => {
      const v = Number(this.config.get<string>(key));
      return Number.isFinite(v) ? v : dflt;
    };
    return {
      minReboundPct: num('OVERSOLD_INTRADAY_MIN_REBOUND_PCT', DEFAULT_INTRADAY_REBOUND_CONFIG.minReboundPct),
      minTrend15mPct: num('OVERSOLD_INTRADAY_MIN_TREND_15M_PCT', DEFAULT_INTRADAY_REBOUND_CONFIG.minTrend15mPct),
      bottomMustBeBeforeLastNBars: num('OVERSOLD_INTRADAY_BOTTOM_BEFORE_BARS', DEFAULT_INTRADAY_REBOUND_CONFIG.bottomMustBeBeforeLastNBars),
      minVolumeRatio: num('OVERSOLD_INTRADAY_MIN_VOLUME_RATIO', DEFAULT_INTRADAY_REBOUND_CONFIG.minVolumeRatio),
      minBarsRequired: num('OVERSOLD_INTRADAY_MIN_BARS_REQUIRED', DEFAULT_INTRADAY_REBOUND_CONFIG.minBarsRequired),
    };
  }

  private intradayMaxOpensPerDay(): number {
    const v = Number(this.config.get<string>('OVERSOLD_INTRADAY_MAX_OPENS_PER_DAY'));
    return Number.isFinite(v) && v > 0 ? v : 8;
  }

  private intradayNotionalRatio(): number {
    const v = Number(this.config.get<string>('OVERSOLD_INTRADAY_NOTIONAL_RATIO'));
    return Number.isFinite(v) && v > 0 && v <= 2 ? v : 0.7;
  }

  /**
   * Cron horaire pendant session US — 15:00 à 19:00 UTC, weekdays only.
   * Skip 14:30 (ouverture turbulente) et 20:00 (dernière heure, gamma/EOD prep).
   */
  @Cron('0 0 15,16,17,18,19 * * 1-5', { name: 'oversold-intraday-scan', timeZone: 'UTC' })
  async runIntradayScan(): Promise<void> {
    try {
      if (!this.isEnabled() || !this.intradayEnabled()) {
        this.logger.debug('[oversold-intraday] disabled (OVERSOLD_SCANNER_ENABLED or OVERSOLD_INTRADAY_ENABLED off)');
        return;
      }
      const portfolios = await this.loadOversoldPortfolios();
      if (portfolios.length === 0) {
        this.logger.debug('[oversold-intraday] aucun portfolio en mode oversold → skip');
        return;
      }
      for (const row of portfolios) {
        try {
          await this.scanPortfolioIntraday(row);
        } catch (err) {
          this.logger.error(
            `[oversold-intraday] portfolio ${row.portfolio_id.slice(0, 8)} échoué: ${String(err).slice(0, 300)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[oversold-intraday] runIntradayScan exception: ${String(err).slice(0, 300)}`);
    }
  }

  private async scanPortfolioIntraday(row: OversoldPortfolioRow): Promise<void> {
    const portfolioId = row.portfolio_id;
    const cfg = this.resolveConfig(row);
    const reboundCfg = this.intradayConfig();
    const maxOpensPerDay = this.intradayMaxOpensPerDay();
    const notionalRatio = this.intradayNotionalRatio();

    const tickers = await this.loadUniverse(cfg.universe);
    if (tickers.length === 0) return;

    // 1. Drop band filter (EOD reference)
    const openSymbols = await this.loadOpenSymbols(portfolioId);
    const barsBySymbol = await this.fetchUniverseBars(tickers);
    const candidates = buildOversoldCandidates(barsBySymbol, cfg);
    const toScan = selectOversoldOpens(candidates, openSymbols);

    // 2. Compteur intraday du jour pour respecter le cap
    const intradayOpenedToday = await this.countIntradayOpenedToday(portfolioId);
    let remaining = Math.max(0, maxOpensPerDay - intradayOpenedToday);
    if (remaining === 0) {
      this.logger.log(
        `[oversold-intraday] ${portfolioId.slice(0, 8)} cap reached (${intradayOpenedToday}/${maxOpensPerDay}) → skip`,
      );
      return;
    }

    // 3. Pour chaque candidat dans la bande : fetch candles + filtre rebond
    let evaluated = 0;
    let opened = 0;
    let rejectedRebound = 0;
    const reboundCfgForOpens: OversoldConfig = {
      ...cfg,
      positionNotionalUsd: Math.round(cfg.positionNotionalUsd * notionalRatio),
    };

    for (const cand of toScan) {
      if (remaining <= 0) break;
      evaluated++;
      try {
        const series = await this.intraday
          .getCandles(cand.symbol, '5m', 18, { calledBy: 'oversold_intraday' })
          .catch(() => null);
        const raw = series?.candles ?? [];
        if (raw.length < reboundCfg.minBarsRequired) {
          rejectedRebound++;
          continue;
        }
        const analysis = analyzeIntradayRebound(
          raw.map((c) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume })),
          reboundCfg,
        );
        if (!analysis) {
          rejectedRebound++;
          continue;
        }
        const gate = passesIntradayReboundFilter(analysis, reboundCfg);
        if (!gate.pass) {
          rejectedRebound++;
          continue;
        }

        // Open avec source intraday (distincte de scanner_oversold EOD)
        await this.openIntradayPosition(portfolioId, cand, reboundCfgForOpens, analysis.currentPrice);
        opened++;
        remaining--;
      } catch (err) {
        this.logger.warn(
          `[oversold-intraday] ${cand.symbol} évaluation échouée: ${String(err).slice(0, 160)}`,
        );
      }
    }

    await this.decisionLog
      .append({
        portfolioId,
        kind: 'oversold_intraday_scan_completed',
        summary: `Intraday scan: ${tickers.length} univers → ${candidates.length} bande → ${evaluated} évalués → ${opened} ouverts`,
        rationale:
          `Drop band [${cfg.dropMinPct}%, ${cfg.dropMaxPct}%], rebound ≥${reboundCfg.minReboundPct}%, ` +
          `trend15m ≥${reboundCfg.minTrend15mPct}%, bottom-before-${reboundCfg.bottomMustBeBeforeLastNBars}bars, ` +
          `volRatio ≥${reboundCfg.minVolumeRatio}, cap ${maxOpensPerDay}/j (used ${intradayOpenedToday + opened}).`,
        payload: {
          universe: cfg.universe,
          universe_size: tickers.length,
          drop_band_candidates: candidates.length,
          evaluated,
          opened,
          rejected_rebound: rejectedRebound,
          intraday_opened_today: intradayOpenedToday + opened,
          notional_ratio: notionalRatio,
        },
        triggeredBy: 'autopilot_cron',
        watchlistSource: 'mechanical',
        market: 'us_equity',
      })
      .catch((e) => this.logger.warn(`[oversold-intraday] decision_log append failed: ${String(e).slice(0, 160)}`));

    this.logger.log(
      `[oversold-intraday] portfolio=${portfolioId.slice(0, 8)} bande=${candidates.length} ` +
        `évalués=${evaluated} ouverts=${opened} (cap ${maxOpensPerDay}, used ${intradayOpenedToday + opened})`,
    );
  }

  /** Compte les positions ouvertes par le scanner intraday aujourd'hui UTC. */
  private async countIntradayOpenedToday(portfolioId: string): Promise<number> {
    const todayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const { count } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold_intraday')
      .gte('entry_timestamp', todayStart);
    return count ?? 0;
  }

  private async openIntradayPosition(
    portfolioId: string,
    cand: OversoldCandidate,
    cfg: OversoldConfig,
    livePrice: number,
  ): Promise<void> {
    // Le SL/TP utilisent le prix LIVE (pas closeJ) puisqu'on entre intraday.
    const stopLossPrice = String(livePrice * (1 + cfg.stopCatastrophePct / 100));
    const takeProfitPrice = cfg.tpPct != null ? String(livePrice * (1 + cfg.tpPct / 100)) : null;

    await this.lisa.getPaperBroker().openPositionDirect({
      portfolioId,
      symbol: cand.symbol,
      assetClass: 'us_equity',
      direction: 'long',
      venue: 'US',
      capitalAllocationUsd: String(cfg.positionNotionalUsd),
      livePrice: String(livePrice),
      livePriceSource: 'intraday_5m',
      stopLossPrice,
      takeProfitPrice,
      horizonDays: cfg.holdDays,
      source: 'scanner_oversold_intraday',
      maxOpenPositions: cfg.maxOpenPositions,
    });
  }

  /** Charge le tableau de tickers d'une watchlist nommée. */
  private async loadUniverse(name: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('watchlist_universe')
      .select('tickers')
      .eq('name', name)
      .maybeSingle();
    if (error || !data) {
      this.logger.warn(`[oversold] watchlist_universe '${name}' fetch failed: ${error?.message ?? 'empty'}`);
      return [];
    }
    const tickers = (data.tickers as string[] | null) ?? [];
    return tickers.filter((t) => typeof t === 'string' && t.length > 0);
  }

  /** Symboles déjà ouverts (anti-doublon, toutes sources confondues). */
  private async loadOpenSymbols(portfolioId: string): Promise<Set<string>> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (error || !data) {
      this.logger.warn(`[oversold] load open symbols failed: ${error?.message ?? 'empty'}`);
      return new Set();
    }
    return new Set(data.map((r) => r.symbol as string));
  }

  /**
   * Synthèse du book oversold pour l'UI dédiée (endpoint GET /lisa/oversold-summary/:id).
   *
   * Valorise chaque position au DERNIER CLOSE EOD (pas en intraday live) : cohérent
   * avec un swing J+10, et évite le fetch live-price stale qui pollue les logs hors
   * heures US. EOD ne change qu'1×/jour → cache léger (TTL ci-dessous) suffisant.
   *
   * Filtre les positions sur venue_fee_detail->>source='scanner_oversold' (le broker
   * n'écrit pas la colonne `source`). Les stats réalisées sont elles aussi scopées
   * oversold → pas de mélange avec l'historique gainers de HIGH.
   */
  async getBookSummary(portfolioId: string): Promise<OversoldBookSummary> {
    const client = this.supabase.getClient();

    // 1. Config oversold du portfolio (defaults migration 0191 si NULL).
    const { data: cfg } = await client
      .from('lisa_session_configs')
      .select(
        'capital_usd, oversold_hold_days, oversold_stop_catastrophe_pct, oversold_drop_min_pct, oversold_drop_max_pct',
      )
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const holdDaysTarget = Number(cfg?.oversold_hold_days ?? DEFAULTS.holdDays);
    const stopCatastrophePct = Number(cfg?.oversold_stop_catastrophe_pct ?? DEFAULTS.stopCatastrophePct);
    const capitalUsd = Number(cfg?.capital_usd ?? 0);
    const dropBand = {
      min: Number(cfg?.oversold_drop_min_pct ?? DEFAULTS.dropMinPct),
      max: Number(cfg?.oversold_drop_max_pct ?? DEFAULTS.dropMaxPct),
    };

    // 2. Positions oversold OUVERTES de ce portfolio.
    const { data: openRows } = await client
      .from('lisa_positions')
      .select('symbol, entry_price, entry_notional_usd, quantity, entry_timestamp, stop_loss_price')
      .eq('portfolio_id', portfolioId)
      .eq('venue_fee_detail->>source', 'scanner_oversold')
      .eq('status', 'open');
    const open = (openRows ?? []) as Array<Record<string, unknown>>;

    // 3. Stats réalisées (closed oversold) — scopées source, pas de mélange gainers.
    const { data: closedRows } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .eq('venue_fee_detail->>source', 'scanner_oversold')
      .neq('status', 'open');
    const closed = (closedRows ?? []) as Array<{ realized_pnl_usd?: unknown }>;
    let realizedPnlUsd = 0;
    let realizedWins = 0;
    for (const r of closed) {
      const pnl = Number(r.realized_pnl_usd ?? 0);
      if (Number.isFinite(pnl)) {
        realizedPnlUsd += pnl;
        if (pnl > 0) realizedWins++;
      }
    }
    const realizedTrades = closed.length;
    const realizedWinRatePct = realizedTrades > 0 ? (realizedWins / realizedTrades) * 100 : null;

    // 4. Valorisation EOD des positions ouvertes (cache TTL 10 min).
    const symbols = Array.from(new Set(open.map((p) => String(p.symbol))));
    const barsBySymbol = await this.getBookBarsCached(symbols);

    const now = new Date();
    const positions: OversoldBookPosition[] = [];
    let deployedNotionalUsd = 0;
    let currentBookValueUsd = 0;
    let unrealizedPnlUsd = 0;

    for (const p of open) {
      const symbol = String(p.symbol);
      const entryPrice = Number(p.entry_price);
      const notionalUsd = Number(p.entry_notional_usd ?? 0);
      const qtyRaw = Number(p.quantity ?? 0);
      const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0
        ? qtyRaw
        : entryPrice > 0 ? notionalUsd / entryPrice : 0;
      const entryTs = String(p.entry_timestamp ?? '');
      const stopPrice = p.stop_loss_price != null ? Number(p.stop_loss_price) : entryPrice * (1 + stopCatastrophePct / 100);

      const bars = barsBySymbol.get(symbol) ?? [];
      const currentPrice = bars.length > 0 ? bars[bars.length - 1].close : null;

      // drop% à l'entrée : (entry / close de la barre AVANT la date d'entrée − 1).
      let dropPctAtEntry: number | null = null;
      if (entryTs && bars.length >= 2 && entryPrice > 0) {
        const entryDay = entryTs.slice(0, 10);
        const idx = bars.findIndex((b) => b.date === entryDay);
        if (idx >= 1) {
          const prevClose = bars[idx - 1].close;
          if (prevClose > 0) dropPctAtEntry = (entryPrice / prevClose - 1) * 100;
        }
      }

      const heldDays = entryTs ? businessDaysSince(entryTs, now) : 0;
      const daysRemaining = Math.max(0, holdDaysTarget - heldDays);

      const unrealizedPnlUsdPos = currentPrice != null ? quantity * (currentPrice - entryPrice) : null;
      const unrealizedPnlPctPos = currentPrice != null && entryPrice > 0 ? (currentPrice / entryPrice - 1) * 100 : null;
      const distToStopPct = currentPrice != null && stopPrice > 0 ? (currentPrice / stopPrice - 1) * 100 : null;

      deployedNotionalUsd += notionalUsd;
      if (currentPrice != null) {
        currentBookValueUsd += quantity * currentPrice;
        if (unrealizedPnlUsdPos != null) unrealizedPnlUsd += unrealizedPnlUsdPos;
      } else {
        // Pas de prix frais → on retient le notionnel d'entrée pour la valeur book.
        currentBookValueUsd += notionalUsd;
      }

      positions.push({
        symbol,
        entryPrice,
        currentPrice,
        quantity,
        notionalUsd,
        unrealizedPnlUsd: unrealizedPnlUsdPos,
        unrealizedPnlPct: unrealizedPnlPctPos,
        dropPctAtEntry,
        heldDays,
        daysRemaining,
        stopPrice,
        distToStopPct,
      });
    }

    // Tri : P&L latent croissant (les positions en souffrance d'abord).
    positions.sort((a, b) => (a.unrealizedPnlPct ?? 0) - (b.unrealizedPnlPct ?? 0));

    const unrealizedPnlPct = deployedNotionalUsd > 0 ? (unrealizedPnlUsd / deployedNotionalUsd) * 100 : 0;

    return {
      portfolioId,
      capitalUsd,
      openCount: open.length,
      deployedNotionalUsd,
      currentBookValueUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      realizedPnlUsd,
      realizedTrades,
      realizedWins,
      realizedWinRatePct,
      holdDaysTarget,
      stopCatastrophePct,
      dropBand,
      asOf: now.toISOString(),
      positions,
    };
  }

  /**
   * Cache EOD pour la valorisation du book (TTL 10 min). EOD ne change qu'1×/jour
   * donc un cache court évite de re-frapper EODHD à chaque poll UI (30s).
   */
  private bookBarsCache: { at: number; bars: Map<string, EodBar[]> } | null = null;
  private async getBookBarsCached(symbols: string[]): Promise<Map<string, EodBar[]>> {
    const TTL_MS = 10 * 60 * 1000;
    const cached = this.bookBarsCache;
    if (cached && Date.now() - cached.at < TTL_MS && symbols.every((s) => cached.bars.has(s))) {
      return cached.bars;
    }
    const bars = symbols.length > 0 ? await this.fetchUniverseBars(symbols) : new Map<string, EodBar[]>();
    this.bookBarsCache = { at: Date.now(), bars };
    return bars;
  }

  /**
   * Fetch les barres EOD (~5 derniers jours) de tous les tickers, avec cap
   * concurrence FETCH_CONCURRENCY. Retourne une Map symbol → bars triées par date.
   */
  private async fetchUniverseBars(tickers: string[]): Promise<Map<string, EodBar[]>> {
    const result = new Map<string, EodBar[]>();
    const queue = [...tickers];

    const worker = async (): Promise<void> => {
      for (;;) {
        const symbol = queue.shift();
        if (symbol === undefined) return;
        try {
          const bars = await this.fetchEodBars(symbol);
          if (bars.length > 0) result.set(symbol, bars);
        } catch {
          // skip silencieux : un symbole 404 / timeout ne bloque pas le scan.
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.FETCH_CONCURRENCY, tickers.length) }, () => worker());
    await Promise.all(workers);
    return result;
  }

  /**
   * Fetch direct EODHD EOD sur la fenêtre des ~5 derniers jours pour 1 symbole.
   * 1 call EOD = 1 quota. La clé n'est JAMAIS loggée.
   */
  private async fetchEodBars(symbol: string): Promise<EodBar[]> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return [];

    const to = new Date();
    const from = new Date(to.getTime() - 8 * 86_400_000); // 8 jours calendaires ⊇ 5 jours ouvrés
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const url =
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
      `?from=${fromStr}&to=${toStr}&api_token=${apiKey}&fmt=json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];
      const json = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(json)) return [];
      const bars: EodBar[] = json
        .map((b) => ({
          date: String(b.date ?? ''),
          close: Number(b.close ?? b.adjusted_close ?? NaN),
          volume: Number(b.volume ?? 0),
        }))
        .filter((b) => b.date.length > 0 && Number.isFinite(b.close) && b.close > 0);
      // Tri chronologique croissant (EODHD renvoie déjà ainsi, mais on garantit).
      bars.sort((a, b) => a.date.localeCompare(b.date));
      return bars;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ouvre une position oversold via paperBroker.openPositionDirect.
   * Entry = close[J] (dernier prix EOD dispo, cohérent avec le backtest).
   */
  private async openOversoldPosition(
    portfolioId: string,
    cand: OversoldCandidate,
    cfg: OversoldConfig,
  ): Promise<void> {
    const closeJ = cand.closeJ;
    const stopLossPrice = String(closeJ * (1 + cfg.stopCatastrophePct / 100));
    const takeProfitPrice = cfg.tpPct != null ? String(closeJ * (1 + cfg.tpPct / 100)) : null;

    await this.lisa.getPaperBroker().openPositionDirect({
      portfolioId,
      symbol: cand.symbol,
      assetClass: 'us_equity',
      direction: 'long',
      venue: 'US',
      capitalAllocationUsd: String(cfg.positionNotionalUsd),
      livePrice: String(closeJ),
      livePriceSource: 'eodhd_eod',
      stopLossPrice,
      takeProfitPrice,
      horizonDays: cfg.holdDays,
      source: 'scanner_oversold',
      maxOpenPositions: cfg.maxOpenPositions,
    });
  }

  /**
   * 05/06/2026 — OVERNIGHT PROTECTION (option A + nuance user-validated).
   * Cron 20:45 UTC weekdays (15min avant NYSE close 21:00).
   * Pour chaque position oversold US open :
   *   - PnL >= -OVERSOLD_TOLERABLE_LOSS_PCT (default 3%) → force close
   *   - PnL < seuil → enter EXTENDED mode (deadline J+OVERSOLD_EXTENDED_DEADLINE_DAYS)
   * Évite les "claques overnight" comme celle observée 04/06 → 05/06 (-$418).
   * Opt-in via OVERSOLD_FORCE_CLOSE_ENABLED=true.
   */
  @Cron('0 45 20 * * 1-5', { name: 'oversold-overnight-protection', timeZone: 'UTC' })
  async runOvernightProtection(): Promise<void> {
    try {
      if (!this.isEnabled()) return;
      const enabled = (this.config.get<string>('OVERSOLD_FORCE_CLOSE_ENABLED') ?? 'false').toLowerCase() === 'true';
      if (!enabled) {
        this.logger.debug('[oversold-overnight] OVERSOLD_FORCE_CLOSE_ENABLED=false → skip');
        return;
      }
      const tolerableLossPct = parseFloat(this.config.get<string>('OVERSOLD_TOLERABLE_LOSS_PCT') ?? '3.0');
      const deadlineDays = parseInt(this.config.get<string>('OVERSOLD_EXTENDED_DEADLINE_DAYS') ?? '10', 10);

      const { data: positions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, portfolio_id, symbol, asset_class, entry_price, entry_notional_usd, source')
        .eq('status', 'open')
        .in('source', ['scanner_oversold', 'scanner_oversold_intraday'])
        .like('asset_class', 'us_%')
        .is('extended_deadline_at', null);

      if (!positions || positions.length === 0) {
        this.logger.log('[oversold-overnight] no eligible positions to protect');
        return;
      }

      let closedCount = 0;
      let extendedCount = 0;
      for (const pos of positions) {
        try {
          const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
          if (!quote || !quote.price) continue;
          const livePrice = Number(quote.price);
          const entryPrice = Number(pos.entry_price);
          if (!Number.isFinite(livePrice) || livePrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) continue;
          const pnlPct = ((livePrice - entryPrice) / entryPrice) * 100;

          if (pnlPct >= -tolerableLossPct) {
            try {
              await this.lisa.closeForOpportunityScout({
                positionId: pos.id,
                symbol: pos.symbol,
                livePrice,
                livePriceSource: quote.source,
                reason: 'closed_invalidated',
                rationale: `[OVERSOLD_OVERNIGHT] Force close 20:45 UTC (PnL ${pnlPct.toFixed(2)}% >= -${tolerableLossPct}% seuil)`,
              });
              closedCount++;
            } catch (e) {
              this.logger.warn(`[oversold-overnight] ${pos.symbol} close failed: ${String(e).slice(0, 100)}`);
            }
          } else {
            const deadlineAt = new Date(Date.now() + deadlineDays * 24 * 3600 * 1000).toISOString();
            try {
              await this.supabase.getClient()
                .from('lisa_positions')
                .update({
                  extended_deadline_at: deadlineAt,
                  extended_entered_at: new Date().toISOString(),
                  manual_control: true,
                })
                .eq('id', pos.id);
              await this.decisionLog.append({
                portfolioId: pos.portfolio_id,
                kind: 'oversold_extended_entered',
                summary: `[OVERSOLD_EXTENDED] ${pos.symbol} entered J+${deadlineDays} mode (PnL ${pnlPct.toFixed(2)}% < -${tolerableLossPct}%)`,
                rationale: `Position trop perdante pour force close à 20:45 UTC. Recovery monitor cherche window de close (breakeven < seuil, PnL positif, ou deadline ${deadlineAt}). manual_control activé pour bloquer SL/TP auto pendant extended.`,
                payload: { symbol: pos.symbol, pnl_pct: pnlPct, deadline_at: deadlineAt },
                triggeredBy: 'autopilot_cron',
              }).catch(() => null);
              extendedCount++;
            } catch (e) {
              this.logger.warn(`[oversold-overnight] ${pos.symbol} extended-set failed: ${String(e).slice(0, 100)}`);
            }
          }
        } catch (e) {
          this.logger.warn(`[oversold-overnight] ${pos.symbol} eval failed: ${String(e).slice(0, 150)}`);
        }
      }

      this.logger.log(`[oversold-overnight] processed ${positions.length} positions: ${closedCount} closed, ${extendedCount} extended`);
    } catch (err) {
      this.logger.error(`[oversold-overnight] cron crashed: ${String(err).slice(0, 300)}`);
    }
  }

  /**
   * 05/06/2026 — RECOVERY MONITOR pour positions OVERSOLD_EXTENDED.
   * Cron 1min : check chaque position en mode extended et close si :
   *   - PnL_usd >= -OVERSOLD_BREAKEVEN_THRESHOLD_USD (default $10) → breakeven approx
   *   - PnL_usd > 0 → rebond, lock dès que positif
   *   - now > extended_deadline_at → force close (deadline J+10)
   */
  @Cron('0 */1 * * * *', { name: 'oversold-recovery-monitor', timeZone: 'UTC' })
  async runRecoveryMonitor(): Promise<void> {
    try {
      if (!this.isEnabled()) return;
      const enabled = (this.config.get<string>('OVERSOLD_FORCE_CLOSE_ENABLED') ?? 'false').toLowerCase() === 'true';
      if (!enabled) return;

      const breakevenUsd = parseFloat(this.config.get<string>('OVERSOLD_BREAKEVEN_THRESHOLD_USD') ?? '10');

      const { data: positions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, portfolio_id, symbol, entry_price, entry_notional_usd, extended_deadline_at')
        .eq('status', 'open')
        .not('extended_deadline_at', 'is', null);

      if (!positions || positions.length === 0) return;

      const now = Date.now();
      for (const pos of positions) {
        try {
          const deadline = pos.extended_deadline_at ? new Date(pos.extended_deadline_at).getTime() : null;
          const quote = await this.lisa.getLivePrice(pos.symbol).catch(() => null);
          if (!quote || !quote.price) continue;
          const livePrice = Number(quote.price);
          const entryPrice = Number(pos.entry_price);
          if (!Number.isFinite(livePrice) || livePrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) continue;
          const pnlPct = ((livePrice - entryPrice) / entryPrice) * 100;
          const notional = Number(pos.entry_notional_usd ?? 0);
          const pnlUsd = (notional * pnlPct) / 100;

          let shouldClose = false;
          let reason = '';

          if (deadline && now > deadline) {
            shouldClose = true;
            reason = `[OVERSOLD_EXTENDED] deadline atteinte (PnL final ${pnlPct.toFixed(2)}% / $${pnlUsd.toFixed(2)})`;
          } else if (pnlUsd > 0) {
            shouldClose = true;
            reason = `[OVERSOLD_EXTENDED] PnL passé positif (+$${pnlUsd.toFixed(2)}) — lock`;
          } else if (pnlUsd >= -breakevenUsd) {
            shouldClose = true;
            reason = `[OVERSOLD_EXTENDED] breakeven approx (PnL $${pnlUsd.toFixed(2)} >= -$${breakevenUsd})`;
          }

          if (shouldClose) {
            try {
              await this.lisa.closeForOpportunityScout({
                positionId: pos.id,
                symbol: pos.symbol,
                livePrice,
                livePriceSource: quote.source,
                reason: 'closed_invalidated',
                rationale: reason,
              });
              await this.decisionLog.append({
                portfolioId: pos.portfolio_id,
                kind: 'oversold_extended_closed',
                summary: `[OVERSOLD_EXTENDED] ${pos.symbol} closed (PnL ${pnlPct.toFixed(2)}% / $${pnlUsd.toFixed(2)})`,
                rationale: reason,
                payload: {
                  symbol: pos.symbol,
                  pnl_pct: pnlPct,
                  pnl_usd: pnlUsd,
                  deadline_reached: !!(deadline && now > deadline),
                },
                triggeredBy: 'autopilot_cron',
              }).catch(() => null);
            } catch (e) {
              this.logger.warn(`[oversold-recovery] ${pos.symbol} close failed: ${String(e).slice(0, 100)}`);
            }
          }
        } catch (e) {
          this.logger.warn(`[oversold-recovery] ${pos.symbol} eval failed: ${String(e).slice(0, 150)}`);
        }
      }
    } catch (err) {
      this.logger.error(`[oversold-recovery] cron crashed: ${String(err).slice(0, 300)}`);
    }
  }
}
