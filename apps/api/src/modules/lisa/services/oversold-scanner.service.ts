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
  decideRegimeBlock,
  computeRotationRegime,
  computeEntryFeatures,
  computeForwardOutcome,
  summarizeEntryNews,
  type OversoldConfig,
  type EodBar,
  type OversoldCandidate,
  type RotationRegime,
} from './oversold.helper';
import {
  analyzeIntradayRebound,
  passesIntradayReboundFilter,
  DEFAULT_INTRADAY_REBOUND_CONFIG,
  analyzeRealtimeRebound,
  passesRealtimeReboundFilter,
  DEFAULT_REALTIME_REBOUND_CONFIG,
  type IntradayReboundConfig,
  type RealtimeReboundConfig,
  type RealtimeOhlc,
} from './oversold-intraday.helper';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import { minutesSinceExchangeOpen, minutesToExchangeClose } from './exchange-sessions.helper';
import { computeOversoldNotional } from './oversold-sizing.helper';
import { computeExitHorizonShadow, type ExitHorizonRow } from './oversold-exit-horizon.helper';

/**
 * Contexte de régime marché capturé AS-OF l'entrée (PR-2 — features régime).
 * Indicateurs globaux de risque (VIX/VIX3M term structure + SPY 5j + crédit HYG).
 * Loggés dans features_at_entry pour que l'empirical law mesure — sur trades
 * RÉELS, sans biais de survivance — l'effet réel du régime sur l'outcome.
 */
interface OversoldRegimeCtx {
  vix: number | null;
  vix3mRatio: number | null; // VIX/VIX3M ; >1 = backwardation (stress aigu)
  spy5d: number | null; // rendement SPY 5j en %
  hyg5d: number | null; // rendement HYG 5j en % (proxy stress crédit)
}

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

/**
 * PR-2 UI — Statut de régime de marché LIVE pour le panel oversold dédié.
 * Reflète la décision du gate régime (checkRegimeGate) à l'instant T + le
 * prochain scan programmé. Région-aware (US : VIX+SPY ; EU : V2TX+SX5E).
 */
export interface OversoldRegimeStatus {
  portfolioId: string;
  universe: string;
  region: 'US' | 'EU';
  enabled: boolean; // gate régime actif (OVERSOLD_REGIME_GATE_ENABLED)
  block: boolean; // un scan ouvert MAINTENANT serait-il bloqué ?
  reason: string; // libellé human du verdict (ex: "VIX 21.5 > 17")
  vixLabel: string; // 'VIX' | 'V2TX'
  idxLabel: string; // 'SPY' | 'SX5E'
  vix: number | null;
  vixChgPct: number | null; // ΔVIX 1j en %
  idx5dPct: number | null; // rendement indice 5j en %
  vixSource: 'live' | 'eod';
  thresholds: { vixMax: number; vixDeltaMax: number; idx5dMin: number }; // effectifs (post-pénalité rotation)
  rotation: {
    regime: 'offensive' | 'defensive' | null;
    spreadPct: number | null;
    mode: string; // off | shadow | active
    appliedVixPenalty: number; // durcissement vixMax effectivement appliqué
  } | null;
  nextScanUtc: string; // ISO du prochain cron de scan
  nextScanKind: 'intraday' | 'daily';
  asOf: string;
}

/**
 * PR-2 (widget 3) — Veille news contraires sur une position oversold ouverte.
 * Lecture seule (visibilité), jamais un déclencheur d'exit.
 */
export interface OversoldNewsAlert {
  symbol: string;
  articleCount: number; // articles dans la fenêtre
  minSentiment: number; // polarité la plus négative [-1..1]
  latestTitle: string | null;
  latestUrl: string | null;
  latestAgeHours: number | null;
  level: 'shock' | 'watch'; // ≤ -0.6 (shock, réf checkNewsShockClose) / ≤ -0.3 (veille)
}

export interface OversoldNewsWatch {
  portfolioId: string;
  openPositions: number; // nb positions oversold ouvertes (dénominateur)
  windowHours: number;
  alerts: OversoldNewsAlert[]; // uniquement les positions à sentiment contraire, plus négatif d'abord
  asOf: string;
}

/**
 * PR-2 (widget loi empirique) — un bucket de la loi empirique oversold,
 * segmenté par bande de drop 1j à l'entrée.
 */
export interface OversoldLawBucket {
  label: string; // ex: "-10 à -8%"
  n: number;
  wins: number;
  winRatePct: number | null;
  avgPct: number | null; // PnL réalisé moyen, ou rendement J+10 moyen selon la loi
  ciLowPct: number | null; // borne basse Wilson 95% (sur le winRate)
  ciHighPct: number | null;
}

export interface OversoldLawTable {
  sampleSize: number;
  overallWinRatePct: number | null;
  overallAvgPct: number | null;
  byDropBand: OversoldLawBucket[];
}

export interface OversoldEmpiricalLaw {
  portfolioId: string;
  realized: OversoldLawTable; // pnl_pct des trades clôturés (entrée+sortie mêlées)
  forwardJ10: OversoldLawTable & { horizonDays: number }; // rendement J+10 (qualité d'entrée isolée) — se peuple ~18/06
  asOf: string;
}

/** Row config oversold lue depuis lisa_session_configs. */
interface OversoldPortfolioRow {
  portfolio_id: string;
  capital_usd: number | string | null;
  oversold_drop_min_pct: number | string | null;
  oversold_drop_max_pct: number | string | null;
  oversold_hold_days: number | null;
  oversold_stop_catastrophe_pct: number | string | null;
  oversold_tp_pct: number | string | null;
  oversold_position_notional_usd: number | string | null;
  oversold_max_open_positions: number | null;
  oversold_universe: string | null;
  oversold_size_dynamic_enabled: boolean | null;
  oversold_size_base_pct_capital: number | string | null;
  oversold_size_band_mult_deep: number | string | null;
  oversold_size_band_mult_shallow: number | string | null;
  oversold_size_vix_damp_elevated: number | string | null;
  oversold_size_vix_damp_stress: number | string | null;
  oversold_size_floor_usd: number | string | null;
  oversold_size_ceiling_pct_capital: number | string | null;
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
   * Cron 21:15 UTC, LUN-VEN uniquement (06/06). Le scan EOD agit sur la dernière
   * barre de clôture, qui ne se met à jour qu'après une vraie séance. Sam+dim =
   * marchés fermés → barre = vendredi (stale) → 0 nouvelle opportunité + burst
   * EODHD inutile sur tout l'univers. Vendredi (jour 5) reste inclus : les chutes
   * du vendredi sont achetées et tenues le weekend (hold J+10, weekends exclus).
   * Format crontab nestjs (6 champs) : sec min hour day month weekday.
   */
  @Cron('0 15 21 * * 1-5', { name: 'oversold-daily-scan', timeZone: 'UTC' })
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
        'portfolio_id, capital_usd, oversold_drop_min_pct, oversold_drop_max_pct, oversold_hold_days, ' +
          'oversold_stop_catastrophe_pct, oversold_tp_pct, oversold_position_notional_usd, ' +
          'oversold_max_open_positions, oversold_universe, ' +
          'oversold_size_dynamic_enabled, oversold_size_base_pct_capital, oversold_size_band_mult_deep, oversold_size_band_mult_shallow, ' +
          'oversold_size_vix_damp_elevated, oversold_size_vix_damp_stress, oversold_size_floor_usd, ' +
          'oversold_size_ceiling_pct_capital',
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
      capitalUsd: num(row.capital_usd, 10000),
      sizing: {
        enabled: row.oversold_size_dynamic_enabled, // null → helper retombe sur env/défaut
        basePctCapital: numOrNull(row.oversold_size_base_pct_capital), // base = capital × % (auto-scale)
        bandMultDeep: numOrNull(row.oversold_size_band_mult_deep),
        bandMultShallow: numOrNull(row.oversold_size_band_mult_shallow),
        vixDampElevated: numOrNull(row.oversold_size_vix_damp_elevated),
        vixDampStress: numOrNull(row.oversold_size_vix_damp_stress),
        floorUsd: numOrNull(row.oversold_size_floor_usd),
        ceilingPctCapital: numOrNull(row.oversold_size_ceiling_pct_capital),
      },
    };
  }

  /** Scan + ouverture pour un portfolio. */
  private async scanPortfolio(row: OversoldPortfolioRow): Promise<void> {
    const cfg = this.resolveConfig(row);
    const portfolioId = row.portfolio_id;

    // Gate régime macro région-aware — VIX+SPY (US) ou V2TX+SX5E (EU).
    // US calibration 04/06 vs 05/06 :
    //   04/06 (VIX=15.40, SPY 5d=+0.33%) → 48 positions, 35W/2L, +$761.
    //   05/06 (VIX=17.14, SPY 5d=-1.09%) → 11 positions toutes rouges.
    // EU seuils initiaux V2TX>22, ΔV2TX>+10%, SX5E 5d<-1.5% (à backtester).
    const regime = await this.checkRegimeGate(cfg.universe);
    if (regime.block) {
      const vixLabel = regime.region === 'EU' ? 'V2TX' : 'VIX';
      const idxLabel = regime.region === 'EU' ? 'SX5E' : 'SPY';
      const market = regime.region === 'EU' ? 'eu_equity' : 'us_equity';
      await this.decisionLog
        .append({
          portfolioId,
          kind: 'oversold_scan_blocked_regime',
          summary: `Oversold scan bloqué (régime ${regime.region} hostile): ${regime.reason}`,
          rationale: `${vixLabel}=${regime.vix?.toFixed(2) ?? 'n/a'} (Δ1d ${regime.vixChg?.toFixed(1) ?? 'n/a'}%), ${idxLabel} 5d=${regime.idx5d?.toFixed(2) ?? 'n/a'}%`,
          payload: {
            region: regime.region,
            universe: cfg.universe,
            vix: regime.vix,
            vix_chg_pct: regime.vixChg,
            idx_5d_pct: regime.idx5d,
            vix_source: regime.vixSource,
            reason: regime.reason,
            thresholds: regime.thresholds,
          },
          triggeredBy: 'autopilot_cron',
          watchlistSource: 'mechanical',
          market,
        })
        .catch((e) => this.logger.warn(`[oversold] decision_log append failed: ${String(e).slice(0, 160)}`));
      this.logger.log(
        `[oversold] portfolio=${portfolioId.slice(0, 8)} universe=${cfg.universe} region=${regime.region} BLOCKED: ${regime.reason}`,
      );
      return;
    }

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

    // Sector cap — max N positions ouvertes par GICS sector simultané.
    // DÉFAUT OFF : le backtest 04/06 montre que cap=5 aurait bloqué 29/48 positions
    // (Tech 30 dominant). À activer via secret OVERSOLD_SECTOR_CAP_ENABLED=true
    // uniquement quand on aura calibré le seuil sur N >= 100 jours.
    // Pré-charge les sectors des positions DÉJÀ ouvertes pour amorcer le compteur.
    const sectorCapEnabled =
      (this.config.get<string>('OVERSOLD_SECTOR_CAP_ENABLED') ?? 'false').toLowerCase() === 'true';
    const sectorCap = parseInt(this.config.get<string>('OVERSOLD_SECTOR_CAP') ?? '5', 10);
    const sectorCounts = new Map<string, number>();
    if (sectorCapEnabled && openSymbols.size > 0) {
      for (const s of openSymbols) {
        const sec = await this.loadSectorFor(s);
        sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
      }
    }

    let opened = 0;
    let skippedSector = 0;
    const errors: string[] = [];
    for (const cand of toOpen) {
      if (sectorCapEnabled) {
        const sec = await this.loadSectorFor(cand.symbol);
        const cur = sectorCounts.get(sec) ?? 0;
        if (cur >= sectorCap) {
          skippedSector++;
          continue;
        }
        sectorCounts.set(sec, cur + 1);
      }
      try {
        await this.openOversoldPosition(portfolioId, cand, cfg, regime.vix);
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
          skipped_sector_cap: skippedSector,
          sector_cap_enabled: sectorCapEnabled,
          sector_cap: sectorCap,
          regime: { region: regime.region, vix: regime.vix, vix_chg_pct: regime.vixChg, idx_5d_pct: regime.idx5d },
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

  /** Config du chemin real-time OHLC (EU). Seuils réglables sans redeploy. */
  private realtimeReboundConfig(): RealtimeReboundConfig {
    const num = (key: string, dflt: number) => {
      const v = Number(this.config.get<string>(key));
      return Number.isFinite(v) ? v : dflt;
    };
    return {
      minReboundFromLowPct: num('OVERSOLD_INTRADAY_MIN_REBOUND_FROM_LOW_PCT', DEFAULT_REALTIME_REBOUND_CONFIG.minReboundFromLowPct),
      minRangePosPct: num('OVERSOLD_INTRADAY_MIN_RANGE_POS_PCT', DEFAULT_REALTIME_REBOUND_CONFIG.minRangePosPct),
      requirePositiveDay:
        (this.config.get<string>('OVERSOLD_INTRADAY_REQUIRE_POSITIVE_DAY') ?? 'false').toLowerCase() === 'true',
    };
  }

  /**
   * Régions utilisant le chemin real-time OHLC au lieu des bougies 5m.
   * Default 'EU' (bougies intraday EU gelées — cf. analyzeRealtimeRebound).
   * 'US' garde les bougies TD (real-time OK). Réglable via
   * OVERSOLD_INTRADAY_RT_OHLC_REGIONS (CSV, ex 'EU,US' ou '' pour désactiver).
   */
  private useRealtimeOhlcPath(region: 'US' | 'EU'): boolean {
    const raw = this.config.get<string>('OVERSOLD_INTRADAY_RT_OHLC_REGIONS') ?? 'EU';
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .includes(region);
  }

  /**
   * OHLC du jour via EODHD real-time (frais pour l'EU, contrairement à
   * l'intraday 5m gelé). Retourne null si indispo / incohérent.
   */
  private async fetchRealtimeOhlc(symbol: string): Promise<RealtimeOhlc | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return null;
    const url = `https://eodhd.com/api/real-time/${encodeURIComponent(symbol)}?api_token=${apiKey}&fmt=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const open = Number(j.open);
      const high = Number(j.high);
      const low = Number(j.low);
      const close = Number(j.close);
      const prevClose = Number(j.previousClose);
      if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) return null;
      return { open, high, low, close, prevClose: Number.isFinite(prevClose) ? prevClose : close };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
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
   * Plafond anti-chase : % MAX de hausse vs le close de drop (closeJ) à l'entrée.
   * Un candidat déjà trop au-dessus de son close de drop a « rebondi trop loin »
   * — il a plus que récupéré sa chute → ce n'est plus un dip mean-reversion mais
   * du chasing du sommet. Default 10% (conservateur : ne coupe que les cas
   * extrêmes type INTC +12.7% du 08/06, garde les rebonds modérés +3-7%). 0 ou
   * négatif = désactivé. Unifié EU (real-time OHLC) + US (bougies).
   */
  private intradayMaxDayChangePct(): number {
    const v = Number(this.config.get<string>('OVERSOLD_INTRADAY_MAX_DAY_CHANGE_PCT'));
    return Number.isFinite(v) ? v : 10;
  }

  /**
   * Cadence effective du scan intraday en minutes (default 15, clamp 5..60).
   * Le cron tire toutes les 5 min (base) ; ce gate throttle à la cadence
   * configurée pour que l'utilisateur la règle sans redeploy via
   * OVERSOLD_INTRADAY_CADENCE_MIN.
   *
   * Diagnostic 08/06 (logging per-candidat) : les pépites (SOI +5.9%, ADYEN
   * +2.4%, IFX +1.9%) confirmaient leur rebond ENTRE deux scans horaires —
   * elles ressemblaient à des falling-knives au scan de 11:00 (trend15m négatif,
   * rebond < 1%), correctement rejetées à cet instant, puis rebondies avant le
   * scan de 12:00. 15 min les rattrape quand le rebond se confirme, SANS toucher
   * au seuil rebond (les 2 near-miss NEL/ETL à ~1.4% ont fadé → baisser le seuil
   * aurait ouvert des losers).
   */
  private intradayCadenceMin(): number {
    const v = Number(this.config.get<string>('OVERSOLD_INTRADAY_CADENCE_MIN'));
    if (!Number.isFinite(v) || v <= 0) return 15;
    return Math.min(60, Math.max(5, v));
  }

  /** Horodatage du dernier cycle intraday réellement exécuté (gate cadence). */
  private lastIntradayCycleAt = 0;

  /**
   * Cron base 5 min couvrant les séances EU + US (08:00-20:00 UTC, weekdays).
   * La cadence EFFECTIVE est throttlée par intradayCadenceMin() (default 15 min,
   * réglable via OVERSOLD_INTRADAY_CADENCE_MIN sans redeploy). Le créneau réel
   * par portfolio est borné DST-aware à [ouverture +1h, clôture -1h] de SA
   * bourse (cf. scanPortfolioIntraday) — MÊME logique US et EU : on saute la
   * 1ère heure (ouverture turbulente) et la dernière heure (EOD prep). Un cron
   * UTC fixe ne suffisait pas pour l'EU dont la séance décale d'1h été/hiver
   * (07:00-15:30 vs 08:00-16:30 UTC). Les gardes marché-fermé skippent les
   * fetchs hors-séance, et le gate cadence skippe AVANT tout fetch → élargir le
   * cron ne gaspille aucun appel EODHD.
   */
  @Cron('0 */5 8-20 * * 1-5', { name: 'oversold-intraday-scan', timeZone: 'UTC' })
  async runIntradayScan(opts?: { force?: boolean }): Promise<void> {
    try {
      if (!this.isEnabled() || !this.intradayEnabled()) {
        this.logger.debug('[oversold-intraday] disabled (OVERSOLD_SCANNER_ENABLED or OVERSOLD_INTRADAY_ENABLED off)');
        return;
      }

      // Gate cadence : throttle la base 5 min à la cadence configurée (default
      // 15 min). Le -30s absorbe la dérive de tick du cron (évite de sauter une
      // fenêtre quand l'écart retombe à 14min59 au lieu de 15min pile).
      // opts.force (bouton UI "forcer le scan") bypass la cadence — déclenchement
      // manuel délibéré.
      const cadenceMin = this.intradayCadenceMin();
      const elapsedMs = Date.now() - this.lastIntradayCycleAt;
      if (!opts?.force && elapsedMs < (cadenceMin * 60 - 30) * 1000) {
        this.logger.debug(
          `[oversold-intraday] cadence gate: ${Math.round(elapsedMs / 1000)}s < ${cadenceMin}min → skip`,
        );
        return;
      }
      if (opts?.force) {
        this.logger.log('[oversold-intraday] FORCE scan (bypass cadence) — déclenchement manuel');
      }
      this.lastIntradayCycleAt = Date.now();

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

    // Fenêtre intraday = [ouverture +1h, clôture -1h] de la bourse de l'univers,
    // DST-aware (même logique US et EU). On saute la 1ère heure (ouverture
    // turbulente) et la dernière heure (EOD prep). La séance EU décale d'1h
    // été/hiver → minutesSinceExchangeOpen/ToClose lisent l'horaire réel par
    // IANA TZ. refSym = bourse représentative (Euronext .PA pour l'EU, .US sinon).
    const nowWindow = new Date();
    const refSym = this.regionOfUniverse(cfg.universe) === 'EU' ? 'MC.PA' : 'AAPL.US';
    const sinceOpen = minutesSinceExchangeOpen(refSym, nowWindow);
    const toClose = minutesToExchangeClose(refSym, nowWindow);
    if (sinceOpen == null || sinceOpen < 60 || toClose == null || toClose < 60) {
      this.logger.debug(
        `[oversold-intraday] ${portfolioId.slice(0, 8)} ${cfg.universe} hors fenêtre [open+1h,close-1h] (sinceOpen=${sinceOpen ?? 'closed'} toClose=${toClose ?? 'closed'}) → skip`,
      );
      return;
    }

    const reboundCfg = this.intradayConfig();
    const maxOpensPerDay = this.intradayMaxOpensPerDay();
    const notionalRatio = this.intradayNotionalRatio();

    // Regime gate aussi appliqué à l'intraday (sinon le filet du daily 21:15
    // est contourné par les opens 15-19 UTC en plein régime hostile). En US,
    // le gate lit le VIX LIVE ici (intraday) au lieu du close EOD J-1.
    const regime = await this.checkRegimeGate(cfg.universe, { intraday: true });
    if (regime.block) {
      this.logger.log(
        `[oversold-intraday] portfolio=${portfolioId.slice(0, 8)} universe=${cfg.universe} region=${regime.region} BLOCKED: ${regime.reason}`,
      );
      await this.decisionLog
        .append({
          portfolioId,
          kind: 'oversold_scan_blocked_regime',
          summary: `Oversold intraday bloqué (régime ${regime.region}): ${regime.reason}`,
          rationale: `intraday cron ${new Date().toISOString().slice(11, 16)} UTC — ${regime.reason} (VIX ${regime.vixSource})`,
          payload: {
            phase: 'intraday',
            region: regime.region,
            universe: cfg.universe,
            vix: regime.vix,
            vix_chg_pct: regime.vixChg,
            idx_5d_pct: regime.idx5d,
            vix_source: regime.vixSource,
            reason: regime.reason,
          },
          triggeredBy: 'autopilot_cron',
          watchlistSource: 'mechanical',
          market: regime.region === 'EU' ? 'eu_equity' : 'us_equity',
        })
        .catch((e) => this.logger.warn(`[oversold-intraday] decision_log failed: ${String(e).slice(0, 160)}`));
      return;
    }

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
    // Intraday = plus petit que daily (ratio 0.7). On réduit la base : le
    // notionnel fixe ET le % du capital (sinon le sizing en % ignorerait le ratio).
    const reboundCfgForOpens: OversoldConfig = {
      ...cfg,
      positionNotionalUsd: Math.round(cfg.positionNotionalUsd * notionalRatio),
      sizing: {
        ...cfg.sizing,
        basePctCapital:
          cfg.sizing.basePctCapital != null ? cfg.sizing.basePctCapital * notionalRatio : null,
      },
    };

    // Logging per-candidat (mission "gate qui rate les pépites") — capture POUR
    // CHAQUE candidat le verdict gate + les métriques, au lieu du seul compteur
    // agrégé `rejected_rebound`. Shadow append-only, jamais bloquant.
    const scanLog: Record<string, unknown>[] = [];
    const baseRecOf = (c: OversoldCandidate): Record<string, unknown> => ({
      portfolio_id: portfolioId,
      scan_phase: 'intraday',
      universe: cfg.universe,
      region: regime.region,
      symbol: c.symbol,
      drop_pct: Number.isFinite(c.dropPct) ? Number(c.dropPct.toFixed(3)) : null,
      close_j: Number.isFinite(c.closeJ) ? c.closeJ : null,
    });

    // Sélection du chemin d'analyse par région : EU → real-time OHLC (bougies
    // 5m intraday gelées sur vendredi, P19-staleness), US → bougies 5m TD
    // (real-time OK). Cf. useRealtimeOhlcPath / analyzeRealtimeRebound.
    const useRt = this.useRealtimeOhlcPath(regime.region);
    const rtCfg = this.realtimeReboundConfig();
    const maxDayChg = this.intradayMaxDayChangePct(); // plafond anti-chase (vs closeJ)

    for (const cand of toScan) {
      if (remaining <= 0) break;
      evaluated++;
      const base = baseRecOf(cand);
      try {
        if (useRt) {
          // ── Chemin REAL-TIME OHLC (EU) ──
          const ohlc = await this.fetchRealtimeOhlc(cand.symbol);
          if (!ohlc) {
            rejectedRebound++;
            scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'no_realtime', analysis_mode: 'realtime_ohlc' });
            continue;
          }
          const a = analyzeRealtimeRebound(ohlc);
          if (!a) {
            rejectedRebound++;
            scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'analysis_null', analysis_mode: 'realtime_ohlc' });
            continue;
          }
          const rtCols = {
            analysis_mode: 'realtime_ohlc',
            current_price: a.currentPrice,
            rebound_from_low_pct: Number(a.reboundFromLowPct.toFixed(3)),
            range_pos_pct: Number(a.rangePosPct.toFixed(3)),
            day_chg_pct: Number(a.dayChgPct.toFixed(3)),
          };
          const gate = passesRealtimeReboundFilter(a, rtCfg);
          if (!gate.pass) {
            rejectedRebound++;
            scanLog.push({ ...base, ...rtCols, outcome: 'rejected', reject_stage: 'rebound_filter', reject_reasons: gate.reasons });
            continue;
          }
          // Plafond anti-chase : déjà trop au-dessus du close de drop = sommet déjà joué.
          const dayChgEu = cand.closeJ > 0 ? ((a.currentPrice - cand.closeJ) / cand.closeJ) * 100 : 0;
          if (maxDayChg > 0 && dayChgEu > maxDayChg) {
            rejectedRebound++;
            scanLog.push({ ...base, ...rtCols, outcome: 'rejected', reject_stage: 'overextended', reject_reasons: [`dayChg=${dayChgEu.toFixed(2)}% > ${maxDayChg}% (rebond déjà consommé)`] });
            continue;
          }
          await this.openIntradayPosition(portfolioId, cand, reboundCfgForOpens, a.currentPrice, regime.vix);
          opened++;
          remaining--;
          scanLog.push({ ...base, ...rtCols, outcome: 'opened' });
          continue;
        }

        // ── Chemin BOUGIES 5m (US) ──
        const series = await this.intraday
          .getCandles(cand.symbol, '5m', 18, { calledBy: 'oversold_intraday' })
          .catch(() => null);
        const raw = series?.candles ?? [];
        if (raw.length === 0) {
          rejectedRebound++;
          scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'no_candles', analysis_mode: 'candles' });
          continue;
        }
        if (raw.length < reboundCfg.minBarsRequired) {
          rejectedRebound++;
          scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'insufficient_bars', bars_count: raw.length, analysis_mode: 'candles' });
          continue;
        }
        // Garde anti-bougies PÉRIMÉES : sur les titres thin / ADR mal couverts
        // par TD, la dernière bougie peut dater de la veille → entrée sur signal
        // périmé à un prix figé (bug KXIAY 08/06 : entré à 44.75 = close veille
        // alors que le titre était réellement +5.8%). On skippe si la dernière
        // bougie est trop vieille (default 30 min, réglable).
        const lastTsRaw = Number(raw[raw.length - 1]?.timestamp ?? 0);
        const lastTsSec = lastTsRaw > 1e11 ? lastTsRaw / 1000 : lastTsRaw;
        const candleAgeMin = lastTsSec > 0 ? (Date.now() / 1000 - lastTsSec) / 60 : Number.POSITIVE_INFINITY;
        const staleMaxMin = Number(this.config.get<string>('OVERSOLD_INTRADAY_STALE_CANDLE_MAX_MIN') ?? '30');
        if (candleAgeMin > staleMaxMin) {
          rejectedRebound++;
          scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'stale_candles', bars_count: raw.length, analysis_mode: 'candles' });
          this.logger.debug(`[oversold-intraday] ${cand.symbol} bougies périmées (dernière ${candleAgeMin.toFixed(0)}min) → skip`);
          continue;
        }
        const analysis = analyzeIntradayRebound(
          raw.map((c) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume })),
          reboundCfg,
        );
        if (!analysis) {
          rejectedRebound++;
          scanLog.push({ ...base, outcome: 'rejected', reject_stage: 'analysis_null', bars_count: raw.length, analysis_mode: 'candles' });
          continue;
        }
        const metricCols = {
          analysis_mode: 'candles',
          current_price: analysis.currentPrice,
          rebound_pct: Number(analysis.reboundPct.toFixed(3)),
          trend_15m_pct: Number(analysis.trend15mPct.toFixed(3)),
          volume_ratio: Number(analysis.volumeRatio.toFixed(3)),
          bottom_bar_idx: analysis.lowAtBarIdx,
          bars_count: analysis.barsCount,
        };
        const gate = passesIntradayReboundFilter(analysis, reboundCfg);
        if (!gate.pass) {
          rejectedRebound++;
          scanLog.push({ ...base, ...metricCols, outcome: 'rejected', reject_stage: 'rebound_filter', reject_reasons: gate.reasons });
          continue;
        }
        // Plafond anti-chase : déjà trop au-dessus du close de drop = sommet déjà joué.
        const dayChgUs = cand.closeJ > 0 ? ((analysis.currentPrice - cand.closeJ) / cand.closeJ) * 100 : 0;
        if (maxDayChg > 0 && dayChgUs > maxDayChg) {
          rejectedRebound++;
          scanLog.push({ ...base, ...metricCols, outcome: 'rejected', reject_stage: 'overextended', reject_reasons: [`dayChg=${dayChgUs.toFixed(2)}% > ${maxDayChg}% (rebond déjà consommé)`] });
          continue;
        }

        // Open avec source intraday (distincte de scanner_oversold EOD)
        await this.openIntradayPosition(portfolioId, cand, reboundCfgForOpens, analysis.currentPrice, regime.vix);
        opened++;
        remaining--;
        scanLog.push({ ...base, ...metricCols, outcome: 'opened' });
      } catch (err) {
        this.logger.warn(
          `[oversold-intraday] ${cand.symbol} évaluation échouée: ${String(err).slice(0, 160)}`,
        );
      }
    }

    // Persiste le log per-candidat (un seul INSERT batch, fire-and-forget).
    await this.persistScanLog(scanLog);

    await this.decisionLog
      .append({
        portfolioId,
        kind: 'oversold_intraday_scan_completed',
        summary: `Intraday scan: ${tickers.length} univers → ${candidates.length} bande → ${evaluated} évalués → ${opened} ouverts`,
        rationale: useRt
          ? `[real-time OHLC] Drop band [${cfg.dropMinPct}%, ${cfg.dropMaxPct}%], reboundFromLow ≥${rtCfg.minReboundFromLowPct}%, ` +
            `rangePos ≥${rtCfg.minRangePosPct}%${rtCfg.requirePositiveDay ? ', dayChg ≥0' : ''}, ` +
            `cap ${maxOpensPerDay}/j (used ${intradayOpenedToday + opened}).`
          : `[candles 5m] Drop band [${cfg.dropMinPct}%, ${cfg.dropMaxPct}%], rebound ≥${reboundCfg.minReboundPct}%, ` +
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
          analysis_mode: useRt ? 'realtime_ohlc' : 'candles',
        },
        triggeredBy: 'autopilot_cron',
        watchlistSource: 'mechanical',
        market: regime.region === 'EU' ? 'eu_equity' : 'us_equity',
      })
      .catch((e) => this.logger.warn(`[oversold-intraday] decision_log append failed: ${String(e).slice(0, 160)}`));

    this.logger.log(
      `[oversold-intraday] portfolio=${portfolioId.slice(0, 8)} bande=${candidates.length} ` +
        `évalués=${evaluated} ouverts=${opened} (cap ${maxOpensPerDay}, used ${intradayOpenedToday + opened})`,
    );
  }

  /** Gate du logging per-candidat (désactivable via secret, default on). */
  private scanRejectLogEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_SCAN_REJECT_LOG_ENABLED') ?? 'true').toLowerCase() === 'true';
  }

  /**
   * Persiste le log per-candidat du scan (table shadow oversold_scan_rejections).
   * Un seul INSERT batch par scan. Jamais bloquant : toute erreur est avalée en
   * debug (le scan ne doit jamais crasher pour un échec de logging d'audit).
   */
  private async persistScanLog(rows: Record<string, unknown>[]): Promise<void> {
    if (!this.scanRejectLogEnabled() || rows.length === 0) return;
    try {
      const { error } = await this.supabase
        .getClient()
        .from('oversold_scan_rejections')
        .insert(rows);
      if (error) {
        this.logger.debug(`[oversold-intraday] scan-reject log insert failed: ${error.message.slice(0, 160)}`);
      }
    } catch (e) {
      this.logger.debug(`[oversold-intraday] scan-reject log exception: ${String(e).slice(0, 120)}`);
    }
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
    vix: number | null = null,
  ): Promise<void> {
    // Le SL/TP utilisent le prix LIVE (pas closeJ) puisqu'on entre intraday.
    const stopLossPrice = String(livePrice * (1 + cfg.stopCatastrophePct / 100));
    const takeProfitPrice = cfg.tpPct != null ? String(livePrice * (1 + cfg.tpPct / 100)) : null;

    // Sizing dynamique (base = notionnel intraday déjà réduit par notionalRatio).
    const sizing = computeOversoldNotional({ baseNotionalUsd: cfg.positionNotionalUsd, dropPct: cand.dropPct, vix, capitalUsd: cfg.capitalUsd, config: cfg.sizing });
    if (sizing.dynamic) {
      this.logger.log(`[oversold-sizing:intraday] ${cand.symbol} drop=${cand.dropPct.toFixed(1)}% ${sizing.band} ×${sizing.bandMult}×vix${sizing.vixDamp} → $${sizing.notionalUsd}${sizing.clamp ? ` (${sizing.clamp})` : ''} (base $${cfg.positionNotionalUsd})`);
    }

    await this.lisa.getPaperBroker().openPositionDirect({
      portfolioId,
      symbol: cand.symbol,
      assetClass: 'us_equity',
      direction: 'long',
      venue: 'US',
      capitalAllocationUsd: String(sizing.notionalUsd),
      livePrice: String(livePrice),
      livePriceSource: 'intraday_5m',
      stopLossPrice,
      takeProfitPrice,
      horizonDays: cfg.holdDays,
      source: 'scanner_oversold_intraday',
      maxOpenPositions: cfg.maxOpenPositions,
    });
  }

  /**
   * Détermine la région macro à partir du nom d'univers.
   * - russell1000 / sp500 / nasdaq100 / mega12 → US (VIX + SPY)
   * - stoxx600 / cac40 / dax40                 → EU (V2TX + SX5E)
   * - autres → US par défaut (conservateur)
   */
  private regionOfUniverse(universe: string): 'US' | 'EU' {
    const eu = ['stoxx600', 'cac40', 'dax40'];
    return eu.includes(universe.toLowerCase()) ? 'EU' : 'US';
  }

  /**
   * Gate régime macro — région-aware.
   *
   * US (russell1000) : VIX + SPY. Calibration 04/06 vs 05/06 :
   *   VIX > 17 ; ΔVIX 1d > +10% ; SPY 5d < -1%
   *
   * EU (stoxx600) : V2TX (VSTOXX) + SX5E (Euro Stoxx 50). Seuils initiaux :
   *   V2TX > 22 ; ΔV2TX 1d > +10% ; SX5E 5d < -1.5%
   *
   * Désactivable via OVERSOLD_REGIME_GATE_ENABLED=false. Tous les seuils
   * sont individuellement tunables via secret env (cf. ci-dessous).
   */
  private async checkRegimeGate(
    universe: string,
    opts?: { intraday?: boolean },
  ): Promise<{
    block: boolean;
    reason: string;
    region: 'US' | 'EU';
    vix: number | null;
    vixChg: number | null;
    idx5d: number | null;
    vixSource: 'live' | 'eod';
    thresholds: { vixMax: number; vixDeltaMax: number; idx5dMin: number };
    rotation: (RotationRegime & { mode: string; appliedVixPenalty: number }) | null;
  }> {
    const enabled =
      (this.config.get<string>('OVERSOLD_REGIME_GATE_ENABLED') ?? 'true').toLowerCase() === 'true';
    const region = this.regionOfUniverse(universe);

    let vixSym: string;
    let idxSym: string;
    let vixMax: number;
    let vixDeltaMax: number;
    let idx5dMin: number;

    if (region === 'EU') {
      vixSym = 'V2TX.INDX';
      idxSym = 'SX5E.INDX';
      vixMax = parseFloat(this.config.get<string>('OVERSOLD_V2TX_MAX') ?? '22');
      vixDeltaMax = parseFloat(this.config.get<string>('OVERSOLD_V2TX_DELTA_MAX_PCT') ?? '10');
      idx5dMin = parseFloat(this.config.get<string>('OVERSOLD_SX5E_5D_MIN_PCT') ?? '-1.5');
    } else {
      vixSym = 'VIX.INDX';
      idxSym = 'SPY.US';
      vixMax = parseFloat(this.config.get<string>('OVERSOLD_VIX_MAX') ?? '17');
      vixDeltaMax = parseFloat(this.config.get<string>('OVERSOLD_VIX_DELTA_MAX_PCT') ?? '10');
      idx5dMin = parseFloat(this.config.get<string>('OVERSOLD_SPY_5D_MIN_PCT') ?? '-1');
    }
    const thresholds = { vixMax, vixDeltaMax, idx5dMin };

    if (!enabled) {
      return { block: false, reason: 'gate disabled', region, vix: null, vixChg: null, idx5d: null, vixSource: 'eod', thresholds, rotation: null };
    }

    const labels = { vix: region === 'EU' ? 'V2TX' : 'VIX', idx: region === 'EU' ? 'SX5E' : 'SPY' };

    // Intraday US : on lit le VIX LIVE (real-time EODHD) au lieu du close EOD
    // J-1. Sinon un spike intraday (ex 05/06 : VIX 15.40 → 21.51) n'est vu qu'au
    // scan EOD de 21:15, après que l'intraday ait pu ouvrir en plein régime
    // hostile. EODHD ne sert PAS le live des indices EU (V2TX/SX5E = "NA") →
    // l'EU reste sur EOD. Tout échec live → fallback EOD (jamais de bypass).
    const liveIntraday =
      opts?.intraday === true &&
      region === 'US' &&
      (this.config.get<string>('OVERSOLD_REGIME_GATE_INTRADAY_LIVE') ?? 'true').toLowerCase() === 'true';

    let vix: number | null = null;
    let vixChg: number | null = null;
    let vixSource: 'live' | 'eod' = 'eod';

    if (liveIntraday) {
      const q = await this.fetchLiveIndexQuote(vixSym).catch(() => null);
      if (q) {
        vix = q.live;
        vixChg = Number.isFinite(q.changePct) ? q.changePct : null;
        vixSource = 'live';
      }
    }

    // VIX EOD : seulement si le live n'a pas fourni (gate EOD, EU, ou échec live).
    // SPY/SX5E 5j : TOUJOURS EOD (signal lent, drift intraday négligeable).
    const needVixEod = vixSource === 'eod';
    const [vixBars, idxBars] = await Promise.all([
      needVixEod
        ? this.fetchEodBars(vixSym).catch(() => [] as EodBar[])
        : Promise.resolve([] as EodBar[]),
      this.fetchEodBars(idxSym).catch(() => [] as EodBar[]),
    ]);

    if (needVixEod && vixBars.length >= 2) {
      vix = vixBars[vixBars.length - 1].close;
      const prev = vixBars[vixBars.length - 2].close;
      vixChg = prev > 0 ? (vix / prev - 1) * 100 : null;
    }

    let idx5d: number | null = null;
    if (idxBars.length >= 6) {
      const last = idxBars[idxBars.length - 1].close;
      const fiveBack = idxBars[idxBars.length - 6].close;
      idx5d = fiveBack > 0 ? (last / fiveBack - 1) * 100 : null;
    }

    // PR #639 — Modulateur de rotation sectorielle (offensif/défensif), par région.
    // Quand la rotation est DÉFENSIVE (data 3 ans : %positif forward 20j en baisse
    // US 79→59% / EU 69→59%, vol future +35-90%), on DURCIT le seuil VIX/V2TX d'une
    // pénalité. Modulateur de PRUDENCE uniquement (signal modeste + biais bull) —
    // JAMAIS un assouplissement. Modes : off / shadow (log only) / active.
    // Default ACTIVE : modulateur qui ne fait que DURCIR le seuil → risque
    // asymétrique (au pire trop prudent, jamais plus exposé), et mesure backtest
    // 3 ans déjà disponible. Effet analysé en réel après ~1 semaine via les logs
    // [oversold-rotation:active]. Repli : OVERSOLD_ROTATION_GATE_MODE=off|shadow.
    // Fail-open : rotation indispo (null) → aucune modulation (gate inchangé).
    const rotMode = (this.config.get<string>('OVERSOLD_ROTATION_GATE_MODE') ?? 'active').toLowerCase();
    let effThresholds = thresholds;
    let rotation: (RotationRegime & { mode: string; appliedVixPenalty: number }) | null = null;
    if (rotMode !== 'off') {
      const rot = await this.fetchRotationRegime(region).catch(() => null);
      if (rot) {
        const penalty = parseFloat(this.config.get<string>('OVERSOLD_ROTATION_VIX_PENALTY') ?? '2');
        const wouldApply = rot.regime === 'defensive' && penalty > 0;
        const applied = wouldApply && rotMode === 'active';
        if (applied) {
          effThresholds = { ...thresholds, vixMax: thresholds.vixMax - penalty };
        }
        rotation = { ...rot, mode: rotMode, appliedVixPenalty: applied ? penalty : 0 };
        if (wouldApply) {
          this.logger.log(
            `[oversold-rotation:${rotMode}] ${region} régime=DÉFENSIF ratio=${rot.ratio?.toFixed(3)} ma50=${rot.ma?.toFixed(3)} (spread ${rot.spreadPct?.toFixed(1)}%) → ` +
              (applied
                ? `vixMax durci ${thresholds.vixMax}→${effThresholds.vixMax}`
                : `aurait durci vixMax ${thresholds.vixMax}→${thresholds.vixMax - penalty} (shadow, non appliqué)`),
          );
        }
      }
    }

    const decision = decideRegimeBlock({ vix, vixChg, idx5d }, effThresholds, labels);
    return { ...decision, region, vix, vixChg, idx5d, vixSource, thresholds: effThresholds, rotation };
  }

  // ─── PR #639 — Rotation sectorielle offensif/défensif (cache + fetch par région) ───
  private rotationCache = new Map<'US' | 'EU', { at: number; data: RotationRegime }>();
  private readonly ROTATION_TTL_MS = 60 * 60 * 1000; // EOD change 1×/jour → 1h suffit

  /** Paire offensif/défensif par région (override possible via env). */
  private rotationSymbols(region: 'US' | 'EU'): { off: string; def: string } {
    if (region === 'EU') {
      return {
        off: this.config.get<string>('OVERSOLD_ROTATION_EU_OFF') ?? 'EXV3.XETRA', // STOXX600 Tech
        def: this.config.get<string>('OVERSOLD_ROTATION_EU_DEF') ?? 'EXH3.XETRA', // STOXX600 Food&Bev
      };
    }
    return {
      off: this.config.get<string>('OVERSOLD_ROTATION_US_OFF') ?? 'SMH.US', // Semis/IA
      def: this.config.get<string>('OVERSOLD_ROTATION_US_DEF') ?? 'XLP.US', // Consumer staples
    };
  }

  /** Régime de rotation offensif/défensif de la région (cache 1h, fail-open). */
  private async fetchRotationRegime(region: 'US' | 'EU'): Promise<RotationRegime> {
    const cached = this.rotationCache.get(region);
    if (cached && Date.now() - cached.at < this.ROTATION_TTL_MS) return cached.data;
    const { off, def } = this.rotationSymbols(region);
    const [offBars, defBars] = await Promise.all([
      this.fetchEodBars(off, 80).catch(() => [] as EodBar[]), // ~80j calendaires ⊇ 55 ouvrés (MM50)
      this.fetchEodBars(def, 80).catch(() => [] as EodBar[]),
    ]);
    const data = computeRotationRegime(offBars, defBars, 50);
    this.rotationCache.set(region, { at: Date.now(), data });
    return data;
  }

  /**
   * Quote temps réel EODHD pour un indice/ETF (endpoint real-time).
   * Retourne { live, prevClose, changePct } ou null si indispo ("NA") / échec.
   *
   * Utilisé par le gate régime INTRADAY US (VIX live). EODHD ne sert PAS le live
   * des indices EU (V2TX/SX5E renvoient "NA" → Number("NA")=NaN → null), d'où le
   * fallback EOD côté caller.
   */
  private async fetchLiveIndexQuote(
    symbol: string,
  ): Promise<{ live: number; prevClose: number; changePct: number } | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return null;
    const url =
      `https://eodhd.com/api/real-time/${encodeURIComponent(symbol)}` +
      `?api_token=${apiKey}&fmt=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const live = Number(j.close);
      if (!Number.isFinite(live) || live <= 0) return null;
      const prevClose = Number(j.previousClose);
      const changePct = Number(j.change_p);
      return {
        live,
        prevClose: Number.isFinite(prevClose) ? prevClose : NaN,
        changePct: Number.isFinite(changePct) ? changePct : NaN,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cache de sector lookup via EODHD fundamentals (process lifetime).
   * Les `assets.sector` sont NULL pour la plupart des tickers russell1000 →
   * on bypass la DB pour aller direct au provider. 1 call/symbole en cold,
   * puis hit cache pour la durée du process Fly (~24h entre redeploys).
   */
  private readonly sectorCache = new Map<string, string>();

  private async loadSectorFor(symbol: string): Promise<string> {
    const cached = this.sectorCache.get(symbol);
    if (cached !== undefined) return cached;
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) {
      this.sectorCache.set(symbol, 'unknown');
      return 'unknown';
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
      const res = await fetch(
        `https://eodhd.com/api/fundamentals/${encodeURIComponent(symbol)}?api_token=${apiKey}&fmt=json`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (!res.ok) {
        this.sectorCache.set(symbol, 'unknown');
        return 'unknown';
      }
      const j = (await res.json()) as { General?: { Sector?: string; GicSector?: string } };
      const sec = j?.General?.Sector ?? j?.General?.GicSector ?? 'unknown';
      this.sectorCache.set(symbol, sec);
      return sec;
    } catch {
      this.sectorCache.set(symbol, 'unknown');
      return 'unknown';
    }
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

    // 2. Positions oversold OUVERTES de ce portfolio (daily + intraday).
    const { data: openRows } = await client
      .from('lisa_positions')
      .select('symbol, entry_price, entry_notional_usd, quantity, entry_timestamp, stop_loss_price')
      .eq('portfolio_id', portfolioId)
      .in('venue_fee_detail->>source', ['scanner_oversold', 'scanner_oversold_intraday'])
      .eq('status', 'open');
    const open = (openRows ?? []) as Array<Record<string, unknown>>;

    // 3. Stats réalisées (closed oversold) — scopées source, pas de mélange gainers.
    const { data: closedRows } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd')
      .eq('portfolio_id', portfolioId)
      .in('venue_fee_detail->>source', ['scanner_oversold', 'scanner_oversold_intraday'])
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
  private async fetchEodBars(symbol: string, calendarDays = 8): Promise<EodBar[]> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return [];

    const to = new Date();
    const from = new Date(to.getTime() - calendarDays * 86_400_000); // 8j ⊇ 5 ouvrés ; ~80j ⊇ 55 ouvrés (MM50)
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

  // ─── PR-2 — Contexte de régime as-of entrée (cache 6h, fail-open) ───
  private regimeCtxCache: { at: number; byDate: Map<string, OversoldRegimeCtx> } | null = null;
  private readonly REGIME_CTX_TTL_MS = 6 * 60 * 60 * 1000;

  /**
   * Charge VIX + VIX3M + SPY + HYG (1 fetch chacun, cache 6h) et construit une
   * map date → contexte régime. Fail-open : tout indicateur indispo → champ null,
   * jamais d'exception (la collecte de features ne doit pas casser dessus).
   */
  private async loadRegimeContext(): Promise<Map<string, OversoldRegimeCtx>> {
    if (this.regimeCtxCache && Date.now() - this.regimeCtxCache.at < this.REGIME_CTX_TTL_MS) {
      return this.regimeCtxCache.byDate;
    }
    const [vix, vix3m, spy, hyg] = await Promise.all([
      this.fetchEodBars('VIX.INDX', 220).catch(() => [] as EodBar[]),
      this.fetchEodBars('VIX3M.INDX', 220).catch(() => [] as EodBar[]),
      this.fetchEodBars('SPY.US', 220).catch(() => [] as EodBar[]),
      this.fetchEodBars('HYG.US', 220).catch(() => [] as EodBar[]),
    ]);
    const v3ByDate = new Map(vix3m.map((b) => [b.date, b.close]));
    const ret5 = (bars: EodBar[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (let i = 5; i < bars.length; i++) {
        const prev = bars[i - 5].close;
        if (prev > 0) m.set(bars[i].date, (bars[i].close / prev - 1) * 100);
      }
      return m;
    };
    const spy5 = ret5(spy);
    const hyg5 = ret5(hyg);
    const byDate = new Map<string, OversoldRegimeCtx>();
    for (const b of vix) {
      const v3 = v3ByDate.get(b.date);
      byDate.set(b.date, {
        vix: b.close,
        vix3mRatio: v3 && v3 > 0 ? b.close / v3 : null,
        spy5d: spy5.get(b.date) ?? null,
        hyg5d: hyg5.get(b.date) ?? null,
      });
    }
    this.regimeCtxCache = { at: Date.now(), byDate };
    return byDate;
  }

  /** Contexte régime à la date d'entrée (exacte, sinon dernière date <= entrée). */
  private regimeAsOf(byDate: Map<string, OversoldRegimeCtx>, date: string): OversoldRegimeCtx | null {
    const exact = byDate.get(date);
    if (exact) return exact;
    let best: string | null = null;
    for (const d of byDate.keys()) {
      if (d <= date && (best === null || d > best)) best = d;
    }
    return best ? byDate.get(best) ?? null : null;
  }

  /**
   * PR-2 UI — Statut régime LIVE pour le panel oversold dédié.
   *
   * Réutilise checkRegimeGate (région-aware, VIX live intraday US) pour exposer
   * au front la même décision que celle prise par le scan, plus le prochain
   * créneau de scan. Lecture seule, fail-soft : toute erreur indicateur →
   * champ null (le gate lui-même est fail-open côté scan).
   */
  async getRegimeStatus(portfolioId: string): Promise<OversoldRegimeStatus> {
    const { data: cfg } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('oversold_universe')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const universe = (cfg?.oversold_universe as string | null) ?? DEFAULTS.universe;

    const enabled =
      (this.config.get<string>('OVERSOLD_REGIME_GATE_ENABLED') ?? 'true').toLowerCase() === 'true';

    // intraday:true → VIX live (real-time EODHD) côté US ; EU reste EOD (V2TX live = NA).
    const gate = await this.checkRegimeGate(universe, { intraday: true });
    const next = this.computeNextScanUtc(new Date());

    return {
      portfolioId,
      universe,
      region: gate.region,
      enabled,
      block: gate.block,
      reason: gate.reason,
      vixLabel: gate.region === 'EU' ? 'V2TX' : 'VIX',
      idxLabel: gate.region === 'EU' ? 'SX5E' : 'SPY',
      vix: gate.vix,
      vixChgPct: gate.vixChg,
      idx5dPct: gate.idx5d,
      vixSource: gate.vixSource,
      thresholds: gate.thresholds,
      rotation: gate.rotation
        ? {
            regime: gate.rotation.regime,
            spreadPct: gate.rotation.spreadPct,
            mode: gate.rotation.mode,
            appliedVixPenalty: gate.rotation.appliedVixPenalty,
          }
        : null,
      nextScanUtc: next.iso,
      nextScanKind: next.kind,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Prochain créneau de scan oversold (UTC), aligné sur les crons :
   *  - intraday : `0 0 8-20 * * 1-5` → 08:00..20:00 pile, lun-ven
   *  - daily    : `0 15 21 * * 1-5` → 21:15, lun-ven
   * On itère les créneaux d'un jour ouvré, en sautant samedi/dimanche.
   */
  private computeNextScanUtc(now: Date): { iso: string; kind: 'intraday' | 'daily' } {
    const slots: Array<{ h: number; m: number; kind: 'intraday' | 'daily' }> = [];
    for (let h = 8; h <= 20; h++) slots.push({ h, m: 0, kind: 'intraday' });
    slots.push({ h: 21, m: 15, kind: 'daily' });
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const d = new Date(now);
      d.setUTCDate(now.getUTCDate() + dayOffset);
      const dow = d.getUTCDay(); // 0=dim, 6=sam
      if (dow === 0 || dow === 6) continue;
      for (const s of slots) {
        const cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.h, s.m, 0);
        if (cand > now.getTime()) {
          return { iso: new Date(cand).toISOString(), kind: s.kind };
        }
      }
    }
    return { iso: now.toISOString(), kind: 'intraday' };
  }

  /**
   * PR-2 (widget 3) — Veille news contraires sur les positions oversold OUVERTES.
   *
   * Lecture seule (zéro fetch EODHD live, zéro LLM, zéro close) : interroge les
   * news déjà persistées (eodhd_news_articles) sur les symboles tenus, sur une
   * fenêtre récente (48h), et remonte celles à sentiment négatif. C'est une
   * VISIBILITÉ pour l'utilisateur — PAS un déclencheur d'exit : le mean-reversion
   * tient délibérément à travers le bruit (la chute initiale est souvent due à
   * une mauvaise news ; auto-fermer dessus couperait l'edge). Le seuil -0.6
   * reprend la référence checkNewsShockClose pour la cohérence visuelle.
   * Une seule requête DB (.in sur les tickers), agrégation en mémoire.
   */
  async getNewsWatch(portfolioId: string): Promise<OversoldNewsWatch> {
    const client = this.supabase.getClient();
    const WINDOW_HOURS = 48;
    const nowMs = Date.now();
    const fromIso = new Date(nowMs - WINDOW_HOURS * 3_600_000).toISOString();

    const { data: openRows } = await client
      .from('lisa_positions')
      .select('symbol')
      .eq('portfolio_id', portfolioId)
      .in('venue_fee_detail->>source', ['scanner_oversold', 'scanner_oversold_intraday'])
      .eq('status', 'open');
    const symbols = Array.from(new Set((openRows ?? []).map((r) => String(r.symbol))));
    const openPositions = symbols.length;

    if (openPositions === 0) {
      return { portfolioId, openPositions: 0, windowHours: WINDOW_HOURS, alerts: [], asOf: new Date().toISOString() };
    }

    const { data: news } = await client
      .from('eodhd_news_articles')
      .select('ticker, published_at, title, sentiment_polarity, source_url')
      .in('ticker', symbols)
      .gte('published_at', fromIso)
      .lte('published_at', new Date(nowMs).toISOString())
      .order('published_at', { ascending: false })
      .limit(500);

    // Agrège par symbole : min sentiment + article le plus récent (news triées DESC).
    const bySym = new Map<
      string,
      { count: number; min: number; latestTitle: string | null; latestUrl: string | null; latestAt: string | null }
    >();
    for (const a of news ?? []) {
      const sym = String(a.ticker);
      const sent = typeof a.sentiment_polarity === 'number' ? a.sentiment_polarity : null;
      const cur = bySym.get(sym) ?? { count: 0, min: 1, latestTitle: null, latestUrl: null, latestAt: null };
      cur.count += 1;
      if (sent != null && sent < cur.min) cur.min = sent;
      if (cur.latestAt === null) {
        cur.latestTitle = (a.title as string | null) ?? null;
        cur.latestUrl = (a.source_url as string | null) ?? null;
        cur.latestAt = (a.published_at as string | null) ?? null;
      }
      bySym.set(sym, cur);
    }

    const alerts: OversoldNewsAlert[] = [];
    for (const [sym, v] of bySym.entries()) {
      if (!(v.min <= -0.3)) continue; // garde uniquement le sentiment contraire
      alerts.push({
        symbol: sym,
        articleCount: v.count,
        minSentiment: v.min,
        latestTitle: v.latestTitle,
        latestUrl: v.latestUrl,
        latestAgeHours: v.latestAt ? Math.max(0, (nowMs - new Date(v.latestAt).getTime()) / 3_600_000) : null,
        level: v.min <= -0.6 ? 'shock' : 'watch',
      });
    }
    // shock d'abord, du plus négatif au moins négatif.
    alerts.sort((a, b) => a.minSentiment - b.minSentiment);

    return { portfolioId, openPositions, windowHours: WINDOW_HOURS, alerts, asOf: new Date().toISOString() };
  }

  /**
   * PR-2 (widget loi empirique) — loi empirique oversold segmentée par bande de
   * drop 1j à l'entrée, calculée sur paper_trades (strategy=oversold) du portfolio.
   *
   * Deux lois :
   *  - realized : winRate / PnL moyen des trades CLÔTURÉS (pnl_pct). Disponible
   *    tout de suite. ⚠ mêle qualité d'entrée ET timing de sortie.
   *  - forwardJ10 : winRate / rendement J+10 (fwd_outcome_10d / fwd_return_10d) =
   *    qualité d'entrée ISOLÉE (horizon fixe). Se peuple à mesure que chaque
   *    entrée atteint J+10 ouvré (≈ 18/06).
   *
   * Wilson 95% sur le winRate par bucket pour signaler les bandes à petit n.
   * Lecture seule.
   */
  async getEmpiricalLaw(portfolioId: string): Promise<OversoldEmpiricalLaw> {
    const { data } = await this.supabase
      .getClient()
      .from('paper_trades')
      .select('pnl_pct, fwd_return_10d, fwd_outcome_10d, features_at_entry')
      .eq('strategy', 'oversold')
      .eq('portfolio_id', portfolioId)
      .limit(2000);
    const rows = (data ?? []) as Array<{
      pnl_pct: number | string | null;
      fwd_return_10d: number | string | null;
      fwd_outcome_10d: number | string | null;
      features_at_entry: { drop1d?: number | null } | null;
    }>;

    const realizedSamples: Array<{ drop: number; win: boolean; value: number }> = [];
    const fwdSamples: Array<{ drop: number; win: boolean; value: number }> = [];
    for (const r of rows) {
      const drop = r.features_at_entry?.drop1d;
      if (drop == null || !Number.isFinite(drop)) continue;
      const pnl = r.pnl_pct == null ? null : Number(r.pnl_pct);
      if (pnl != null && Number.isFinite(pnl)) {
        realizedSamples.push({ drop, win: pnl > 0, value: pnl });
      }
      const fwdRet = r.fwd_return_10d == null ? null : Number(r.fwd_return_10d);
      const fwdOut = r.fwd_outcome_10d == null ? null : Number(r.fwd_outcome_10d);
      if (fwdRet != null && Number.isFinite(fwdRet)) {
        fwdSamples.push({ drop, win: fwdOut != null ? fwdOut === 1 : fwdRet > 0, value: fwdRet });
      }
    }

    return {
      portfolioId,
      realized: this.buildLawTable(realizedSamples),
      forwardJ10: { ...this.buildLawTable(fwdSamples), horizonDays: 10 },
      asOf: new Date().toISOString(),
    };
  }

  /**
   * SHADOW « meilleur jour de sortie » (J → J+10). Lit la trajectoire labellisée
   * des closes (`position_close_decisions`) et calcule, par horizon, le P&L moyen/
   * médian qu'un exit aurait donné vs le lock réalisé. MESURE SEULE — ne touche pas
   * au trading. Sert à décider d'allonger l'horizon US (→ J+6) sur données live.
   */
  async getExitHorizonShadow(portfolioId: string) {
    const { data } = await this.supabase
      .getClient()
      .from('position_close_decisions')
      .select('pnl_pct, entry_price, price_j1, price_j3, price_j6, price_j10')
      .eq('portfolio_id', portfolioId)
      .not('price_j1', 'is', null)
      .limit(2000);
    const shadow = computeExitHorizonShadow((data ?? []) as ExitHorizonRow[]);
    return { portfolioId, ...shadow, asOf: new Date().toISOString() };
  }

  /**
   * Bande de drop 1j d'un échantillon (null si non fini). Bandes fines dans la
   * zone 0..-5% car c'est là que se concentrent les entrées (la veine intraday-
   * rebound entre souvent sur un jour déjà vert) — un découpage grossier
   * masquerait le gradient (jour vert ≫ jour encore rouge pour le mean-reversion).
   */
  private static dropBandLabel(drop: number): string | null {
    if (!Number.isFinite(drop)) return null;
    if (drop <= -12) return '≤ -12% (knife)';
    if (drop <= -10) return '-12 à -10%';
    if (drop <= -8) return '-10 à -8%';
    if (drop <= -6) return '-8 à -6%';
    if (drop <= -5) return '-6 à -5%';
    if (drop <= -3) return '-5 à -3%';
    if (drop <= -1) return '-3 à -1%';
    if (drop < 0) return '-1 à 0%';
    return '≥ 0% (vert)';
  }

  private static readonly DROP_BAND_ORDER = [
    '≤ -12% (knife)',
    '-12 à -10%',
    '-10 à -8%',
    '-8 à -6%',
    '-6 à -5%',
    '-5 à -3%',
    '-3 à -1%',
    '-1 à 0%',
    '≥ 0% (vert)',
  ];

  /** Intervalle de Wilson 95% pour une proportion wins/n (null si n=0). */
  private static wilson(wins: number, n: number): { low: number; high: number } | null {
    if (n <= 0) return null;
    const z = 1.96;
    const p = wins / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
    return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
  }

  /** Construit une table de loi (overall + buckets par bande de drop). */
  private buildLawTable(samples: Array<{ drop: number; win: boolean; value: number }>): OversoldLawTable {
    const byBand = new Map<string, { n: number; wins: number; sum: number }>();
    let totN = 0;
    let totWins = 0;
    let totSum = 0;
    for (const s of samples) {
      const band = OversoldScannerService.dropBandLabel(s.drop);
      if (!band) continue;
      const cur = byBand.get(band) ?? { n: 0, wins: 0, sum: 0 };
      cur.n += 1;
      if (s.win) cur.wins += 1;
      cur.sum += s.value;
      byBand.set(band, cur);
      totN += 1;
      if (s.win) totWins += 1;
      totSum += s.value;
    }
    const byDropBand: OversoldLawBucket[] = OversoldScannerService.DROP_BAND_ORDER.filter((b) =>
      byBand.has(b),
    ).map((b) => {
      const v = byBand.get(b)!;
      const ci = OversoldScannerService.wilson(v.wins, v.n);
      return {
        label: b,
        n: v.n,
        wins: v.wins,
        winRatePct: v.n > 0 ? (v.wins / v.n) * 100 : null,
        avgPct: v.n > 0 ? v.sum / v.n : null,
        ciLowPct: ci ? ci.low * 100 : null,
        ciHighPct: ci ? ci.high * 100 : null,
      };
    });
    return {
      sampleSize: totN,
      overallWinRatePct: totN > 0 ? (totWins / totN) * 100 : null,
      overallAvgPct: totN > 0 ? totSum / totN : null,
      byDropBand,
    };
  }

  /**
   * PR-3 — Résume les news persistées (eodhd_news_articles) dans [entry-72h,
   * entry] pour un symbole. Lecture DB pure (zéro fetch EODHD, zéro LLM),
   * fail-soft : aucune news / erreur → features news à 0/null.
   */
  private async summarizeNewsForEntry(symbol: string, entryIso: string) {
    const empty = { newsCount: 0, newsMinSentiment: null, newsAvgSentiment: null, newsAgeHours: null };
    if (!entryIso) return empty;
    try {
      const from = new Date(new Date(entryIso).getTime() - 72 * 3600_000).toISOString();
      const { data } = await this.supabase.getClient()
        .from('eodhd_news_articles')
        .select('published_at, sentiment_polarity')
        .eq('ticker', symbol)
        .lte('published_at', entryIso)
        .gte('published_at', from)
        .order('published_at', { ascending: false })
        .limit(50);
      return summarizeEntryNews(
        (data ?? []).map((a) => ({ publishedAt: a.published_at as string, sentiment: a.sentiment_polarity as number | null })),
        entryIso,
      );
    } catch {
      return empty;
    }
  }

  /**
   * PR-4a — Calcule le label J+10 d'une position (fetch barres + index entrée).
   * Renvoie null si entry+horizon pas encore disponible (position trop récente).
   */
  private async computeFwdForPosition(
    symbol: string,
    entryIso: string,
    horizon = 10,
  ): Promise<{ fwdReturn: number; fwdOutcome: number } | null> {
    const entryDate = entryIso.slice(0, 10);
    if (!entryDate) return null;
    const bars = await this.fetchEodBars(symbol, 160);
    if (bars.length < 2) return null;
    let idx = bars.findIndex((b) => b.date === entryDate);
    if (idx < 0) {
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].date <= entryDate) { idx = i; break; }
      }
    }
    if (idx < 0) return null;
    return computeForwardOutcome(bars, idx, horizon);
  }

  /**
   * PR-4 (fix) — Réconciliation features/outcomes en cron DÉDIÉ 7j/7.
   *
   * Avant : la collecte était câblée en tête des scans (runDailyScan 21:15 +
   * runIntradayScan 08-20h), TOUS DEUX Mon-Fri → aucune collecte le week-end et
   * backfill retardé au lundi. La collecte est du housekeeping data : elle ne
   * doit PAS dépendre des jours de marché. Cron autonome toutes les 30 min,
   * self-gated par OVERSOLD_FEATURE_COLLECTION_ENABLED dans reconcile. Best-effort.
   */
  @Cron('0 */30 * * * *', { name: 'oversold-feature-reconcile', timeZone: 'UTC' })
  async runFeatureReconcile(): Promise<void> {
    await this.reconcileOversoldFeatures().catch((err) =>
      this.logger.warn(`[oversold-features] reconcile cron failed: ${String(err).slice(0, 200)}`),
    );
  }

  /**
   * PR-1 — Fondation boucle d'apprentissage oversold.
   *
   * Réconcilie les positions oversold (lisa_positions, source dans
   * venue_fee_detail) vers `paper_trades` (strategy='oversold') avec le vecteur
   * de features calculé AS-OF l'entrée + l'outcome quand la position est fermée.
   *
   * Idempotent : la clé est `scanner_position_id` = id de la lisa_position.
   *  - position sans ligne paper_trades → fetch barres profondes + INSERT (features
   *    as-of entrée ; outcome si déjà fermée). Backfill des positions existantes.
   *  - ligne paper_trades 'open' dont la position est désormais fermée → UPDATE
   *    outcome uniquement (aucun fetch).
   *
   * NE FILTRE RIEN, NE TRADE RIEN : pure collecte pour que l'empirical law
   * (PR ultérieur) mesure quelles features prédisent les winners. Best-effort,
   * jamais bloquant pour le scan.
   */
  private async reconcileOversoldFeatures(): Promise<void> {
    const enabled =
      (this.config.get<string>('OVERSOLD_FEATURE_COLLECTION_ENABLED') ?? 'true').toLowerCase() === 'true';
    if (!enabled) return;
    const client = this.supabase.getClient();

    const sinceIso = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const { data: posRows } = await client
      .from('lisa_positions')
      .select(
        'id, portfolio_id, symbol, asset_class, status, entry_price, entry_timestamp, exit_timestamp, realized_pnl_usd, realized_pnl_pct, entry_notional_usd, stop_loss_price, take_profit_price, venue_fee_detail',
      )
      .gte('entry_timestamp', sinceIso)
      .limit(2000);

    const oversold = (posRows ?? []).filter((p) => {
      const vfd = p.venue_fee_detail as { source?: string } | null;
      return (vfd?.source ?? '').startsWith('scanner_oversold');
    });
    if (oversold.length === 0) return;

    const { data: ptRows } = await client
      .from('paper_trades')
      .select('id, scanner_position_id, status, fwd_return_10d')
      .eq('strategy', 'oversold')
      .limit(5000);
    const ptByPos = new Map<string, { id: string; status: string; fwdSet: boolean }>();
    for (const r of ptRows ?? []) {
      if (r.scanner_position_id)
        ptByPos.set(r.scanner_position_id as string, {
          id: r.id as string,
          status: r.status as string,
          fwdSet: r.fwd_return_10d != null,
        });
    }

    const pids = [...new Set(oversold.map((p) => p.portfolio_id as string))];
    const { data: pf } = await client.from('portfolios').select('id, user_id').in('id', pids);
    const userByPf = new Map((pf ?? []).map((p) => [p.id as string, p.user_id as string]));

    // PR-2 — contexte régime (VIX/VIX3M/SPY5d/HYG5d) mergé dans features_at_entry.
    const regimeByDate = await this.loadRegimeContext().catch(() => new Map<string, OversoldRegimeCtx>());

    let inserted = 0;
    let updated = 0;
    for (const p of oversold) {
      const posId = p.id as string;
      const closed = p.status !== 'open';
      const pnl = Number(p.realized_pnl_usd ?? 0);
      const existing = ptByPos.get(posId);

      if (existing) {
        if (closed && existing.status === 'open') {
          await client
            .from('paper_trades')
            .update({
              status: 'closed',
              closed_at: p.exit_timestamp,
              pnl_usd: String(pnl),
              pnl_pct: p.realized_pnl_pct != null ? String(p.realized_pnl_pct) : null,
              outcome_label: pnl > 0 ? 1 : 0,
            })
            .eq('id', existing.id);
          updated++;
        }
        // PR-4a — backfill label J+10 quand la position a vieilli au-delà de
        // l'horizon (entry+10 jours ouvrés disponible). Idempotent : une seule
        // fois par position (fwdSet devient true ensuite).
        if (!existing.fwdSet) {
          const ageDays = (Date.now() - new Date(String(p.entry_timestamp ?? '')).getTime()) / 86_400_000;
          if (Number.isFinite(ageDays) && ageDays >= 14) {
            const fwd = await this.computeFwdForPosition(p.symbol as string, String(p.entry_timestamp ?? ''));
            if (fwd) {
              await client
                .from('paper_trades')
                .update({ fwd_return_10d: String(fwd.fwdReturn), fwd_outcome_10d: fwd.fwdOutcome, fwd_horizon_days: 10 })
                .eq('id', existing.id);
              updated++;
            }
          }
        }
        continue;
      }

      // Nouvelle position → features as-of entrée depuis barres profondes.
      const entryDate = String(p.entry_timestamp ?? '').slice(0, 10);
      if (!entryDate) continue;
      const bars = await this.fetchEodBars(p.symbol as string, 160);
      if (bars.length < 22) continue;
      let idx = bars.findIndex((b) => b.date === entryDate);
      if (idx < 0) {
        for (let i = bars.length - 1; i >= 0; i--) {
          if (bars[i].date <= entryDate) { idx = i; break; }
        }
      }
      if (idx < 1) continue;
      const feat = computeEntryFeatures(bars, idx);
      if (!feat) continue;
      // Merge contexte régime as-of entrée (champs null si indispo).
      const reg = this.regimeAsOf(regimeByDate, bars[idx].date);
      // PR-3 — features news persistées as-of entrée (fail-soft, lecture DB).
      const news = await this.summarizeNewsForEntry(p.symbol as string, String(p.entry_timestamp ?? ''));
      const featPlus = { ...feat, ...(reg ?? {}), ...news };
      // PR-4a — label J+10 (null si position trop récente → backfill ultérieur).
      const fwd = computeForwardOutcome(bars, idx, 10);

      const row: Record<string, unknown> = {
        user_id: userByPf.get(p.portfolio_id as string) ?? null,
        portfolio_id: p.portfolio_id,
        symbol: p.symbol,
        asset_class: p.asset_class ?? 'us_equity',
        entry_price: p.entry_price != null ? String(p.entry_price) : null,
        size_usd: p.entry_notional_usd != null ? String(p.entry_notional_usd) : null,
        // paper_trades.stop_loss / take_profit sont NOT NULL → fallback '0' quand
        // la position n'a pas de stop/TP enregistré (sinon l'INSERT échoue et la
        // collecte ne produit aucune ligne — bug constaté 07/06).
        stop_loss: String(p.stop_loss_price ?? 0),
        take_profit: String(p.take_profit_price ?? 0),
        status: closed ? 'closed' : 'open',
        strategy: 'oversold',
        scanner_position_id: posId,
        setup_kind: 'OVERSOLD_DIP',
        features_at_entry: featPlus,
        opened_at: p.entry_timestamp,
      };
      if (closed) {
        row.closed_at = p.exit_timestamp;
        row.pnl_usd = String(pnl);
        row.pnl_pct = p.realized_pnl_pct != null ? String(p.realized_pnl_pct) : null;
        row.outcome_label = pnl > 0 ? 1 : 0;
      }
      if (fwd) {
        row.fwd_return_10d = String(fwd.fwdReturn);
        row.fwd_outcome_10d = fwd.fwdOutcome;
        row.fwd_horizon_days = 10;
      }
      const { error } = await client.from('paper_trades').insert(row);
      if (!error) inserted++;
    }

    if (inserted || updated) {
      this.logger.log(
        `[oversold-features] reconcile: +${inserted} insérés, ${updated} outcomes maj (${oversold.length} positions oversold)`,
      );
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
    vix: number | null = null,
  ): Promise<void> {
    const closeJ = cand.closeJ;
    const stopLossPrice = String(closeJ * (1 + cfg.stopCatastrophePct / 100));
    const takeProfitPrice = cfg.tpPct != null ? String(closeJ * (1 + cfg.tpPct / 100)) : null;

    // Sizing dynamique : taille calculée par bande de drop × VIX, bornée plancher/plafond.
    const sizing = computeOversoldNotional({ baseNotionalUsd: cfg.positionNotionalUsd, dropPct: cand.dropPct, vix, capitalUsd: cfg.capitalUsd, config: cfg.sizing });
    if (sizing.dynamic) {
      this.logger.log(`[oversold-sizing] ${cand.symbol} drop=${cand.dropPct.toFixed(1)}% ${sizing.band} ×${sizing.bandMult}×vix${sizing.vixDamp} → $${sizing.notionalUsd}${sizing.clamp ? ` (${sizing.clamp})` : ''} (base $${cfg.positionNotionalUsd})`);
    }

    await this.lisa.getPaperBroker().openPositionDirect({
      portfolioId,
      symbol: cand.symbol,
      assetClass: 'us_equity',
      direction: 'long',
      venue: 'US',
      capitalAllocationUsd: String(sizing.notionalUsd),
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

      // 05/06/2026 HOTFIX : la colonne `source` est 'lisa' (writer LisaService),
      // la vraie source oversold est dans venue_fee_detail->>source. Cf audit
      // open positions HIGH 12/12 ont source='lisa' + venue_fee_detail.source=scanner_oversold.
      const { data: positions } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('id, portfolio_id, symbol, asset_class, entry_price, entry_notional_usd, source, venue_fee_detail')
        .eq('status', 'open')
        .in('venue_fee_detail->>source', ['scanner_oversold', 'scanner_oversold_intraday'])
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
