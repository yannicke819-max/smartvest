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
  type OversoldConfig,
  type EodBar,
  type OversoldCandidate,
} from './oversold.helper';

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
}
