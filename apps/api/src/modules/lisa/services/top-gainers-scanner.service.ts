/**
 * P5-PIVOT-TOP-GAINERS — Scanner momentum cross-asset 24/7.
 *
 * Bypass complet du pipeline Lisa LLM / news / regime. Stratégie déterministe :
 *   - 15 min cron (24/7)
 *   - Fetch top gainers EODHD (multi-exchange : US/LSE/XETRA/PA/TSE/HK/AU/etc.)
 *   - Fetch crypto top gainers via BinanceMarketService (24h ticker)
 *   - Filter via evaluateTopGainerCandidate (asset-class adaptive thresholds)
 *   - Top 3 cross-asset par score → INSERT pseudo-proposal + paperBroker.openPosition
 *   - Audit dans top_gainers_log + lisa_decision_log
 *
 * Activation : env `STRATEGY_MODE=top_gainers` (par portfolio ou global).
 *
 * Out of scope ce PR (deferred PR2/PR3) :
 *   - Yahoo fallback / Coinbase / Kraken / OANDA / IBKR multi-currency
 *   - Indicateurs techniques avancés (RSI/MACD/EMA/BB/ATR/VWAP/Stoch/OBV/ADX)
 *   - UI banner + endpoint /api/top-gainers
 *   - Backtest /backtest/top-gainers + CSV export
 *   - Trailing stop +3% custom + time-stop 4h auto-close
 *   - Multi-currency portfolio (paperBroker actuel = USD only)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { BinanceMarketService } from './binance-market.service';
import { MultiTimeframePersistenceService, type PersistenceWithPath } from './multi-tf-persistence.service';
import { PersistenceProbabilityService } from './persistence-probability.service';
import { EodhdQuotaService } from './eodhd-quota.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
// PR6.3 — Shadow wiring (LisaModule import GainersModule pour résolution DI)
import { GainersShadowRunService } from '../../gainers-scanner/shadow/shadow-run.service';
import { GainersBloc1Service, SHADOW_BLOC1_FULL_CONFIG } from '../../gainers-scanner/bloc1/gainers-bloc1.service';
import { SHADOW_BLOC1_CONFIG } from '../../gainers-scanner/bloc1/prefilter-gates';
import { CandidateRejectReason } from '../../gainers-scanner/domain/gainers-enums';
// PR6.4 — Enrichment helpers (ATR + EMA + persistence depuis ohlcv_cache_daily)
import { enrichShadowCandidate } from './shadow-enrichment.helper';
import {
  detectAssetClass,
  selectTopGainers,
  type TopGainerCandidate,
  type TopGainerAssetClass,
  type PersistenceResult,
  isWithinSession,
  computeVenueFeeDetail,
} from '@smartvest/ai-analyst';
import {
  EARLY_RETURN_REASONS,
  type EarlyReturnReason,
  type GainersScannerStatus,
  type PerExchangeResult,
} from './gainers-scanner-status.types';

interface EodhdScreenerRow {
  code: string;
  name?: string;
  exchange_short_name?: string;
  exchange_short?: string;
  exchange?: string;
  last_price?: number | string;
  adjusted_close?: number | string;
  high_price?: number | string;
  high?: number | string;
  low_price?: number | string;
  open?: number | string;
  /** Filter form (new, validated against EODHD doc). */
  refund_1d_p?: number | string;
  /** Legacy / response form — sometimes present alongside `refund_1d_p`. */
  change_p?: number | string;
  volume?: number | string;
  avgvol_1d?: number | string;
  avgvol_50d?: number | string;
  avgvol_200d?: number | string;
  market_capitalization?: number | string;
  market_cap?: number | string;
}

/**
 * P5-PIVOT-TOP-GAINERS v1 — 13+ exchanges scannés en parallèle.
 *
 * Liste obligatoire confirmée (Promise.allSettled, 13+ entrées) :
 *   US        : NYSE/NASDAQ/AMEX (équities US)
 *   LSE       : London Stock Exchange
 *   XETRA     : Frankfurt
 *   PA        : Euronext Paris
 *   SW        : SIX Suisse
 *   MI        : Borsa Italiana
 *   MC, BME   : Bolsa Madrid (les 2 codes EODHD selon l'API version)
 *   AS, AMS   : Euronext Amsterdam (les 2 codes EODHD selon l'API version)
 *   TSE       : Tokyo
 *   HK        : Hong Kong
 *   AU        : Australian Securities Exchange (Sydney)
 *   KO        : Korea (Seoul)
 *   TO        : Toronto Stock Exchange
 *
 * Bonus : NSE (India), BSE (India) — pas dans la spec minimale mais
 * faible coût marginal (1 fetch parallèle de plus).
 */
/**
 * P18d — Exchanges groupés par région pour permettre un gating session-aware.
 *
 * P19a (29/04/2026, principe directeur) : on **NE DROP PAS** d'exchanges du
 * scan. Le critère SmartVest est de capter toutes les opportunités mondiales
 * (US/EU/Asia/Korea/Australia) ; les marchés sans intraday EODHD sont
 * annotés `coverage:'unavailable'` dans la persistance et affichés en UI
 * avec un badge dégradé, jamais hidden. Le routing multi-vendor (Yahoo /
 * Finnhub) pour les marchés sans intraday EODHD = follow-up P19b.
 *
 * NB : `MC` et `BME` sont les 2 codes EODHD acceptés selon la version API
 * pour la Bolsa de Madrid ; `AS` et `AMS` idem pour Euronext Amsterdam.
 */
const EU_EXCHANGES = ['LSE', 'XETRA', 'PA', 'SW', 'MI', 'MC', 'BME', 'AS', 'AMS'];
// P19d (29/04/2026 14:30 CEST) — Ajout SSE (Shanghai) + SZSE (Shenzhen) pour
// couverture mondiale complète.
// P19r (29/04/2026 19:30 UTC) — Ajout KQ (KOSDAQ) — couverture Asie complète
// (KOSPI .KO + KOSDAQ .KQ). Constat user dump SQL Supabase : 9/20 KO + 4/20
// NSE + 1/20 AU = 70% des candidats Top 20 viennent d'Asie/Inde, mais KOSDAQ
// (Kakao 035720.KQ, Naver, etc.) n'était pas scanné → trou de couverture.
//
// P20a (01/05/2026) — Correction codes EODHD officiels (cf. exchanges-list doc) :
//   SS  → SHG  (Shanghai Stock Exchange, suffix .SHG  — SS = Yahoo Finance convention)
//   SZ  → SHE  (Shenzhen Stock Exchange, suffix .SHE  — SZ = Yahoo Finance convention)
//   TSE → T    (Tokyo Stock Exchange,    suffix .T     — TSE était le MIC, pas le code EODHD)
// Ref : vendor/eodhd-claude-skills/.../exchanges-list.md + symbol-format.md
// PR #268 — NSE/BSE retirés. Plan EODHD ALL-IN-ONE ne couvre pas l'Inde →
// chaque appel sur ces exchanges renvoie 404 + retry tick-data + 404 + cache miss.
// Constat 07/05/2026 : ~25 tickers NSE 404 par cycle scanner (~75-100 calls
// EODHD perdus/cycle + 6-8 secondes de latence supplémentaires). Si le plan
// est upgradé un jour pour inclure NSE/BSE, réajouter 'NSE', 'BSE' à cette liste.
const NON_EU_EXCHANGES = ['US', 'T', 'HK', 'AU', 'KO', 'KQ', 'TO', 'SHG', 'SHE'];
/** Watchlists EU dont la session_open_utc / session_close_utc gate l'EODHD scan. */
const EU_WATCHLIST_NAMES = ['cac40', 'dax40', 'ftse100'];
const CRYPTO_PAIRS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT'];

/**
 * PR #266 — Horaires session UTC (approximatifs, ne tient pas compte du DST
 * change exact). Utilisés pour :
 *   - Filtrage automatique scan : skip un asset class quand bourse fermée.
 *   - Force-close avant cloche : ferme positions à T-N min de close.
 *
 * Crypto = 24/7, jamais filtré ni force-fermé.
 *
 * Ref : ohlcv-cache/watchlist_universe (session_open_utc / session_close_utc)
 * pour les bourses EU détaillées (CAC/DAX/FTSE). Ici on agrège par classe.
 */
type MarketSessionClass = 'us' | 'eu' | 'asia';
const MARKET_SESSION_HOURS: Record<MarketSessionClass, { openUtcMin: number; closeUtcMin: number }> = {
  // NYSE/NASDAQ : 14:30 - 21:00 UTC (été — hiver +1h, on accepte la dérive)
  us:   { openUtcMin: 14 * 60 + 30, closeUtcMin: 21 * 60 },
  // EU agrégé (LSE/Euronext/XETRA) : 08:00 - 16:30 UTC
  eu:   { openUtcMin:  8 * 60,      closeUtcMin: 16 * 60 + 30 },
  // Asia agrégé (TSE/HKEX/KRX/SSE/SZSE) : 00:00 - 08:00 UTC
  asia: { openUtcMin:  0,           closeUtcMin:  8 * 60 },
};

/**
 * Retourne true si le marché est ouvert maintenant (UTC).
 * Lun-Ven uniquement pour US/EU/Asia. Crypto 24/7 → géré séparément.
 */
function isMarketOpen(cls: MarketSessionClass, now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { openUtcMin, closeUtcMin } = MARKET_SESSION_HOURS[cls];
  return min >= openUtcMin && min < closeUtcMin;
}

/**
 * Retourne true si le marché ferme dans <= offsetMin minutes.
 * Utilisé pour force-close. Renvoie false si déjà fermé ou pas encore ouvert.
 */
function isApproachingClose(cls: MarketSessionClass, offsetMin: number, now: Date = new Date()): boolean {
  if (!isMarketOpen(cls, now)) return false;
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { closeUtcMin } = MARKET_SESSION_HOURS[cls];
  return closeUtcMin - min <= offsetMin;
}

/**
 * Mappe un asset_class lisa_positions / TopGainerAssetClass vers la session.
 * crypto retourne null (jamais filtré ni force-close).
 */
function sessionClassFor(assetClass: string): MarketSessionClass | null {
  if (assetClass === 'us_equity_large' || assetClass === 'us_equity_small_mid') return 'us';
  if (assetClass === 'eu_equity') return 'eu';
  if (assetClass === 'asia_equity') return 'asia';
  return null;
}

/**
 * PR6.6.3 — Market cap approximatif pour les 10 Binance majors whitelistés.
 *
 * Binance ticker24hr ne renvoie pas market cap (OHLCV-only). Sans valeur réelle,
 * BLOC 1 V1 gate `MARKET_CAP_MIN` (seuil 500M crypto) fail systématiquement avec
 * marketCap=0. Les 10 majors actuels ont tous un cap entre 8B et 1.3T (>>500M),
 * la gate est de fait redondante pour cette whitelist contrôlée.
 *
 * Valeurs au 02/05/2026 (approximatives, conservatrices). La marge vs seuil 500M
 * tolère ×10 dérive avant fail.
 *
 * Long-term : intégration CoinGecko/CMC pour caps live (cron quotidien). Out of
 * scope PR6.6.3.
 */
const CRYPTO_MARKET_CAP_USD: Record<string, number> = {
  BTCUSDT:  1_300_000_000_000,
  ETHUSDT:    400_000_000_000,
  BNBUSDT:     90_000_000_000,
  SOLUSDT:    100_000_000_000,
  XRPUSDT:     60_000_000_000,
  ADAUSDT:     15_000_000_000,
  AVAXUSDT:    15_000_000_000,
  DOTUSDT:      8_000_000_000,
  LINKUSDT:    10_000_000_000,
  MATICUSDT:    8_000_000_000,
};

/**
 * P18f (29/04/2026, autonomous) — `crypto_tradable` concept : whitelist
 * opt-in via env var `CRYPTO_TRADABLE_WHITELIST=BTCUSDT,ETHUSDT,...` qui
 * RESTREINT les ouvertures de positions crypto à ces symboles.
 *
 * Comportement strict mode `option (b)` retenu par l'utilisateur :
 *   - whitelist VIDE  → behavior unchanged, tous les CRYPTO_PAIRS sont
 *                       éligibles à l'open (back-compat)
 *   - whitelist SET   → SEULS les symboles présents sont opens. Les autres
 *                       sont SKIPPED + LOGGED en INFO (visible mais pas
 *                       d'effet de trade)
 *
 * Permet à l'utilisateur de :
 *   - Restreindre BTC/ETH uniquement en prod (le plus safe)
 *   - Élargir progressivement après backtest par ticker
 *   - Garder le scan complet (UI affiche tous les CRYPTO_PAIRS dans le
 *     Top 20) tout en ne tradant que les whitelistés
 */
const CRYPTO_TRADABLE_ENV_VAR = 'CRYPTO_TRADABLE_WHITELIST';

/**
 * P18d — Fallback hardcodé si la query `watchlist_universe` échoue : enveloppe
 * conservatrice [07:00, 17:00] UTC qui couvre CAC40 / DAX40 (07:00-15:30) +
 * FTSE100 (08:00-16:30). Préférable au "always-on" qui re-causerait les 422.
 */
const EU_FALLBACK_OPEN_UTC = '07:00';
const EU_FALLBACK_CLOSE_UTC = '17:00';

/**
 * Fallback defaults quand `lisa_session_configs` n'a pas les colonnes
 * gainers_* (migration 0115 pas encore appliquée OU portfolio sans config).
 *
 * Avant PR Hardcodes-fix : MAX_POSITIONS_PER_CYCLE_V1 et maxOpen étaient
 * hardcodés ici. Désormais lus depuis cfg.gainers_max_per_cycle et
 * cfg.gainers_max_open_positions, avec ces valeurs comme dernier recours.
 */
const FALLBACK_MAX_PER_CYCLE = 3;
const FALLBACK_MAX_OPEN = 5;
const FALLBACK_POSITION_PCT = 20.0;
const FALLBACK_CASH_RESERVE_PCT = 10.0;
const FALLBACK_CAPITAL_USD = 10000;
const FALLBACK_COOLDOWN_MIN = 30;

const TOP_GAINERS_CRON_NAME = 'top-gainers-scanner';

@Injectable()
export class TopGainersScannerService implements OnModuleInit {
  private readonly logger = new Logger(TopGainersScannerService.name);
  private scanIntervalMinutes = 15;
  private lastTickAt: Date | null = null;

  /** P9-UX — Cache des cycles per-portfolio (évite re-query DB à chaque tick). */
  private cycleCache = new Map<string, { cycle: number; asOf: number }>();
  /** P9-UX — Track lastScanAt per portfolio pour gating per-cycle. */
  private lastScanByPortfolio = new Map<string, number>();
  private readonly CYCLE_CACHE_TTL_MS = 30_000;

  /**
   * P18d — Cache des fenêtres EU (60s). Évite de re-query `watchlist_universe`
   * à chaque tick alors que les sessions changent au plus 2× par jour.
   */
  private euSessionsCache: {
    asOf: number;
    windows: Array<{ name: string; openUtc: string; closeUtc: string }>;
  } | null = null;
  private readonly EU_SESSIONS_CACHE_TTL_MS = 60_000;

  /** P18e — Compteur cumulatif des candidats skip pour absence de persistence. */
  private skippedNoPersistenceCounter = 0;

  /**
   * P19s++ (30/04/2026 08:10 UTC HOTFIX) — Cache de fetchAllCandidates pour
   * éviter le burn quota EODHD. Avant : UI poll /lisa/gainers-persistence-snapshot
   * toutes les 60s × 11 exchanges = 660 calls/h juste pour 1 user. Avec
   * cycle scanner 15min, le cache permet aux UI polls de partager la même
   * fetch sans re-frapper EODHD.
   */
  private allCandidatesCache: { candidates: TopGainerCandidate[]; asOf: number } | null = null;
  private readonly ALL_CANDIDATES_CACHE_TTL_MS = 15 * 60_000; // 15 min

  // ─────────────────────────────────────────────────────────────────
  // Observability — état diagnostique read-only exposé via
  // GET /admin/gainers/scanner-status. N'influence pas la logique scanner.
  // ─────────────────────────────────────────────────────────────────
  private lastCycleStartedAt: Date | null = null;
  private lastCycleCompletedAt: Date | null = null;
  private lastSuccessfulCompleteAt: Date | null = null;
  private lastEarlyReturn: { reason: EarlyReturnReason; at: Date; details?: string } | null = null;
  private lastFetchAllCandidatesInfo: { count: number; fromCache: boolean; at: Date } | null = null;
  private lastTopGainersSelected: { count: number; at: Date } | null = null;
  private perExchangeLastResult = new Map<string, { count: number; lastError?: string; at: Date }>();
  private lastPersistLogAttempt: { count: number; at: Date; error?: string } | null = null;
  /** Ring buffer 24h des starts de cycle (pour count). */
  private cyclesLast24h: Date[] = [];
  /** Ring buffer 24h des early returns (pour breakdown by reason). */
  private earlyReturnsLast24h: Array<{ reason: EarlyReturnReason; at: Date }> = [];

  private recordCycleStart(): void {
    const at = new Date();
    this.lastCycleStartedAt = at;
    this.cyclesLast24h.push(at);
    this.pruneOld24h();
  }

  private recordCycleComplete(success: boolean): void {
    const at = new Date();
    this.lastCycleCompletedAt = at;
    if (success) this.lastSuccessfulCompleteAt = at;
  }

  private recordEarlyReturn(reason: EarlyReturnReason, details?: string): void {
    const at = new Date();
    this.lastEarlyReturn = details !== undefined ? { reason, at, details } : { reason, at };
    this.earlyReturnsLast24h.push({ reason, at });
    this.pruneOld24h();
  }

  private recordFetchAllCandidates(count: number, fromCache: boolean): void {
    this.lastFetchAllCandidatesInfo = { count, fromCache, at: new Date() };
  }

  private recordTopSelected(count: number): void {
    this.lastTopGainersSelected = { count, at: new Date() };
  }

  private recordExchangeResult(exchange: string, count: number, error?: string): void {
    const entry = error !== undefined
      ? { count, lastError: error, at: new Date() }
      : { count, at: new Date() };
    this.perExchangeLastResult.set(exchange, entry);
  }

  private recordPersistLogAttempt(count: number, error?: string): void {
    this.lastPersistLogAttempt = error !== undefined
      ? { count, at: new Date(), error }
      : { count, at: new Date() };
  }

  private pruneOld24h(): void {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    this.cyclesLast24h = this.cyclesLast24h.filter((d) => d.getTime() >= cutoff);
    this.earlyReturnsLast24h = this.earlyReturnsLast24h.filter((r) => r.at.getTime() >= cutoff);
  }

  /**
   * Retourne le snapshot diagnostic complet pour /admin/gainers/scanner-status.
   * Read-only. Exécute 1 SELECT light sur lisa_session_configs pour extraire
   * la config courante des portfolios actifs.
   */
  async getStatus(): Promise<GainersScannerStatus> {
    this.pruneOld24h();
    const earlyReturnsByReason: Record<EarlyReturnReason, number> = EARLY_RETURN_REASONS
      .reduce((acc, r) => ({ ...acc, [r]: 0 }), {} as Record<EarlyReturnReason, number>);
    for (const r of this.earlyReturnsLast24h) {
      earlyReturnsByReason[r.reason] = (earlyReturnsByReason[r.reason] ?? 0) + 1;
    }

    const { data: configRows } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('portfolio_id, gainers_cycle_minutes, gainers_min_persistence_score, gainers_min_path_efficiency, gainers_default_tp_pct, gainers_default_sl_pct')
      .eq('strategy_mode', 'gainers')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);

    const activeIds = (configRows ?? []).map((r) => String(r.portfolio_id));

    const perExchange: Record<string, PerExchangeResult> = {};
    for (const [ex, info] of this.perExchangeLastResult.entries()) {
      perExchange[ex] = {
        count: info.count,
        at: info.at.toISOString(),
        ...(info.lastError !== undefined ? { lastError: info.lastError } : {}),
      };
    }

    const scannerPause = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';
    const multiTfPause = (this.config.get<string>('MULTITF_PAUSE') ?? 'false').toLowerCase() === 'true';
    const eodhdApiKeySet = !!this.config.get<string>('EODHD_API_KEY');

    return {
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastCycleStartedAt: this.lastCycleStartedAt ? this.lastCycleStartedAt.toISOString() : null,
      lastCycleCompletedAt: this.lastCycleCompletedAt ? this.lastCycleCompletedAt.toISOString() : null,
      lastEarlyReturn: this.lastEarlyReturn
        ? {
            reason: this.lastEarlyReturn.reason,
            at: this.lastEarlyReturn.at.toISOString(),
            ...(this.lastEarlyReturn.details !== undefined ? { details: this.lastEarlyReturn.details } : {}),
          }
        : null,
      secrets: { scannerPause, multiTfPause, eodhdApiKeySet },
      lastFetchAllCandidates: this.lastFetchAllCandidatesInfo
        ? {
            count: this.lastFetchAllCandidatesInfo.count,
            fromCache: this.lastFetchAllCandidatesInfo.fromCache,
            at: this.lastFetchAllCandidatesInfo.at.toISOString(),
          }
        : null,
      lastTopGainersSelected: this.lastTopGainersSelected
        ? {
            count: this.lastTopGainersSelected.count,
            at: this.lastTopGainersSelected.at.toISOString(),
          }
        : null,
      perExchangeLastResult: perExchange,
      lastPersistLogAttempt: this.lastPersistLogAttempt
        ? {
            count: this.lastPersistLogAttempt.count,
            at: this.lastPersistLogAttempt.at.toISOString(),
            ...(this.lastPersistLogAttempt.error !== undefined ? { error: this.lastPersistLogAttempt.error } : {}),
          }
        : null,
      activeGainersPortfoliosCount: activeIds.length,
      activeGainersPortfolioIds: activeIds,
      currentConfigSnapshot: (configRows ?? []).map((r) => ({
        portfolio_id: String(r.portfolio_id),
        gainers_cycle_minutes: r.gainers_cycle_minutes != null ? Number(r.gainers_cycle_minutes) : null,
        gainers_min_persistence_score: r.gainers_min_persistence_score != null ? Number(r.gainers_min_persistence_score) : null,
        gainers_min_path_efficiency: r.gainers_min_path_efficiency != null ? Number(r.gainers_min_path_efficiency) : null,
        gainers_default_tp_pct: r.gainers_default_tp_pct != null ? Number(r.gainers_default_tp_pct) : null,
        gainers_default_sl_pct: r.gainers_default_sl_pct != null ? Number(r.gainers_default_sl_pct) : null,
      })),
      cyclesLast24h: this.cyclesLast24h.length,
      earlyReturnsLast24hByReason: earlyReturnsByReason,
      lastSuccessfulCompleteAt: this.lastSuccessfulCompleteAt ? this.lastSuccessfulCompleteAt.toISOString() : null,
    };
  }

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly config: ConfigService,
    private readonly binanceMarket: BinanceMarketService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly mtfPersistence: MultiTimeframePersistenceService,
    /**
     * P17 — LLM router multi-vendor (Gemini Flash-Lite primaire + fallback chain).
     * Quand SCANNER_LLM_ROUTER_ENABLED=true, sera utilisé pour analyse signal /
     * ranking / thesis. Tant que false, l'injection est inerte (router.isEnabled() = false).
     * Wiring des call sites = follow-up post-validation utilisateur.
     */
    private readonly llmRouter: ScannerLlmRouterService,
    /**
     * PR6.3 — ShadowRunService inject pour persister chaque candidat scanné
     * dans gainers_v1_shadow_signals quand GAINERS_V1_SHADOW=true.
     * PR6.4 — Enrichi avec BLOC 1 réel + persistence multi-TF + ATR/EMA.
     */
    private readonly shadowRun: GainersShadowRunService,
    /**
     * PR6.4 — GainersBloc1Service inject pour run prefilter + composite
     * scorer réels avec SHADOW_BLOC1_CONFIG (tolère atr/persistence null).
     */
    private readonly bloc1: GainersBloc1Service,
    /**
     * PR #4 — PersistenceProbabilityService consume du modèle ML logistique
     * (entraîné weekly par ProbabilityRefitCron). Gate `pWin >= threshold`
     * activable par portfolio (cfg.gainers_p_win_gate_enabled, default false).
     * Fallback automatique quand modèle pas prêt (sample < 30 OR auc < 0.55).
     */
    private readonly probability: PersistenceProbabilityService,
    /**
     * PR #257 — Câblage quota auto-throttle EODHD. Le scanner skip son cycle
     * quand le quota atteint 85% (`scannerPaused` flag). Évite l'épuisement
     * total observé prod 06/05/2026 ~08:30 UTC où le cron 1 min consommait
     * ~22k calls/h jusqu'à atteindre 100k/100k → blocage authoritative.
     */
    private readonly quotaService: EodhdQuotaService,
  ) {}

  /**
   * P8 — Resolve config min persistence score.
   * Priority chain : DB > env > default(0.67).
   *
   * Note: 0.67 est intentionnellement ≥ 4/6 (pas 5/6). La comparaison
   * réelle utilise Math.round(minScore × availableCount) pour éviter
   * le float off-by-one : 0.67 × 6 = 4.02 → round → 4 (= 4/6 gate).
   */
  resolveMinPersistenceScore(portfolioMinScore?: number | null): number {
    if (typeof portfolioMinScore === 'number' && Number.isFinite(portfolioMinScore)) {
      return Math.max(0, Math.min(1, portfolioMinScore));
    }
    const envRaw = this.config.get<string>('GAINERS_MIN_PERSISTENCE_SCORE');
    if (envRaw) {
      const n = parseFloat(envRaw);
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    }
    return 0.67;
  }

  /**
   * P7 — Expose l'intervalle pour /lisa/gainers-status (countdown UI).
   */
  getScanIntervalMinutes(): number {
    return this.scanIntervalMinutes;
  }

  /**
   * P7 — Timestamp du dernier tick (utilisé pour calculer nextTickInSeconds
   * côté gainers-status). null tant que le premier cycle n'a pas tourné.
   */
  getLastTickAt(): Date | null {
    return this.lastTickAt;
  }

  /**
   * P9-UX — Lit le cycle gainers d'un portfolio depuis la DB avec cache 30s.
   * Default 15 min si la colonne est absente OU non set.
   */
  async getCycleMinutes(portfolioId: string): Promise<number> {
    const cached = this.cycleCache.get(portfolioId);
    if (cached && Date.now() - cached.asOf < this.CYCLE_CACHE_TTL_MS) {
      return cached.cycle;
    }
    const { data } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('gainers_cycle_minutes')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const raw = Number(data?.gainers_cycle_minutes ?? 15);
    const cycle = Number.isFinite(raw) ? Math.max(1, Math.min(60, raw)) : 15;
    this.cycleCache.set(portfolioId, { cycle, asOf: Date.now() });
    return cycle;
  }

  /**
   * P9-UX — Renvoie le timestamp du dernier scan effectif pour un portfolio
   * (utilisé pour calculer nextTickInSeconds côté UI).
   */
  getLastScanForPortfolio(portfolioId: string): number | null {
    return this.lastScanByPortfolio.get(portfolioId) ?? null;
  }

  /** P18e — Métrique cumulative observability. */
  getSkippedNoPersistenceCounter(): number {
    return this.skippedNoPersistenceCounter;
  }

  /** P18f — Compteur cumulatif des crypto skip pour absence whitelist. */
  private skippedNotCryptoTradableCounter = 0;
  getSkippedNotCryptoTradableCounter(): number {
    return this.skippedNotCryptoTradableCounter;
  }

  /**
   * P18f — Vérifie si le symbole crypto est dans la whitelist opt-in
   * définie par env `CRYPTO_TRADABLE_WHITELIST` (CSV, case-insensitive).
   *
   * Retourne `true` si :
   *   - la whitelist est VIDE / non-définie (back-compat — pas de restriction)
   *   - le symbole est présent dans la whitelist
   *
   * Retourne `false` SEULEMENT si la whitelist est définie ET le symbole
   * absent. Le caller skip + log dans ce cas.
   */
  isCryptoTradable(symbol: string): boolean {
    const raw = this.config.get<string>(CRYPTO_TRADABLE_ENV_VAR);
    if (!raw || raw.trim().length === 0) return true;
    const whitelist = raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (whitelist.length === 0) return true;
    return whitelist.includes(symbol.toUpperCase());
  }

  /**
   * P5-PIVOT-TOP-GAINERS Guard 4 — Cron interval configurable via env
   * `SCAN_INTERVAL_MINUTES` (default **1** depuis PR #250). Range valide 1-1440 min.
   * Scheduling dynamique au boot : `fly secrets set SCAN_INTERVAL_MINUTES=2`
   * + reboot machine → cron tourne toutes les 2 min.
   *
   * Pourquoi default 1 (PR #250) : le scanner Gainers est déterministe
   * (~250 ms / candidat). Latence ouverture devient quasi-instantanée.
   * Coût ~63 EODHD calls / cycle × 1440 min = 90k/jour, dans le budget
   * du plan ALL-IN-ONE (100k/jour). Plan plus large = augmenter via env.
   *
   * UI dynamique (changement live sans reboot) = deferred PR2.
   */
  onModuleInit(): void {
    const raw = this.config.get<string>('SCAN_INTERVAL_MINUTES');
    const parsed = parseInt(String(raw ?? '1'), 10);
    const validated = Number.isFinite(parsed)
      ? Math.max(1, Math.min(1440, parsed))
      : 1;
    if (parsed !== validated) {
      this.logger.warn(
        `[top-gainers] SCAN_INTERVAL_MINUTES=${raw} hors range [1,1440] → clamp à ${validated}`,
      );
    }
    if (validated < 5) {
      this.logger.warn('[top-gainers] interval <5min — risque rate-limit EODHD/Binance');
    }
    if (validated > 60) {
      this.logger.warn('[top-gainers] interval >60min — opportunités intraday potentiellement ratées');
    }
    this.scanIntervalMinutes = validated;
    // Cron expression : "*/N * * * *" (minute granularité, secondes à 0 par cron lib).
    const cronExpr = `*/${validated} * * * *`;
    try {
      // Idempotent : si déjà enregistré (hot-reload dev), ne pas re-add
      this.schedulerRegistry.getCronJob(TOP_GAINERS_CRON_NAME);
      this.logger.log(`[top-gainers] cron already registered, skip`);
      return;
    } catch {
      // Pas encore enregistré — on continue
    }
    const job = new CronJob(cronExpr, () => {
      void this.runScanner().catch((e) =>
        this.logger.error(`[top-gainers] runScanner error: ${String(e).slice(0, 200)}`),
      );
    });
    this.schedulerRegistry.addCronJob(TOP_GAINERS_CRON_NAME, job);
    job.start();
    this.logger.log(
      `[top-gainers] scheduled every ${validated}min (cron='${cronExpr}', strategy_active=${this.isStrategyActive()})`,
    );
  }

  /**
   * Run scanner. P7 — gating priorité DB > env :
   *
   *   1. Charge les portfolios avec strategy_mode='gainers' AND autopilot_enabled
   *      AND kill_switch désarmé. → toujours scannés, indépendamment de l'env.
   *   2. Si aucun portfolio DB et env STRATEGY_MODE=top_gainers (legacy global),
   *      on retombe sur le mode env-only.
   *
   * Le toggle UI bascule strategy_mode en DB → effet au cycle suivant, sans
   * redeploy Fly.
   */
  async runScanner(): Promise<void> {
    this.lastTickAt = new Date();
    try {
      await this.runScannerInner();
    } catch (e) {
      this.logger.error(`[top-gainers] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Activation globale via env STRATEGY_MODE=top_gainers — flag legacy
   * conservé pour back-compat. La source de vérité est désormais
   * `lisa_session_configs.strategy_mode='gainers'` (P7).
   */
  isStrategyActive(): boolean {
    return this.config.get<string>('STRATEGY_MODE') === 'top_gainers';
  }

  private async runScannerInner(): Promise<void> {
    this.recordCycleStart();
    // P19v (30/04/2026 09:00 UTC) — SCANNER_PAUSE feature flag.
    // Émergency kill-switch sans deploy : `flyctl secrets set SCANNER_PAUSE=true`.
    // Pause le scanner cron + les calls EODHD screener associés. Permet d'éponger
    // une saturation quota sans toucher au code. Reset après 00:00 UTC = unset
    // ou false.
    const scannerPausedEnv = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';

    // PR #257 — Auto-throttle quota EODHD : pause scanner à 85% (cf
    // THROTTLE_THRESHOLDS.scanner). Bug observé prod 06/05/2026 08:30 UTC
    // où cron 1 min consommait ~22k calls/h → quota 100k/100k atteint en
    // ~4.5h, blocage authoritative complet (positions ne pouvaient plus
    // fermer faute de prix live).
    //
    // EodhdQuotaService.getStatus().throttle.scannerPaused devient true
    // quand auth.apiRequests / dailyRateLimit >= 0.85. Revient à false
    // automatiquement après reset minuit GMT (auth refresh 60s).
    const quotaStatus = this.quotaService.getStatus();
    const scannerPausedQuota = quotaStatus.throttle.scannerPaused;
    if (scannerPausedEnv || scannerPausedQuota) {
      const reason = scannerPausedEnv
        ? 'env SCANNER_PAUSE=true'
        : `auto-throttle quota=${(quotaStatus.authoritative.apiRequests / Math.max(1, quotaStatus.authoritative.dailyRateLimit) * 100).toFixed(1)}% ≥ 85%`;
      this.logger.log(`[top-gainers] paused — ${reason} — cycle skipped`);
      this.recordEarlyReturn('scanner_paused');
      return;
    }

    // P7 — Priorité DB : portfolios en strategy_mode='gainers' (toggle UI).
    const { data: dbConfigs, error: dbErr } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id')
      .eq('strategy_mode', 'gainers')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);
    if (dbErr) {
      this.logger.error(`[top-gainers] fetch configs (db) failed: ${dbErr.message}`);
      this.recordEarlyReturn('configs_fetch_error', dbErr.message);
      return;
    }

    let configs = dbConfigs ?? [];

    // Fallback env legacy : si aucun portfolio DB et env est set, on scanne
    // tous les portfolios autopilot-enabled (back-compat avec déploiements
    // pré-P7 qui utilisaient uniquement env STRATEGY_MODE).
    if (configs.length === 0 && this.isStrategyActive()) {
      const { data: envConfigs, error: envErr } = await this.supabase
        .getClient()
        .from('lisa_session_configs')
        .select('user_id, portfolio_id')
        .eq('autopilot_enabled', true)
        .eq('kill_switch_active', false);
      if (envErr) {
        this.logger.error(`[top-gainers] fetch configs (env fallback) failed: ${envErr.message}`);
        this.recordEarlyReturn('configs_fetch_error', envErr.message);
        return;
      }
      configs = envConfigs ?? [];
      if (configs.length > 0) {
        this.logger.log(
          `[top-gainers] using env STRATEGY_MODE fallback (${configs.length} portfolios)`,
        );
      }
    }

    if (configs.length === 0) {
      this.logger.warn(
        '[top-gainers] no active portfolio with strategy_mode=gainers AND autopilot_enabled=true — scanner cycle skipped. ' +
        'Activate via POST /lisa/mode/:portfolioId {mode:"gainers"} or set STRATEGY_MODE=top_gainers env.',
      );
      this.recordEarlyReturn('no_active_portfolio');

      // PR6.6.1 — Shadow run est pipeline-agnostic (ADR-005 §5 Step 9).
      // Même sans portfolio actif, on persiste les shadow signals pour valider
      // le pipeline V1 (BLOC 1 enrichi + crypto Binance + path_eff réel).
      // Sans ce bypass, aucun signal n'est persisté tant qu'aucun portfolio
      // n'est en strategy_mode='gainers' — ce qui bloque la Phase 4 bascule.
      if (this.shadowRun.isShadowEnabled()) {
        try {
          const candidates = await this.fetchAllCandidates();
          if (candidates.length > 0) {
            const top = selectTopGainers(candidates, 3);
            await this.persistShadowSignalsBatch(candidates, top);
            this.logger.log(
              `[top-gainers] shadow-only: ${candidates.length} scanned → ${top.length} top, persisted to gainers_v1_shadow_signals`,
            );
          }
        } catch (e) {
          this.logger.warn(`[top-gainers] shadow-only persist failed: ${String(e).slice(0, 200)}`);
        }
      }
      return;
    }

    // Fetch global candidates UNE SEULE fois (partagé entre tous les portfolios)
    const candidates = await this.fetchAllCandidates();
    if (candidates.length === 0) {
      this.logger.warn('[top-gainers] 0 candidate fetched — skip cycle');
      this.recordEarlyReturn('no_candidates_fetched');
      return;
    }

    // PR #246 — Universe filter DÉPLACÉ dans scanPortfolio (avant selectTopGainers).
    // Bug observé 04/05/2026 23:43 UTC : `selectTopGainers(candidates, 10)` global
    // retournait les 10 meilleurs scores → souvent 100% Asia pendant la session
    // asiatique. Puis le filtre universe per-portfolio (`top.filter(universeAsia)`)
    // les éliminait tous → universe filter 10→0 → 0 trade ouvert.
    // Fix : on conserve le selectTopGainers global UNIQUEMENT pour le shadow run
    // et le persistLog (pipeline-agnostic, audit). Le scan par portfolio reçoit
    // la liste COMPLÈTE des candidats et applique son propre filtre universe puis
    // selectTopGainers sur la liste filtrée.
    const TOP_POOL_SIZE = 10;
    const universalTop = selectTopGainers(candidates, TOP_POOL_SIZE);
    this.recordTopSelected(universalTop.length);
    this.logger.log(
      `[top-gainers] ${candidates.length} scanned → ${universalTop.length} universal top (pool ${TOP_POOL_SIZE}): ${universalTop.slice(0, 5).map((t) => `${t.symbol}(${t.assetClass},${t.changePct.toFixed(1)}%,score=${t.score})`).join(', ')}${universalTop.length > 5 ? '…' : ''}`,
    );

    // PR6.3 — Shadow run wiring : pipeline-agnostic, utilise le top universal.
    await this.persistShadowSignalsBatch(candidates, universalTop);

    // Persist log entries pour les top universels (audit cross-portfolio)
    await this.persistLog(candidates, universalTop);

    if (candidates.length === 0) {
      this.recordEarlyReturn('candidates_fetched_but_none_selected');
      return;
    }

    // P9-UX — Pour chaque portfolio, gate par per-portfolio cycle puis scan.
    // PR #246 — On passe TOUS les candidats (universe filter + selectTopGainers
    // appliqués per-portfolio dans scanPortfolio).
    const now = Date.now();
    for (const cfg of configs) {
      const portfolioId = cfg.portfolio_id as string;
      try {
        const cycleMin = await this.getCycleMinutes(portfolioId);
        const lastScan = this.lastScanByPortfolio.get(portfolioId) ?? 0;
        if (lastScan > 0 && now - lastScan < cycleMin * 60_000) {
          // Pas encore l'heure pour ce portfolio
          continue;
        }
        this.lastScanByPortfolio.set(portfolioId, now);
        await this.scanPortfolio(cfg.user_id as string, portfolioId, candidates);
      } catch (e) {
        this.logger.warn(
          `[top-gainers] portfolio ${portfolioId.slice(0, 8)} failed: ${String(e).slice(0, 120)}`,
        );
      }
    }
    this.recordCycleComplete(true);
  }

  /**
   * PR6.3+PR6.4 — Persiste chaque candidat scanné dans gainers_v1_shadow_signals
   * quand GAINERS_V1_SHADOW=true.
   *
   * PR6.4 enrichment :
   *   - enrichShadowCandidate : ATR(14) + EMA50/200 from ohlcv_cache_daily +
   *     persistenceScore from mtfPersistence (vraie analyse multi-TF)
   *   - Run BLOC 1 réel via GainersBloc1Service.process(...) avec
   *     SHADOW_BLOC1_CONFIG (skipNullFields=true pour tolérer crypto sans
   *     ohlcv_cache_daily)
   *   - Persist real decision + rejectReason + composite score V1
   *   - legacyDecision = top-N (pour audit divergence)
   *
   * Performance : 1 enrich + 1 INSERT par candidat (≤215 / cycle 15min).
   * Sequential async pour limiter rate-limit (mtfPersistence cache interne).
   * Erreurs individuelles loggées en warn, n'arrêtent pas le batch.
   *
   * Out of scope (PR6.5) : BLOC 2 spread proxy + BLOC 3 entry trigger
   * (nécessitent fetch candles 1h + 1m, +860 EODHD calls/cycle).
   */
  private async persistShadowSignalsBatch(
    candidates: TopGainerCandidate[],
    top: ReturnType<typeof selectTopGainers>,
  ): Promise<void> {
    if (!this.shadowRun.isShadowEnabled()) return;
    const topSymbolsSet = new Set(top.map((t) => t.symbol.toUpperCase()));
    const supabaseClient = this.supabase.getClient();
    let success = 0;
    let acceptCount = 0;
    let rejectCount = 0;
    let failures = 0;

    for (const c of candidates) {
      try {
        // PR6.4 : enrich BLOC 1 réel
        // PR6.6 : enrich crypto via Binance + pathEff réel via mtfPersistence
        // PR6.6.5 : SHADOW_BLOC1_FULL_CONFIG tolère null sur prefilter ET trend filter
        // (cache OHLCV partiel equity, fetch Binance flaky crypto). Prod inchangée.
        const enriched = await enrichShadowCandidate(c, supabaseClient, this.mtfPersistence, this.binanceMarket);
        const bloc1Result = this.bloc1.evaluate(enriched.raw, SHADOW_BLOC1_FULL_CONFIG);

        const isTopLegacy = topSymbolsSet.has(c.symbol.toUpperCase());
        const legacyDecision: 'ACCEPT' | 'REJECT' = isTopLegacy ? 'ACCEPT' : 'REJECT';

        await this.shadowRun.persistShadowSignal({
          raw: enriched.raw,
          compositeScore: bloc1Result.compositeScore,
          decision: bloc1Result.decision,
          rejectReason: bloc1Result.rejectReason,
          spreadProxy: null, // PR6.7 BLOC 2
          spreadProxySource: null,
          trendFilter: bloc1Result.trendFilter,
          rvolIntraday: null,
          entrySignal: null, // PR6.5 BLOC 3
          bloc3Diagnostics: null,
        }, legacyDecision, enriched.pathEff);

        if (bloc1Result.decision === 'ACCEPT') acceptCount++;
        else rejectCount++;
        success++;
      } catch (e) {
        failures++;
        if (failures <= 3) {
          this.logger.warn(`[shadow] persist ${c.symbol} failed: ${String(e).slice(0, 80)}`);
        }
      }
    }
    this.logger.log(`[shadow] persisted ${success} signals (V1: ${acceptCount} ACCEPT, ${rejectCount} REJECT, ${failures} failures) — enrichi BLOC 1 réel`);
  }

  /**
   * P18d — Charge (avec cache 60s) les fenêtres de session EU depuis
   * `watchlist_universe`. Si la query échoue, fallback sur l'enveloppe
   * conservatrice [07:00, 17:00] UTC qui couvre CAC40 + DAX40 + FTSE100.
   */
  private async loadEuSessionWindows(): Promise<Array<{ name: string; openUtc: string; closeUtc: string }>> {
    const cached = this.euSessionsCache;
    if (cached && Date.now() - cached.asOf < this.EU_SESSIONS_CACHE_TTL_MS) {
      return cached.windows;
    }
    const fallback = EU_WATCHLIST_NAMES.map((name) => ({
      name,
      openUtc: EU_FALLBACK_OPEN_UTC,
      closeUtc: EU_FALLBACK_CLOSE_UTC,
    }));
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('watchlist_universe')
        .select('name, session_open_utc, session_close_utc')
        .in('name', EU_WATCHLIST_NAMES);
      if (error || !data || data.length === 0) {
        this.logger.warn(
          `[top-gainers] watchlist_universe EU fetch failed (${error?.message ?? 'empty'}) — fallback ${EU_FALLBACK_OPEN_UTC}-${EU_FALLBACK_CLOSE_UTC} UTC`,
        );
        this.euSessionsCache = { asOf: Date.now(), windows: fallback };
        return fallback;
      }
      const windows = data
        .filter((r) => r.session_open_utc && r.session_close_utc)
        .map((r) => ({
          name: r.name as string,
          openUtc: String(r.session_open_utc),
          closeUtc: String(r.session_close_utc),
        }));
      this.euSessionsCache = { asOf: Date.now(), windows: windows.length > 0 ? windows : fallback };
      return this.euSessionsCache.windows;
    } catch (e) {
      this.logger.warn(`[top-gainers] EU sessions DB query error — fallback: ${String(e).slice(0, 120)}`);
      this.euSessionsCache = { asOf: Date.now(), windows: fallback };
      return fallback;
    }
  }

  /**
   * P18d — Renvoie la liste des watchlists EU actives (cac40/dax40/ftse100)
   * dont la fenêtre session_open_utc/session_close_utc inclut `now`.
   * Liste vide ⇒ EU fermé, scan EU à skip.
   */
  async getActiveEuWatchlists(now: Date = new Date()): Promise<string[]> {
    const windows = await this.loadEuSessionWindows();
    return windows
      .filter((w) => isWithinSession(now, { openUtc: w.openUtc, closeUtc: w.closeUtc }))
      .map((w) => w.name);
  }

  /**
   * Fetch candidates depuis toutes les sources : EODHD multi-exchange + Binance crypto.
   * Yahoo / Coinbase / Kraken / OANDA → deferred PR.
   *
   * P8 — Exposé en public pour l'endpoint /lisa/gainers-persistence-snapshot
   * (le caller filtre top-N + branche le multi-tf service).
   *
   * P18d — Les bourses EU (LSE/XETRA/PA/SW/MI/MC/BME/AS/AMS) ne sont scannées
   * que si au moins 1 watchlist EU (cac40/dax40/ftse100) est en session.
   * Hors heures EU le scan est skip pour économiser EODHD et éviter les 422.
   */
  async fetchAllCandidates(now: Date = new Date()): Promise<TopGainerCandidate[]> {
    // P19v — SCANNER_PAUSE émergency flag bloque aussi la fetch des candidats
    // (utilisée par UI poll /lisa/gainers-persistence-snapshot). Retourne le
    // cache existant ou [] si jamais peuplé.
    const scannerPausedEnv = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';
    // PR #257 — fetchAllCandidates skip aussi sur quota auto-throttle 85%
    // pour économiser les 11 screener calls × N exchanges + tous les intraday
    // calls qui suivraient.
    const scannerPausedQuota = this.quotaService.getStatus().throttle.scannerPaused;
    if (scannerPausedEnv || scannerPausedQuota) {
      this.logger.debug(`[top-gainers] scanner paused (env=${scannerPausedEnv} quota=${scannerPausedQuota}) — fetchAllCandidates returns cache`);
      return this.allCandidatesCache?.candidates ?? [];
    }

    // P19s++ — Cache hit (TTL 15min). Évite N×11 calls EODHD quand l'UI
    // poll /lisa/gainers-persistence-snapshot toutes les 60s.
    if (
      this.allCandidatesCache
      && now.getTime() - this.allCandidatesCache.asOf < this.ALL_CANDIDATES_CACHE_TTL_MS
    ) {
      this.recordFetchAllCandidates(this.allCandidatesCache.candidates.length, true);
      return this.allCandidatesCache.candidates;
    }
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    const tasks: Promise<TopGainerCandidate[]>[] = [];

    if (apiKey) {
      // Non-EU exchanges always scanned (US 24/7 with after-hours, Asia, Other).
      // P19s+ — log warn on screener failure (was silent .catch(() => [])
      // qui masquait les 0-result silencieux sur LSE/PA/TSE/HK/AU avant le
      // fix UPPERCASE + change_p).
      for (const ex of NON_EU_EXCHANGES) {
        tasks.push(
          this.fetchEodhdScreener(ex, apiKey)
            .then((rows) => {
              this.recordExchangeResult(ex, rows.length);
              return rows;
            })
            .catch((e) => {
              const msg = e?.message ?? String(e);
              this.logger.warn(`[top-gainers] ${ex} failed: ${msg}`);
              this.recordExchangeResult(ex, 0, msg);
              this.recordEarlyReturn('upstream_provider_error', `${ex}: ${msg.slice(0, 80)}`);
              return [];
            }),
        );
      }

      // EU exchanges gated on session windows.
      const activeEu = await this.getActiveEuWatchlists(now);
      if (activeEu.length > 0) {
        this.logger.log(
          `[top-gainers] EU session active (${activeEu.join('/')}), scanning ${EU_EXCHANGES.length} exchanges: ${EU_EXCHANGES.join(',')}`,
        );
        for (const ex of EU_EXCHANGES) {
          tasks.push(
            this.fetchEodhdScreener(ex, apiKey).catch((e) => {
              this.logger.warn(`[top-gainers] ${ex} failed: ${e?.message ?? String(e)}`);
              return [];
            }),
          );
        }
      } else {
        this.logger.log(
          `[top-gainers] EU sessions closed — skipping ${EU_EXCHANGES.length} exchanges (${EU_EXCHANGES.join(',')})`,
        );
      }
    } else {
      this.logger.warn('[top-gainers] EODHD_API_KEY missing — skip equity scan');
    }

    // Crypto via Binance
    tasks.push(
      this.fetchBinanceGainers()
        .then((rows) => {
          this.recordExchangeResult('BINANCE', rows.length);
          return rows;
        })
        .catch((e) => {
          const msg = e?.message ?? String(e);
          this.recordExchangeResult('BINANCE', 0, msg);
          return [];
        }),
    );

    const results = await Promise.allSettled(tasks);
    const merged = results
      .filter((r): r is PromiseFulfilledResult<TopGainerCandidate[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    // P18d — Dédup par (symbol, exchange) au cas où EODHD répondrait avec le
    // même ticker sur 2 codes d'exchange (AS/AMS, MC/BME) ou si plusieurs
    // sources retourneraient le même symbole.
    const seen = new Set<string>();
    const deduped = merged.filter((c) => {
      const key = `${c.symbol}@${c.exchange ?? 'unknown'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // P19s++ — Cache fill (TTL 15min). Permet aux UI polls et au cron scanner
    // de partager la même fetch sans re-frapper EODHD.
    this.allCandidatesCache = { candidates: deduped, asOf: now.getTime() };
    this.recordFetchAllCandidates(deduped.length, false);
    return deduped;
  }

  /**
   * EODHD Screener API : top gainers par exchange.
   *
   * P18c — fix HTTP 422 sur tous les marchés. Causes :
   *   1) `exchange` doit être DANS le tableau `filters` (lowercase), pas en
   *      query param séparé.
   *   2) `change_p` n'est pas un filter field valide → `refund_1d_p`.
   *   3) `close` n'est pas un filter field valide → `adjusted_close`.
   *   4) Le sort key doit aussi être `refund_1d_p.desc`.
   *
   * P19a — Filtres restaurés à leur valeur permissive d'origine. La qualité
   * est traitée DOWNSTREAM via le fallback Yahoo Finance dans
   * `MultiTimeframePersistenceService` (zéro opportunité mondiale ratée).
   *
   * P19s+ (30/04/2026) — Fix critique multi-exchange. Audit prod sur
   * gainers_persistence_log (24h) : 21 299 candidats, 105 tickers uniques,
   * 100 % US (0 ticker non-US, aucun suffixe `.PA`/`.L`/`.DE`/`.HK`/`.T`/...).
   *
   * Root cause :
   *   1) `exchange` était passé en lowercase. EODHD screener exige UPPERCASE
   *      pour tous codes autres que 'us'. Les requêtes LSE/PA/TSE/HK/AU
   *      renvoyaient 0 silencieusement (masqué par `.catch(() => [])`).
   *   2) Le filtre `refund_1d_p` n'existe que côté US. Les exchanges EU/Asie
   *      utilisent `change_p`. Donc même avec UPPERCASE fixé, le filtre
   *      EODHD éliminerait 100 % des résultats non-US.
   *
   * Doc : https://eodhd.com/financial-apis/stock-market-screener-api
   */
  private async fetchEodhdScreener(exchange: string, apiKey: string): Promise<TopGainerCandidate[]> {
    const exUpper = exchange.toUpperCase();
    const isUs = exUpper === 'US';
    // P19s++ (30/04/2026 08:10 UTC HOTFIX) — Revert `change_p` filter qui
    // causait HTTP 422 sur LSE/MC/KO/HK :
    //     {"errors":{"filters.1.field":["The selected filters.1.field is invalid."]}}
    // EODHD doc officielle confirme : `change_p` n'est PAS un valid filter
    // field — c'est le nom dans la RÉPONSE seulement. Les seuls valid filter
    // fields pour 1d return sont `refund_1d_p`, `refund_5d_p`, `refund_ytd_p`.
    // Mais `refund_1d_p` ne semble pas avoir de données pour la plupart des
    // marchés non-US.
    //
    // Stratégie multi-exchange :
    //   - US      : keep `refund_1d_p > 3` filter (validé prod)
    //   - non-US  : DROP le filter 1d return entirely. Filtre seulement par
    //               exchange + market_capitalization. Post-filter changePct
    //               appliqué client-side via mapEodhdRow + filter ci-dessous
    //               (la valeur change_p existe dans la RÉPONSE, juste pas
    //               comme filter input).
    const filtersList: Array<[string, string, string | number]> = [
      ['exchange', '=', exUpper],
    ];
    if (isUs) {
      filtersList.push(['refund_1d_p', '>', 3]);
    }
    filtersList.push(['market_capitalization', '>', 50_000_000]);
    const filters = encodeURIComponent(JSON.stringify(filtersList));
    const url = `https://eodhd.com/api/screener?api_token=${encodeURIComponent(apiKey)}&filters=${filters}&limit=100&offset=0&fmt=json`;
    this.logger.debug(`[top-gainers] EODHD screener exchange=${exUpper} filters=${filtersList.length}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        // P18c — log le body pour diagnostic (422 = champ filter invalide,
        // 401 = token expiré, 403 = plan insuffisant). Tronqué à 200 char.
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `[top-gainers] eodhd ${exUpper} HTTP ${res.status} — body: ${body.slice(0, 200)}`,
        );
        return [];
      }
      const json = await res.json() as { data?: EodhdScreenerRow[] } | EodhdScreenerRow[];
      const rows: EodhdScreenerRow[] = Array.isArray(json) ? json : (json.data ?? []);
      let mapped = rows
        .map((r) => this.mapEodhdRow(r, exUpper))
        .filter((c): c is TopGainerCandidate => c !== null);
      // P19s++ — Post-filter client-side pour non-US (filter serveur dropped).
      // Garde rows changePct > 3 cohérent avec filtre serveur côté US.
      if (!isUs) {
        mapped = mapped.filter((c) => (c.changePct ?? 0) > 3);
      }
      return mapped;
    } catch (e) {
      this.logger.debug(`[top-gainers] eodhd ${exUpper} fetch error: ${String(e).slice(0, 120)}`);
      return [];
    }
  }

  /**
   * PR #234 (PR6.9) — Append exchange suffix to symbol if not already present.
   * EODHD screener parfois retourne `r.code` SANS suffix (ex: `005930` au lieu
   * de `005930.KO`), ce qui cause downstream HTTP 404 sur intraday/EOD endpoints
   * qui exigent le format complet `CODE.EXCHANGE` (cf vendor/eodhd-claude-skills
   * §symbol-format).
   *
   * Mapping exchange code → suffix :
   *   US → .US, KO (KOSPI) → .KO, KQ (KOSDAQ) → .KQ
   *   SHG (Shanghai) → .SHG, SHE (Shenzhen) → .SHE
   *   NSE (India) → .NSE, BSE (India Bombay) → .BSE
   *   T (Tokyo) → .TSE, HK (Hong Kong) → .HK, AU → .AU, TO (Toronto) → .TO
   *
   * Idempotent : si symbol contient déjà un dot, retourne tel quel.
   */
  private ensureExchangeSuffix(symbol: string, exchange: string): string {
    if (symbol.includes('.')) return symbol;
    const ex = exchange.toUpperCase();
    // Mapping per CLAUDE.md §EODHD + vendor/eodhd-claude-skills/skills/eodhd-api/references/general/symbol-format.md
    const suffix = ex === 'T' ? 'TSE' : ex; // T → TSE per EODHD
    return `${symbol}.${suffix}`;
  }

  private mapEodhdRow(r: EodhdScreenerRow, exchange: string): TopGainerCandidate | null {
    const rawCode = r.code;
    if (!rawCode) return null;
    // PR #234 : ensure suffix for downstream EODHD intraday/EOD fetches
    const symbol = this.ensureExchangeSuffix(rawCode, exchange);
    // P18c — accepter les 2 conventions (filter form vs response form), la doc
    // EODHD ne documente pas explicitement le schéma de réponse du screener.
    const close = num(r.adjusted_close ?? r.last_price);
    const high = num(r.high_price ?? r.high) || close;
    const changePct = num(r.refund_1d_p ?? r.change_p);
    const volume = num(r.volume ?? r.avgvol_1d);
    const avgVol50d = num(r.avgvol_50d ?? r.avgvol_200d);
    const marketCap = num(r.market_capitalization ?? r.market_cap);
    if (!Number.isFinite(close) || close <= 0) return null;
    // P19o.4 — Post-filter price >= 2 (le filtre `adjusted_close > 2` côté
    // screener n'est pas documenté comme valid filter field — risk silently
    // ignored. On le déplace ici pour garantir l'effet : exclut les penny stocks.
    if (close < 2) return null;
    return {
      symbol,
      exchange,
      // PR6.6.2 — pré-classifie pour que les raw candidates exposent assetClass
      // correctement (consommé par persistShadowSignalsBatch sans passer par
      // selectTopGainers qui re-calcule).
      assetClass: detectAssetClass(symbol, exchange, marketCap),
      close,
      high,
      changePct,
      volume,
      avgVol50d,
      marketCap,
    };
  }

  /**
   * Binance crypto top gainers via ticker24hr existant
   * (BinanceMarketService.getTicker24h already wired).
   */
  private async fetchBinanceGainers(): Promise<TopGainerCandidate[]> {
    const out: TopGainerCandidate[] = [];
    for (const pair of CRYPTO_PAIRS) {
      try {
        const t = await this.binanceMarket.getTicker24h(pair);
        if (!t) continue;
        out.push({
          symbol: pair,
          exchange: 'BINANCE',
          // PR6.6.2 — set assetClass upstream (whitelisted CRYPTO_PAIRS = majors).
          // Sans ça, persistShadowSignalsBatch tombait en fallback equity sur les
          // 10 paires Binance et fail LIQUIDITY_FLOOR à tort.
          assetClass: 'crypto_major',
          close: t.lastPrice,
          high: t.high ?? t.lastPrice,
          changePct: t.priceChangePct,
          volume: t.quoteVolume ?? 0,
          avgVol50d: t.quoteVolume ?? 0, // PR6.6.3 — fallback sur 24h volume (pas de 50d Binance ticker24hr)
          // PR6.6.3 — marketCap depuis table CRYPTO_MARKET_CAP_USD (Binance ne renvoie
          // pas market cap, et BLOC 1 V1 gate MARKET_CAP_MIN check ce field).
          marketCap: CRYPTO_MARKET_CAP_USD[pair] ?? 0,
        });
      } catch (e) {
        this.logger.debug(`[top-gainers] binance ${pair} error: ${String(e).slice(0, 80)}`);
      }
    }
    return out;
  }

  /**
   * P19x.4 (29/04/2026) — Watchdog expectancy strategy Gainers.
   *
   * Spec user (29/04 02:00 UTC) :
   *   E = (hit_rate × avg_win) − ((1−hit_rate) × avg_loss)
   *   Si E<0 après ≥ 10 trades fermés → skip opens + alerte UI
   *
   * Calcul sur les 10 derniers trades fermés du portfolio (toutes sources
   * confondues : gainers scanner + Lisa proposals). Le watchdog soft-disable
   * le SCANNER GAINERS uniquement (skip opens), ne touche pas au kill_switch
   * global qui désactive aussi Lisa LLM et mechanical-trading.
   *
   * Pourquoi soft-disable :
   *   - User spec demande "kill-switch auto Gainers + alerte UI"
   *   - Setting kill_switch_active=true sur lisa_session_configs filtre out
   *     le portfolio de runScannerInner (line 376) → scanner skip
   *   - Mais ça désactive AUSSI Lisa LLM cycle. Trop large.
   *   - Approach : on log un decision_log d'alerte + on skip cette open phase
   *     uniquement (return early). Le scanner réévalue au prochain cycle.
   *   - Si user veut hard-disable : flip kill_switch via UI + voit l'alerte
   *     UI.
   *
   * Returns true if expectancy is too negative AND we should skip opens.
   */
  private async checkExpectancyWatchdog(portfolioId: string): Promise<boolean> {
    try {
      const { data: closedRecent } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('realized_pnl_usd, status, exit_timestamp')
        .eq('portfolio_id', portfolioId)
        .neq('status', 'open')
        .order('exit_timestamp', { ascending: false })
        .limit(10);

      const trades = (closedRecent ?? []).filter(
        (p) => p.realized_pnl_usd != null && Number.isFinite(Number(p.realized_pnl_usd)),
      );
      if (trades.length < 10) return false; // pas assez de data — skip watchdog

      const wins = trades.filter((p) => Number(p.realized_pnl_usd) > 0);
      const losses = trades.filter((p) => Number(p.realized_pnl_usd) < 0);
      const hitRate = wins.length / trades.length;
      const avgWin = wins.length > 0
        ? wins.reduce((s, p) => s + Number(p.realized_pnl_usd), 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? Math.abs(losses.reduce((s, p) => s + Number(p.realized_pnl_usd), 0) / losses.length)
        : 0;
      const expectancy = hitRate * avgWin - (1 - hitRate) * avgLoss;

      if (expectancy < 0) {
        this.logger.warn(
          `[top-gainers:watchdog] portfolio ${portfolioId.slice(0, 8)} expectancy=$${expectancy.toFixed(2)} ` +
          `< 0 (hit_rate=${(hitRate * 100).toFixed(0)}%, avg_win=$${avgWin.toFixed(2)}, ` +
          `avg_loss=$${avgLoss.toFixed(2)}, n=${trades.length}) → skip opens this cycle`,
        );
        await this.decisionLog.append({
          portfolioId,
          kind: 'gainers_expectancy_negative_watchdog',
          summary: `[GAINERS WATCHDOG] Expectancy=$${expectancy.toFixed(2)} < 0 sur 10 derniers trades. Skip opens.`,
          rationale:
            `Hit rate ${(hitRate * 100).toFixed(0)}% × avg_win $${avgWin.toFixed(2)} − ` +
            `(1−${hitRate.toFixed(2)}) × avg_loss $${avgLoss.toFixed(2)} = $${expectancy.toFixed(2)}. ` +
            `Stratégie en perte attendue. UI alerte. User : check P19x.1 MIN_NET_PROFIT, ` +
            `P19x.2 TP/SL config, P19x.3 cooldown ; ou flip kill_switch_active=true ` +
            `manuellement pour hard-stop scanner.`,
          payload: {
            expectancy_usd: expectancy.toFixed(4),
            hit_rate: hitRate.toFixed(4),
            avg_win_usd: avgWin.toFixed(4),
            avg_loss_usd: avgLoss.toFixed(4),
            trades_count: trades.length,
            wins_count: wins.length,
            losses_count: losses.length,
          },
          triggeredBy: 'autopilot_cron',
        }).catch(() => { /* non-bloquant */ });
        return true;
      }
      return false;
    } catch (e) {
      // Failure-tolerant : si query fail (mock partiel test, schema), on
      // skip le watchdog (cycle continue normalement).
      this.logger.debug(`[top-gainers:watchdog] check failed: ${String(e).slice(0, 100)}`);
      return false;
    }
  }

  private async scanPortfolio(
    userId: string,
    portfolioId: string,
    candidates: TopGainerCandidate[],
  ): Promise<void> {
    // PR #255 — Watchdog expectancy DÉSACTIVÉ en mode gainers (déterministe).
    //
    // Le watchdog (P19x.4) skip tout le cycle si expectancy < 0 sur les
    // 10 derniers trades fermés. Pensé à l'origine pour Lisa LLM avec thèses
    // narratives variées. En mode gainers déterministe :
    //   - Le scanner a déjà 5+ gates structurels (persistence, path, cooldown,
    //     P20 fees-aware, capital) qui valident chaque setup avant ouverture
    //   - Une cascade de fermetures techniques (ex: P4.1 pré-#254) peut
    //     dégrader artificiellement l'expectancy → deadlock structurel
    //     (le watchdog ne peut plus s'auto-corriger sans nouveaux trades,
    //     mais il bloque ces nouveaux trades)
    //   - Cas vu prod 06/05/2026 05:53 UTC : 5 closes P4.1 → expectancy
    //     -$0.35 → watchdog skip permanent jusqu'à reset manuel
    //
    // Garde-fous structurels restants en mode gainers :
    //   - SL individuel par position (default 1%)
    //   - TP individuel par position (default 1.5-2%)
    //   - P20 fees-aware target (rejette les setups où fees > buffer × gain)
    //   - Capital exposure gate (max budget = capital × (1 - cashReserve))
    //   - Persistence + path + cooldown gates
    //
    // Si jamais on veut le réactiver (ex: garde-fou strict en cas de
    // strategy mal calibrée), on peut le re-câbler via env
    // `GAINERS_EXPECTANCY_WATCHDOG_ENABLED=true`. Pour l'instant : off.
    const watchdogEnabled = (this.config.get<string>('GAINERS_EXPECTANCY_WATCHDOG_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (watchdogEnabled) {
      const expectancyNegative = await this.checkExpectancyWatchdog(portfolioId);
      if (expectancyNegative) {
        return; // skip cycle pour ce portfolio
      }
    }

    // PR Hardcodes-fix — Charge config complète gainers pour ce portfolio :
    // min persistence + path efficiency + TP/SL + capital + sizing + cooldown.
    // Migration 0115 expose toutes les colonnes gainers_*. Fallbacks définis
    // au top du fichier (FALLBACK_*) si row absent ou colonne non encore migrée.
    const { data: cfgRow } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('capital_usd, gainers_min_persistence_score, gainers_min_path_efficiency, gainers_default_tp_pct, gainers_default_sl_pct, gainers_max_open_positions, gainers_max_per_cycle, gainers_position_pct, gainers_cash_reserve_pct, gainers_cooldown_minutes, gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto, gainers_p_win_gate_enabled, gainers_min_p_win, gainers_rotation_stagnant_min_age_min, gainers_rotation_min_path_efficiency, gainers_session_filter_enabled, gainers_force_close_before_close_enabled, gainers_force_close_offset_min, gainers_post_sl_cooldown_min, gainers_asia_strictness_boost')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const minScore = this.resolveMinPersistenceScore(
      cfgRow?.gainers_min_persistence_score != null
        ? Number(cfgRow.gainers_min_persistence_score)
        : null,
    );
    // P9-UX ADDENDUM — Path efficiency gate (null désactive)
    const minPathEff = cfgRow?.gainers_min_path_efficiency != null
      ? Math.max(0, Math.min(1, Number(cfgRow.gainers_min_path_efficiency)))
      : null;
    // P19x.2 — TP/SL configurables par portfolio. Defaults DB = 1.5% / 1.0%
    // (migration 0093). Si row absent (portfolio sans config), fallback hardcoded
    // aux mêmes defaults.
    const tpPct = cfgRow?.gainers_default_tp_pct != null
      ? Math.max(0.1, Math.min(50, Number(cfgRow.gainers_default_tp_pct)))
      : 1.5;
    const slPct = cfgRow?.gainers_default_sl_pct != null
      ? Math.max(0.1, Math.min(20, Number(cfgRow.gainers_default_sl_pct)))
      : 1.0;

    // PR Hardcodes-fix — sizing & capacity dérivés de la config user
    // PR Hotfix — la colonne DB est `capital_usd` (TEXT), pas `capital_simulation`.
    // En PR #2 j'avais mis `capital_simulation` par erreur → scanner tombait
    // toujours sur FALLBACK_CAPITAL_USD ($10k). Le UI hook a un fallback
    // `capital_simulation ?? capital_usd` qui masquait le bug côté affichage.
    const capitalUsd = cfgRow?.capital_usd != null
      ? Math.max(100, Number(cfgRow.capital_usd))
      : FALLBACK_CAPITAL_USD;
    const maxOpen = cfgRow?.gainers_max_open_positions != null
      ? Math.max(1, Math.min(20, Number(cfgRow.gainers_max_open_positions)))
      : FALLBACK_MAX_OPEN;
    const maxPerCycle = cfgRow?.gainers_max_per_cycle != null
      ? Math.max(1, Math.min(10, Number(cfgRow.gainers_max_per_cycle)))
      : FALLBACK_MAX_PER_CYCLE;
    const positionPct = cfgRow?.gainers_position_pct != null
      ? Math.max(1, Math.min(100, Number(cfgRow.gainers_position_pct)))
      : FALLBACK_POSITION_PCT;
    const cashReservePct = cfgRow?.gainers_cash_reserve_pct != null
      ? Math.max(0, Math.min(50, Number(cfgRow.gainers_cash_reserve_pct)))
      : FALLBACK_CASH_RESERVE_PCT;
    const cooldownMinutes = cfgRow?.gainers_cooldown_minutes != null
      ? Math.max(0, Math.min(240, Number(cfgRow.gainers_cooldown_minutes)))
      : FALLBACK_COOLDOWN_MIN;
    const positionNotionalUsd = capitalUsd * (positionPct / 100);
    // PR #262/#268 — Capital rotation : seuil "stagnante" configurable user (3-480 min, default 90)
    const rotationStagnantMinAgeMin = cfgRow?.gainers_rotation_stagnant_min_age_min != null
      ? Math.max(3, Math.min(480, Number(cfgRow.gainers_rotation_stagnant_min_age_min)))
      : 90;
    // PR #269 — seuil pathEff rotation configurable. null = désactive le gate. Default 0.5.
    const rotationMinPathEfficiency = cfgRow?.gainers_rotation_min_path_efficiency != null
      ? Math.max(0, Math.min(1, Number(cfgRow.gainers_rotation_min_path_efficiency)))
      : 0.5;
    // PR #270 — Post-SL cooldown : ban un symbole pendant N min après un closed_stop.
    // Distinct du cooldown global qui s'applique à tout outcome (TP, SL, manuel).
    const postSlCooldownMin = cfgRow?.gainers_post_sl_cooldown_min != null
      ? Math.max(0, Math.min(1440, Number(cfgRow.gainers_post_sl_cooldown_min)))
      : 60;
    // PR #271 — Asia strictness boost : booste les gates path_eff et persistence
    // pour les candidats asia_equity uniquement (compense la choppy des small-caps).
    const asiaStrictnessBoost = cfgRow?.gainers_asia_strictness_boost != null
      ? Math.max(0, Math.min(0.5, Number(cfgRow.gainers_asia_strictness_boost)))
      : 0.10;

    // PR #3 + PR #246 — universe toggles per-portfolio appliqués AVANT
    // selectTopGainers. Bug pré-#246 : selectTopGainers global retournait top 10
    // par score (souvent 100% Asia pendant la session asiatique) puis le filtre
    // universe per-portfolio les éliminait tous → universe filter 10→0 → 0 trade.
    // Fix : on filtre la liste COMPLÈTE des candidats par universe AVANT de
    // sélectionner le top, garantissant que chaque portfolio reçoit les
    // meilleurs candidats DANS SON univers configuré.
    const universeUs = cfgRow?.gainers_universe_us !== false;
    const universeEu = cfgRow?.gainers_universe_eu !== false;
    const universeAsia = cfgRow?.gainers_universe_asia !== false;
    const universeCrypto = cfgRow?.gainers_universe_crypto !== false;
    // PR #266 — Session-aware filter : skip un asset class hors horaires bourse.
    // Default false en mémoire (= activé seulement si explicitement set true en DB).
    // En prod, la migration 0123 crée la colonne avec DEFAULT true → activé pour
    // tous les portfolios existants. En test, cfgRow ne contient pas la colonne →
    // sessionFilterEnabled = false → tests restent stables quel que soit l'horaire.
    // Crypto jamais filtré (24/7). Économie EODHD ~30-50%.
    const sessionFilterEnabled = cfgRow?.gainers_session_filter_enabled === true;
    const nowUtc = new Date();
    const usOpen = !sessionFilterEnabled || isMarketOpen('us', nowUtc);
    const euOpen = !sessionFilterEnabled || isMarketOpen('eu', nowUtc);
    const asiaOpen = !sessionFilterEnabled || isMarketOpen('asia', nowUtc);
    if (sessionFilterEnabled) {
      const closedSessions: string[] = [];
      if (universeUs && !usOpen) closedSessions.push('US');
      if (universeEu && !euOpen) closedSessions.push('EU');
      if (universeAsia && !asiaOpen) closedSessions.push('Asia');
      if (closedSessions.length > 0) {
        this.logger.log(
          `[top-gainers] ${portfolioId.slice(0, 8)} session-filter: skip ${closedSessions.join('+')} (markets closed UTC=${nowUtc.toISOString().slice(11, 16)})`,
        );
      }
    }

    // PR #266 — Force-close avant cloche : ferme les positions sur un marché
    // qui s'apprête à fermer (offset T-N min). Évite le gap risk overnight
    // sur stratégie momentum intraday. Crypto jamais affecté. Tourne avant
    // toute logique d'open pour libérer le capital pour les marchés encore
    // actifs (ex: US ouvre 30min après EU close → capital EU close peut
    // alimenter un setup US).
    const forceCloseEnabled = cfgRow?.gainers_force_close_before_close_enabled === true;
    const forceCloseOffsetMin = cfgRow?.gainers_force_close_offset_min != null
      ? Math.max(5, Math.min(120, Number(cfgRow.gainers_force_close_offset_min)))
      : 30;
    if (forceCloseEnabled) {
      await this.runForceCloseBeforeCloseTick(portfolioId, forceCloseOffsetMin, nowUtc);
    }

    // PR #272 — Si force-close est ON et que la session est en T-N min de
    // sa fermeture, on bloque aussi les NEW opens sur cet asset_class. Sans
    // ça, le scanner réouvre immédiatement le même ticker qu'on vient de
    // force-fermer (cas observé 07/05/2026 09:42 — 000783.SHE force-fermée
    // puis réouverte 10 secondes plus tard sur le même cycle).
    const usApproachingClose = forceCloseEnabled && isApproachingClose('us', forceCloseOffsetMin, nowUtc);
    const euApproachingClose = forceCloseEnabled && isApproachingClose('eu', forceCloseOffsetMin, nowUtc);
    const asiaApproachingClose = forceCloseEnabled && isApproachingClose('asia', forceCloseOffsetMin, nowUtc);
    if (usApproachingClose || euApproachingClose || asiaApproachingClose) {
      const blocked: string[] = [];
      if (usApproachingClose) blocked.push('US');
      if (euApproachingClose) blocked.push('EU');
      if (asiaApproachingClose) blocked.push('Asia');
      this.logger.log(
        `[top-gainers] ${portfolioId.slice(0, 8)} approaching-close: skip NEW opens on ${blocked.join('+')} (T-${forceCloseOffsetMin}min, force-close ON)`,
      );
    }

    // PR #267 — Orphan close rétroactif. Détecte les positions ouvertes sur
    // un marché qui est fermé MAINTENANT et dont aucun prix live n'est
    // disponible (source 'fallback*' ou null). Ces positions ne peuvent plus
    // bouger (pas de TP/SL/rotation possible), elles bloquent du capital.
    // Close à entry_price (pnl=0) pour libérer le slot.
    //
    // Complémentaire à #266 force-close-before-close (proactif). Ici on
    // ramasse les zombies déjà bloquées (cas observé 06/05/2026 où 4 positions
    // Asia ouvertes pendant les heures EU restaient gelées toute la journée).
    //
    // Toujours actif en mode gainers (pas de toggle UI — c'est un garde-fou
    // structurel, pas une stratégie). Crypto exclu (24/7).
    await this.runOrphanCloseTick(portfolioId, nowUtc);

    // PR #4 — pWin gate. Désactivé par défaut (gainers_p_win_gate_enabled=false).
    // L'utilisateur active via UI quand le modèle a convergé (≥30 trades fermés
    // + AUC ≥ 0.55). Sinon `probability.fallback=true` → bypass automatique.
    const pWinGateEnabled = cfgRow?.gainers_p_win_gate_enabled === true;
    const minPWin = cfgRow?.gainers_min_p_win != null
      ? Math.max(0, Math.min(1, Number(cfgRow.gainers_min_p_win)))
      : 0.50;

    const filteredCandidates = candidates.filter((c) => {
      // detectAssetClass est appliqué dans selectTopGainers ; on doit le faire
      // ici aussi pour pouvoir filtrer la liste pré-selection.
      const assetClass = detectAssetClass(c.symbol, c.exchange, c.marketCap);
      // PR #266 — combine universe toggle (volonté user) ET session ouverte.
      // PR #272 — exclut aussi si session en T-N min de close (force-close ON).
      if (assetClass === 'us_equity_large' || assetClass === 'us_equity_small_mid') return universeUs && usOpen && !usApproachingClose;
      if (assetClass === 'eu_equity') return universeEu && euOpen && !euApproachingClose;
      if (assetClass === 'asia_equity') return universeAsia && asiaOpen && !asiaApproachingClose;
      if (assetClass === 'crypto_major' || assetClass === 'crypto_alt') return universeCrypto;
      return true; // fx/commodity etc — pas de toggle, accept par default
    });

    // PR Coverage filter — pool de 10 (au lieu de 3) pour buffer.
    // selectTopGainers per-portfolio sur la liste FILTRÉE par universe.
    const TOP_POOL_SIZE_PER_PORTFOLIO = 10;
    const top = selectTopGainers(filteredCandidates, TOP_POOL_SIZE_PER_PORTFOLIO);
    if (top.length === 0) {
      this.logger.log(
        `[top-gainers] ${portfolioId.slice(0, 8)}: 0 candidate after universe filter (us=${universeUs} eu=${universeEu} asia=${universeAsia} crypto=${universeCrypto}, candidates=${candidates.length}, filtered=${filteredCandidates.length})`,
      );
      return;
    }
    this.logger.log(
      `[top-gainers] ${portfolioId.slice(0, 8)}: ${candidates.length}→${filteredCandidates.length} after universe → top ${top.length} (us=${universeUs} eu=${universeEu} asia=${universeAsia} crypto=${universeCrypto})`,
    );

    // P18 — LLM re-ranking (inert when SCANNER_LLM_ROUTER_ENABLED=false)
    const filteredTop = await this.rankCandidates(top);

    // Garde-fou : count current open positions (utilise maxOpen depuis config)
    const { data: openPositions } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol, entry_notional_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const openSymbols = new Set((openPositions ?? []).map((p) => String(p.symbol).toUpperCase()));
    let slotsAvailable = Math.max(0, maxOpen - (openPositions?.length ?? 0));

    // PR #261 — Si slots saturés ET capital rotation enabled, on ne sort pas
    // immédiatement : on continue pour évaluer si un setup A+ peut justifier
    // de fermer une position stagnante. Sinon early-return classique.
    const rotationEnabled = (process.env.GAINERS_CAPITAL_ROTATION_ENABLED ?? 'false').toLowerCase() === 'true';
    if (slotsAvailable === 0 && !rotationEnabled) {
      this.logger.log(`[top-gainers] ${portfolioId.slice(0, 8)}: no slots (${openPositions?.length}/${maxOpen} open)`);
      return;
    }
    if (slotsAvailable === 0 && rotationEnabled) {
      this.logger.log(`[top-gainers] ${portfolioId.slice(0, 8)}: slots saturated (${openPositions?.length}/${maxOpen}) — checking capital rotation for A+ candidates`);
    }

    // PR #251 — GATE CAPITAL GLOBAL (anti over-exposure).
    //
    // Bug observé prod 06/05/2026 06:31 UTC : 3 positions × $4000 = $12k
    // ouvertes sur capital $10k (+$1k cash reserve = $9k déployable).
    // Le scanner respectait `maxOpen=5` mais ignorait totalement le sizing
    // global → 120% du capital alloué, cash reserve violée.
    //
    // Fix : calcule deployedNotional = sum(entry_notional_usd) des positions
    // open. Compare à availableCapital = capital × (1 - cashReserve/100).
    // Avant chaque open, vérifie que (deployedNotional + positionNotional)
    // <= availableCapital. Sinon skip + log.
    //
    // Rejet doux : le scanner ne crash pas, il s'arrête juste d'ouvrir
    // ce cycle. Au prochain cycle, si une position ferme et libère du
    // notional, l'ouverture sera permise.
    const deployedNotional = (openPositions ?? []).reduce(
      (sum, p) => sum + (parseFloat(String(p.entry_notional_usd ?? '0')) || 0),
      0,
    );
    const availableCapital = capitalUsd * (1 - cashReservePct / 100);
    const remainingBudget = availableCapital - deployedNotional;
    // PR #264 — Bug observé prod 06/05 13:32 UTC : avec 5 positions × $2k = $10k
    // (capital saturé), l'early-return ici empêche la rotation de fire (le
    // close stagnant aurait pourtant libéré $2k de capital permettant
    // l'ouverture du nouveau A+). Fix : skip seulement si rotation OFF.
    if (remainingBudget < positionNotionalUsd && !rotationEnabled) {
      this.logger.log(
        `[top-gainers] ${portfolioId.slice(0, 8)}: capital saturated — deployed=$${deployedNotional.toFixed(2)} ` +
        `+ position=$${positionNotionalUsd.toFixed(2)} > available=$${availableCapital.toFixed(2)} ` +
        `(capital=$${capitalUsd.toFixed(2)} cash_reserve=${cashReservePct}% remaining=$${remainingBudget.toFixed(2)}) → skip cycle`,
      );
      return;
    }
    if (remainingBudget < positionNotionalUsd && rotationEnabled) {
      this.logger.log(
        `[top-gainers] ${portfolioId.slice(0, 8)}: capital saturated ($${deployedNotional.toFixed(2)}/${availableCapital.toFixed(2)}) — checking rotation for A+ candidates`,
      );
    }
    // Plafond effectif d'ouvertures ce cycle : min(maxPerCycle config, slotsAvailable, budget-based slots)
    const budgetBasedSlots = Math.floor(remainingBudget / positionNotionalUsd);
    // PR #261 — Si rotation enabled + slots=0, donne 1 slot virtuel pour
    // permettre au loop d'évaluer un setup A+ et tenter la rotation.
    // PR #264 — Idem pour budget-based slots (capital saturé)
    const slotsForLoop = (rotationEnabled && slotsAvailable === 0) ? 1 : slotsAvailable;
    const budgetForLoop = (rotationEnabled && budgetBasedSlots === 0) ? 1 : budgetBasedSlots;
    const effectiveMaxThisCycle = Math.max(0, Math.min(maxPerCycle, slotsForLoop, budgetForLoop));
    this.logger.log(
      `[top-gainers] ${portfolioId.slice(0, 8)}: capacity check — deployed=$${deployedNotional.toFixed(2)}/${availableCapital.toFixed(2)} ` +
      `(${budgetBasedSlots} budget slots, ${slotsAvailable} pos slots, max-per-cycle=${maxPerCycle}) → up to ${effectiveMaxThisCycle} this cycle`,
    );

    // P8 — Calcule la persistance multi-TF pour les top candidats (parallèle)
    // PR #3 — utilise filteredTop (universe toggles per-portfolio)
    const persistenceMap = await this.mtfPersistence.analyzeBatch(
      filteredTop.map((c) => ({
        symbol: c.symbol,
        exchange: c.exchange,
        currentPrice: c.close,
      })),
    );

    // PR Coverage filter — exclut les candidats coverage=none (toutes les TFs
    // null = pas de data valide pour calculer persistence). Évite de remplir
    // les slots top avec des tickers .SHG/.SHE/illiquides US qui échoueraient
    // de toute façon au gate persistence en aval. Avec le pool TOP_POOL_SIZE=10,
    // on garde au moins maxPerCycle candidats valides pour ouvrir.
    const coverageValidTop: typeof filteredTop = [];
    const coverageSkippedSymbols: string[] = [];
    for (const c of filteredTop) {
      const p = persistenceMap.get(c.symbol.toUpperCase());
      if (!p || p.availableCount === 0 || Number.isNaN(p.persistenceScore)) {
        // Préserve l'instrumentation P18e existante (compteur + skippedNoPersistence)
        // pour les tests + log agrégé en fin de cycle.
        this.skippedNoPersistenceCounter++;
        coverageSkippedSymbols.push(c.symbol);
        continue;
      }
      coverageValidTop.push(c);
    }
    if (coverageSkippedSymbols.length > 0) {
      const sample = coverageSkippedSymbols.slice(0, 5).join(', ');
      this.logger.log(
        `[top-gainers] ${portfolioId.slice(0, 8)}: coverage filter ${filteredTop.length}→${coverageValidTop.length} (${coverageSkippedSymbols.length} skipped, sample: ${sample})`,
      );
    }

    // PR Hardcodes-fix — cap par cycle dérivé de cfg.gainers_max_per_cycle.
    // PR #251 — désormais aussi cappé par le budget capital disponible
    // (effectiveMaxThisCycle calculé ci-dessus).
    const maxThisCycle = effectiveMaxThisCycle;
    let opened = 0;
    // PR #251 — track running notional pour gater chaque open contre le budget
    let runningDeployedNotional = deployedNotional;
    // P18e — accumule les skips pour log agrégé en fin de cycle (au lieu de
    // N lignes "no persistence data → skip" qui polluent les logs Fly).
    // PR Coverage filter — inclut les skips déjà détectés en coverage filter
    // pour cohérence des compteurs P18e + log "cycle skip-summary".
    const skippedNoPersistence: string[] = [...coverageSkippedSymbols];
    // P19x.3 (29/04/2026) — Cooldown 30 min same symbol/side après close.
    //
    // User constat (29/04 02:00 UTC) : "Observé SLV 3× / LMT 3× / XLE 2× en
    // boucle = churn fees pur." Le scanner ouvre un trade, le ferme, le
    // re-ouvre 5 min plus tard sur le même symbol/side car le ticker reste
    // top gainer et passe les gates → fees s'accumulent sans valeur ajoutée.
    //
    // Garde-fou : refuse toute open sur un (symbol, direction) si une
    // position était fermée pour ce couple dans les N dernières minutes
    // (cfg.gainers_cooldown_minutes, default 30, range [0, 240]).
    // Lookup unique par cycle : on charge tous les recent closes avant la
    // boucle puis on check en mémoire (évite N queries DB).
    const cooldownMs = cooldownMinutes * 60_000;
    const cooldownSinceIso = new Date(Date.now() - cooldownMs).toISOString();
    // Failure-tolerant : si la query échoue (mock partiel en test, schema
    // out-of-sync, etc.), on passe le cooldown sans bloquer le pipeline.
    // Le worst case est de ré-ouvrir un trade fermé < 30 min — c'est ce qu'on
    // observait avant P19x.3 et le P19x.1 MIN_NET_PROFIT guard limite déjà
    // les fake TPs en cascade.
    const recentCloseByKey = new Map<string, number>();
    // PR #270 — Post-SL : map symbole → dernier timestamp closed_stop. Distinct du
    // recentCloseByKey générique (tout outcome). Ban additionnel par symbole.
    const recentSlBySymbol = new Map<string, number>();
    try {
      // Query unique : on prend le max(cooldownMs, postSlCooldownMs) pour chercher
      // assez loin dans le passé pour couvrir les 2 cooldowns.
      const lookbackMs = Math.max(cooldownMs, postSlCooldownMin * 60_000);
      const lookbackSinceIso = new Date(Date.now() - lookbackMs).toISOString();
      const { data: recentClosesRaw } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('symbol, direction, exit_timestamp, status')
        .eq('portfolio_id', portfolioId)
        .neq('status', 'open')
        .gte('exit_timestamp', lookbackSinceIso);
      for (const row of recentClosesRaw ?? []) {
        const key = `${String(row.symbol).toUpperCase()}::${String(row.direction)}`;
        const exitMs = new Date(String(row.exit_timestamp)).getTime();
        if (!Number.isFinite(exitMs)) continue;
        // Cooldown générique (TP/SL/manuel) — uniquement si fermé < cooldownMs
        if (Date.now() - exitMs < cooldownMs) {
          const prev = recentCloseByKey.get(key) ?? 0;
          if (exitMs > prev) recentCloseByKey.set(key, exitMs);
        }
        // Post-SL ban (indépendant) — uniquement si status closed_stop
        if (String(row.status) === 'closed_stop') {
          const symKey = String(row.symbol).toUpperCase();
          const prev = recentSlBySymbol.get(symKey) ?? 0;
          if (exitMs > prev) recentSlBySymbol.set(symKey, exitMs);
        }
      }
    } catch (e) {
      this.logger.debug(`[top-gainers] cooldown query skipped: ${String(e).slice(0, 100)}`);
    }
    const postSlCooldownMs = postSlCooldownMin * 60_000;

    for (const cand of coverageValidTop) {
      if (opened >= maxThisCycle) break;
      const baseSym = cand.symbol.replace(/USDT$|USDC$/, '').toUpperCase();
      if (openSymbols.has(cand.symbol.toUpperCase()) || openSymbols.has(baseSym)) continue;

      // P19x.3 — Cooldown re-entry : refuse open si même symbol+side fermé < 30 min
      // Le scanner gainers ouvre toujours en 'long' (ligne ~870 expression).
      // Si tu ajoutes des shorts plus tard, garde la même logique par direction.
      const cooldownKey = `${cand.symbol.toUpperCase()}::long`;
      const lastExitMs = recentCloseByKey.get(cooldownKey);
      if (lastExitMs && Date.now() - lastExitMs < cooldownMs) {
        const elapsedMin = Math.floor((Date.now() - lastExitMs) / 60_000);
        this.logger.log(
          `[top-gainers] ${cand.symbol} cooldown actif (fermé il y a ${elapsedMin} min < ${cooldownMinutes} min) → skip re-entry`,
        );
        continue;
      }

      // PR #270 — Post-SL cooldown : si dernier closed_stop < postSlCooldownMin → skip.
      // Empêche le pattern observé 07/05/2026 : SL → mini-rebond technique →
      // re-open → SL again sur le même downtrend.
      if (postSlCooldownMs > 0) {
        const lastSlMs = recentSlBySymbol.get(cand.symbol.toUpperCase());
        if (lastSlMs && Date.now() - lastSlMs < postSlCooldownMs) {
          const elapsedMin = Math.floor((Date.now() - lastSlMs) / 60_000);
          this.logger.log(
            `[top-gainers] ${cand.symbol} POST_SL_COOLDOWN actif (SL il y a ${elapsedMin} min < ${postSlCooldownMin} min) → skip`,
          );
          continue;
        }
      }

      // P8 gate — persistance multi-TF
      const persistence = persistenceMap.get(cand.symbol.toUpperCase());
      if (persistence) {
        if (persistence.availableCount === 0 || Number.isNaN(persistence.persistenceScore)) {
          this.logger.log(
            `[top-gainers] ${cand.symbol} no TF data → skip (gate persistence)`,
          );
          continue;
        }

        // P19β (30/04/2026) — Shadow-logging mode strict 6/6.
        //
        // Activation : UNIQUEMENT quand `gainers_min_persistence_score >= 1.0`
        // sur le portfolio (mode test "Gainers 6/6 only" — Issue #128). Pour
        // les portfolios standard (minScore=0.67 par défaut), le check
        // standard ci-dessous reste actif.
        //
        // Objectif : sur le portfolio test strict 6/6, logger les "near-miss"
        // (5/6 et 4/6) qui auraient été ouverts en mode standard. Permet de
        // mesurer expectancy comparée 6/6 vs 5/6 vs 4/6 sur la MÊME fenêtre
        // de marché (KPI pour décision GO/PIVOT/KILL J+14).
        //
        // Ratios (avec tolérance float pour 5/6=0.8333 et 4/6=0.6667) :
        //   1.00 (6/6)         → ouverture normale (pass aux gates suivants)
        //   [0.83, 1.0)  5/6   → shadow_566 log + skip (no open)
        //   [0.66, 0.83) 4/6   → shadow_466 log + skip (no open)
        //   < 0.66             → skip silencieux (comportement standard)
        //
        // Converti en entier via Math.round pour éviter l'off-by-one float :
        // 0.67 × 6 = 4.02 → Math.round → 4 → positiveCount ≥ 4 (et non 5).
        // Voir fix(gainers-scoring-threshold) — le bug 4/6 est corrigé ici.
        const STRICT_MODE_THRESHOLD = 0.999; // tolérance float pour 1.0
        if (minScore >= STRICT_MODE_THRESHOLD) {
          const score = persistence.persistenceScore;
          if (score >= 0.83 && score < 1.0) {
            await this.decisionLog.append({
              portfolioId,
              kind: 'gainer_shadow_566',
              summary: `[GAINER_SHADOW_566] ${cand.symbol} persistence=${persistence.persistenceCount} score=${score.toFixed(2)} — would have opened in 5/6 mode but skipped under strict 6/6`,
              rationale: 'P19β shadow-logging : mesure de l\'edge comparée du setup 5/6 vs 6/6 strict sur la même fenêtre de marché.',
              payload: {
                symbol: cand.symbol,
                exchange: cand.exchange,
                assetClass: cand.assetClass,
                persistenceScore: score,
                persistenceCount: persistence.persistenceCount,
                pathEfficiency: persistence.pathQuality?.overallEfficiency ?? null,
                pathSmoothness: persistence.pathQuality?.overallSmoothness ?? null,
                tf1m: persistence.tf1m,
                tf5m: persistence.tf5m,
                tf10m: persistence.tf10m,
                tf15m: persistence.tf15m,
                tf30m: persistence.tf30m,
                tf1h: persistence.tf1h,
                changePct: cand.changePct,
                price: cand.close,
                timestamp: new Date().toISOString(),
              },
              triggeredBy: 'autopilot_cron',
            }).catch(() => { /* non-bloquant */ });
            continue;
          }
          if (score >= 0.66 && score < 0.83) {
            await this.decisionLog.append({
              portfolioId,
              kind: 'gainer_shadow_466',
              summary: `[GAINER_SHADOW_466] ${cand.symbol} persistence=${persistence.persistenceCount} score=${score.toFixed(2)} — would have opened in 4/6 mode but skipped under strict 6/6`,
              rationale: 'P19β shadow-logging : mesure de l\'edge comparée du setup 4/6 vs 6/6 strict.',
              payload: {
                symbol: cand.symbol,
                exchange: cand.exchange,
                assetClass: cand.assetClass,
                persistenceScore: score,
                persistenceCount: persistence.persistenceCount,
                pathEfficiency: persistence.pathQuality?.overallEfficiency ?? null,
                pathSmoothness: persistence.pathQuality?.overallSmoothness ?? null,
                tf1m: persistence.tf1m,
                tf5m: persistence.tf5m,
                tf10m: persistence.tf10m,
                tf15m: persistence.tf15m,
                tf30m: persistence.tf30m,
                tf1h: persistence.tf1h,
                changePct: cand.changePct,
                price: cand.close,
                timestamp: new Date().toISOString(),
              },
              triggeredBy: 'autopilot_cron',
            }).catch(() => { /* non-bloquant */ });
            continue;
          }
          if (score < 0.66) {
            // Skip silencieux (comportement standard, pas de pollution log)
            continue;
          }
          // score === 1.0 (6/6) → tombe dans le check standard ci-dessous
          // qui pass-through (1.0 not < 1.0)
        }

        // PR #271 — Asia strictness boost : on booste les seuils path/persistence
        // pour les candidats asia_equity (compense la choppy nature des small-caps Asia).
        const isAsia = cand.assetClass === 'asia_equity';
        const effectiveMinScore = isAsia
          ? Math.min(1, minScore + asiaStrictnessBoost)
          : minScore;
        const effectiveMinPathEff = (isAsia && minPathEff != null)
          ? Math.min(1, minPathEff + asiaStrictnessBoost)
          : minPathEff;

        // Integer gate: Math.round avoids float off-by-one (4/6=0.6666 < 0.67 was
        // silently excluding 4/6-TF candidates). 0.67×6=4.02 → rounds to 4.
        const minPositive = Math.round(effectiveMinScore * persistence.availableCount);
        if (persistence.positiveCount < minPositive) {
          this.logger.log(
            `[top-gainers] ${cand.symbol} ${persistence.persistenceCount} (${persistence.positiveCount}/${persistence.availableCount} TFs) < min=${minPositive}/${persistence.availableCount}${isAsia ? ' [asia +' + asiaStrictnessBoost.toFixed(2) + ']' : ''} → skip`,
          );
          continue;
        }
        // P9-UX ADDENDUM — Path quality gate (skip pump-and-dump qui passent persistence)
        if (
          effectiveMinPathEff != null &&
          persistence.pathQuality &&
          persistence.pathQuality.overallEfficiency != null &&
          persistence.pathQuality.overallEfficiency < effectiveMinPathEff
        ) {
          this.logger.log(
            `[top-gainers] ${cand.symbol} pathEff=${persistence.pathQuality.overallEfficiency.toFixed(2)} (${persistence.pathQuality.overallSmoothness}) < min=${effectiveMinPathEff.toFixed(2)}${isAsia ? ' [asia +' + asiaStrictnessBoost.toFixed(2) + ']' : ''} → skip`,
          );
          continue;
        }
        this.logger.log(
          `[top-gainers] ${cand.symbol} persistence=${persistence.persistenceCount} score=${persistence.persistenceScore.toFixed(2)} pathEff=${persistence.pathQuality?.overallEfficiency?.toFixed(2) ?? 'n/a'} (${persistence.pathQuality?.overallSmoothness ?? 'n/a'}) → OPEN`,
        );
      } else {
        // P18e — Skip silencieux ; aggregé dans le log de fin de cycle.
        // Si la donnée TF est indispo (provider down) on n'ouvre pas — gate
        // strict pour éviter d'ouvrir aveuglément.
        this.skippedNoPersistenceCounter++;
        skippedNoPersistence.push(cand.symbol);
        continue;
      }

      // P18 — LLM signal validation (inert when SCANNER_LLM_ROUTER_ENABLED=false)
      const signal = await this.analyzeSignal(cand, persistence);
      if (!signal.pass) {
        this.logger.log(
          `[top-gainers:signal] ${cand.symbol} rejected (quality=${signal.signal_quality.toFixed(2)}): ${signal.reason}`,
        );
        continue;
      }

      // P18f — Crypto whitelist gate (option b "skip + log"). N'affecte que
      // si CRYPTO_TRADABLE_WHITELIST env est définie. Sinon back-compat.
      const isCryptoCand = cand.assetClass === 'crypto_major' || cand.assetClass === 'crypto_alt';
      if (isCryptoCand && !this.isCryptoTradable(cand.symbol)) {
        this.skippedNotCryptoTradableCounter++;
        this.logger.log(
          `[top-gainers:crypto_tradable] ${cand.symbol} not in CRYPTO_TRADABLE_WHITELIST → skip open (visible in scan, not traded)`,
        );
        continue;
      }

      // PR #4 — pWin gate (ML logistic regression P9). Activable par portfolio
      // via cfg.gainers_p_win_gate_enabled. Features dérivées des metrics
      // déjà calculés (persistenceCount + scoring composite).
      // Bypass si modèle pas prêt (probability.fallback=true).
      let pWinResult: { pWin: number; modelVersion: string; fallback: boolean; sampleSize: number; features: Record<string, number> } | null = null;
      if (pWinGateEnabled) {
        const closeToHigh = cand.high > 0 ? cand.close / cand.high : 0;
        const volRatio = cand.avgVol50d && cand.avgVol50d > 0
          ? (cand.volume ?? 0) / cand.avgVol50d
          : 0;
        const features: Record<string, number> = {
          // Note: persistenceCount feature = integer count (positiveCount), pas le string "4/6".
          persistenceCount: persistence?.positiveCount ?? 0,
          volRatio,
          rsi: 50, // Pas calculé live au scanner — fallback neutre. Future : enrichir.
          closeToHigh,
          changePct: cand.changePct,
        };
        const probability = await this.probability.estimateProbability(features)
          .catch((e) => {
            this.logger.warn(`[pWin] ${cand.symbol} estimate failed: ${String(e).slice(0, 80)}`);
            return null;
          });
        if (probability) {
          pWinResult = {
            pWin: probability.pWin,
            modelVersion: probability.modelVersion,
            fallback: probability.fallback,
            sampleSize: probability.sampleSize,
            features,
          };
          if (probability.fallback) {
            this.logger.log(
              `[pWin] ${cand.symbol} fallback (sample=${probability.sampleSize}, model=${probability.modelVersion}) → gate bypassed`,
            );
          } else if (probability.pWin < minPWin) {
            this.logger.log(
              `[pWin] ${cand.symbol} pWin=${probability.pWin.toFixed(3)} < ${minPWin.toFixed(2)} (model=${probability.modelVersion}) → skip`,
            );
            continue;
          } else {
            this.logger.log(
              `[pWin] ${cand.symbol} pWin=${probability.pWin.toFixed(3)} ≥ ${minPWin.toFixed(2)} (model=${probability.modelVersion}) → OPEN`,
            );
          }
        }
      }

      // PR #251 — Gate budget par-candidat : refuse l'open si ajouter cette
      // position dépasse le budget disponible. Évite d'ouvrir un 3e à $4k
      // si capital=$10k cash=10% deployedNotional=$8k → reste $1k seulement.
      // PR #264 — Si rotation enabled, on ne break pas : la rotation peut
      // libérer du capital en fermant une stagnante.
      if (runningDeployedNotional + positionNotionalUsd > availableCapital && !rotationEnabled) {
        this.logger.log(
          `[top-gainers] ${cand.symbol}: budget cap reached — running=$${runningDeployedNotional.toFixed(2)} ` +
          `+ position=$${positionNotionalUsd.toFixed(2)} > available=$${availableCapital.toFixed(2)} → skip rest of cycle`,
        );
        break;
      }

      // PR #261 — Capital Rotation Gate : si slots saturés AND rotation enabled,
      // tente de fermer une position stagnante pour libérer un slot.
      // Cap : 1 rotation max par cycle (rotated flag).
      //
      // PR #263 — High-grading mode (`GAINERS_HIGH_GRADING_ENABLED=true`) :
      // permet la rotation MÊME quand slots libres. Logique :
      //   - Setup A+ détecté (gates internes tryCapitalRotation)
      //   - Stagnante existe (age ≥ seuil, pnl ±0.3%)
      //   - Net EV ≥ $5
      //   → Ferme stagnante + ouvre A+ (remplace pire position par meilleure)
      // Plus agressif : churn de positions stagnantes en continu vers
      // setups frais. Frais doublés (1 close + 1 open en plus) — d'où le EV
      // gate strict.
      let rotated = false;
      const highGradingEnabled = (process.env.GAINERS_HIGH_GRADING_ENABLED ?? 'false').toLowerCase() === 'true';
      const shouldTryRotation = rotationEnabled && opened === 0 && (slotsAvailable === 0 || highGradingEnabled);
      if (shouldTryRotation) {
        const rotation = await this.tryCapitalRotation(
          portfolioId,
          cand,
          persistence,
          { tpPct, slPct, positionNotionalUsd, rotationStagnantMinAgeMin, rotationMinPathEfficiency },
        );
        if (rotation.rotated) {
          rotated = true;
          slotsAvailable += 1; // close stagnant frees 1 slot (correct sat=0→1, free→+1)
          // PR #264 — Update runningDeployedNotional : close stagnant libère
          // ~positionNotionalUsd (approx, en pratique l'entry_notional réel
          // peut différer si positionPct a changé entre l'open et maintenant).
          // Sans cette MAJ, le gate budget par-candidat re-bloquerait l'open
          // post-rotation alors que le capital est désormais libéré.
          runningDeployedNotional = Math.max(0, runningDeployedNotional - positionNotionalUsd);
          // Mise à jour openSymbols pour ne pas re-skipper la même position
          if (rotation.closedPositionId) {
            // (la position fermée est désormais hors openSymbols pour les itérations suivantes)
          }
        } else {
          // Rotation pas faite. Si saturated (sans high-grading), on stoppe.
          // En high-grading, on continue le flow normal (slot libre dispo).
          if (slotsAvailable === 0) {
            break;
          }
          // High-grading mode : la rotation a juste été tentée mais non-rentable.
          // On laisse le scanner ouvrir normalement dans le slot libre.
        }
      }

      const insertedPosId = await this.openTopGainerPosition(
        userId,
        portfolioId,
        cand,
        persistence,
        {
          tpPct,
          slPct,
          capitalUsd,
          positionPct,
          positionNotionalUsd,
          cashReservePct,
        },
        pWinResult, // PR #4 — pWin metrics persistés via paper_trades
      ).catch((e) => {
        this.logger.warn(
          `[top-gainers] open ${cand.symbol} failed: ${String(e).slice(0, 120)}`,
        );
        return null;
      });
      if (insertedPosId) {
        opened++;
        runningDeployedNotional += positionNotionalUsd;
        await this.markLogOpened(cand.symbol, portfolioId, insertedPosId).catch(() => null);
      }
    }

    // P18e — Log agrégé une fois par cycle (au lieu de N lignes par-symbol).
    if (skippedNoPersistence.length > 0) {
      const sample = skippedNoPersistence.slice(0, 5).join(', ');
      this.logger.log(
        `[top-gainers] cycle skip-summary: scanned=${top.length}, retained=${opened}, skipped_no_persistence=${skippedNoPersistence.length} (sample: ${sample})`,
      );
    }
  }

  /**
   * PR #261 — Capital Rotation Gate.
   *
   * Si tous les slots sont saturés MAIS le scanner détecte un setup A+
   * (score ≥ 0.95, persistence ≥ 5/6, path ≥ 0.5) ET qu'au moins une
   * position ouverte est "stagnante" (pnl ∈ [-0.3%, +0.3%], age ≥ 90min),
   * on ferme la stagnante pour libérer le slot et ouvrir le setup A+.
   *
   * Calcul EV avec frais venue-specific (Korea KSST 23bps sell, HK stamp
   * duty, IBKR US tier, etc.) via `computeVenueFeeDetail` :
   *
   *   netEV = (TP_gain × hit_rate) - close_stagnant_fees - new_open_fees
   *           - new_close_fees_at_TP - slippage_4_sides
   *
   * Rotate uniquement si netEV ≥ MIN_ROTATION_EV ($5 buffer).
   *
   * Toggle env `GAINERS_CAPITAL_ROTATION_ENABLED` (default `false`).
   * Cap : max 1 rotation par cycle (évite churn).
   */
  private async tryCapitalRotation(
    portfolioId: string,
    candidate: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    persistence: PersistenceWithPath | undefined,
    overrides: {
      tpPct: number;
      slPct: number;
      positionNotionalUsd: number;
      rotationStagnantMinAgeMin?: number;
      rotationMinPathEfficiency?: number | null;
    },
  ): Promise<{ rotated: boolean; closedPositionId?: string }> {
    const enabled = (process.env.GAINERS_CAPITAL_ROTATION_ENABLED ?? 'false').toLowerCase() === 'true';
    if (!enabled) return { rotated: false };

    // Gates A+ stricts pour ne rotation que sur SETUPS exceptionnels
    if (candidate.score < 0.95) return { rotated: false };
    if (!persistence || persistence.persistenceScore < 5/6) return { rotated: false };
    const pathEff = persistence.pathQuality?.overallEfficiency ?? null;
    // PR #269 — seuil pathEff rotation configurable. null/undefined → désactive le gate.
    // Default 0.5 (legacy hardcoded value).
    const rotationMinPathEff = overrides.rotationMinPathEfficiency;
    if (rotationMinPathEff != null && pathEff != null && pathEff < rotationMinPathEff) {
      return { rotated: false };
    }

    // Récupère les positions open du portfolio
    const { data: openPositions } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, venue, entry_price, entry_timestamp, quantity, entry_notional_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (!openPositions || openPositions.length === 0) return { rotated: false };

    // Identifie la stagnante la plus ancienne (pnl ∈ [-0.3%, +0.3%], age ≥ 90 min)
    const STAGNANT_PNL_PCT = 0.3; // dead zone
    // PR #262 — Threshold "stagnante" configurable via UI (default 90 min, range 15-480)
    const STAGNANT_MIN_AGE_MS = (overrides.rotationStagnantMinAgeMin ?? 90) * 60_000;
    type Stagnant = {
      pos: typeof openPositions[number];
      pnlPct: number;
      ageMs: number;
      currentPrice: number;
    };
    const stagnants: Stagnant[] = [];
    for (const pos of openPositions) {
      const ageMs = Date.now() - new Date(String(pos.entry_timestamp)).getTime();
      if (ageMs < STAGNANT_MIN_AGE_MS) continue;
      const quote = await this.lisa.getLivePrice(String(pos.symbol)).catch(() => null);
      if (!quote || !quote.price) continue;
      const livePrice = parseFloat(quote.price);
      const entry = parseFloat(String(pos.entry_price));
      if (!Number.isFinite(livePrice) || !Number.isFinite(entry) || entry <= 0) continue;
      const pnlPct = ((livePrice - entry) / entry) * 100;
      if (Math.abs(pnlPct) > STAGNANT_PNL_PCT) continue;
      stagnants.push({ pos, pnlPct, ageMs, currentPrice: livePrice });
    }
    if (stagnants.length === 0) return { rotated: false };

    // Sort par age desc → la plus ancienne en premier
    stagnants.sort((a, b) => b.ageMs - a.ageMs);
    const target = stagnants[0];

    // Calcul fees venue-specific pour la rotation
    const Decimal = (await import('decimal.js')).default;
    const targetQty = new Decimal(String(target.pos.quantity));
    const targetEntry = new Decimal(String(target.pos.entry_price));
    const targetVenue = String(target.pos.venue ?? 'unknown');
    const targetAssetClass = String(target.pos.asset_class ?? '');
    const closeStagnantFees = new Decimal(
      computeVenueFeeDetail(targetQty, new Decimal(target.currentPrice), targetAssetClass, targetVenue, 'sell').total,
    );

    const newNotional = new Decimal(overrides.positionNotionalUsd);
    const newPrice = new Decimal(candidate.close);
    const newQty = newNotional.div(newPrice);
    const newTpPrice = newPrice.mul(1 + overrides.tpPct / 100);
    const newOpenFees = new Decimal(
      computeVenueFeeDetail(newQty, newPrice, candidate.assetClass, candidate.exchange ?? 'unknown', 'buy').total,
    );
    const newCloseAtTpFees = new Decimal(
      computeVenueFeeDetail(newQty, newTpPrice, candidate.assetClass, candidate.exchange ?? 'unknown', 'sell').total,
    );

    // Slippage 5 bps × 4 sides (close stagnant exit + new entry + new exit at TP)
    const SLIPPAGE_BPS = 5;
    const stagnantSlip = targetQty.mul(target.currentPrice).mul(SLIPPAGE_BPS).div(10000);
    const newOpenSlip = newQty.mul(newPrice).mul(SLIPPAGE_BPS).div(10000);
    const newCloseSlip = newQty.mul(newTpPrice).mul(SLIPPAGE_BPS).div(10000);

    const totalRotationCost = closeStagnantFees.plus(newOpenFees).plus(newCloseAtTpFees)
      .plus(stagnantSlip).plus(newOpenSlip).plus(newCloseSlip);
    const newTpGain = newTpPrice.minus(newPrice).mul(newQty);
    const HIT_RATE_AT_PLUS_GATES = 0.70; // estimation conservative pour A+ setups
    const expectedGainNet = newTpGain.mul(HIT_RATE_AT_PLUS_GATES).minus(totalRotationCost);

    const MIN_ROTATION_EV = 5; // $5 buffer minimum
    if (expectedGainNet.lt(MIN_ROTATION_EV)) {
      this.logger.log(
        `[capital-rotation] ${portfolioId.slice(0, 8)}: skip — netEV=$${expectedGainNet.toFixed(2)} < $${MIN_ROTATION_EV} ` +
        `(close ${target.pos.symbol} fees=$${closeStagnantFees.toFixed(2)} ` +
        `vs new ${candidate.symbol} TP_gain=$${newTpGain.toFixed(2)} fees=$${newOpenFees.plus(newCloseAtTpFees).toFixed(2)})`,
      );
      return { rotated: false };
    }

    // Execute la rotation : ferme la stagnante via paperBroker
    try {
      await this.lisa.getPaperBroker().closePosition({
        positionId: String(target.pos.id),
        reason: 'closed_invalidated',
        livePrice: String(target.currentPrice),
        rationale: `[ROTATION] Capital rotation → ${candidate.symbol} (score=${candidate.score} persistence=${persistence.persistenceCount} path=${pathEff?.toFixed(2) ?? 'n/a'}) — ` +
          `close stagnant ${target.pos.symbol} age=${(target.ageMs / 60000).toFixed(0)}min pnl=${target.pnlPct.toFixed(2)}% ` +
          `netEV=$${expectedGainNet.toFixed(2)}`,
      });
      this.logger.log(
        `[capital-rotation] ${portfolioId.slice(0, 8)} CLOSED ${target.pos.symbol} → opening ${candidate.symbol} ` +
        `(netEV=$${expectedGainNet.toFixed(2)})`,
      );
      // Audit decision_log
      await this.decisionLog.append({
        portfolioId,
        kind: 'position_closed',
        summary: `[CAPITAL_ROTATION] Closed stagnant ${target.pos.symbol} → free slot for ${candidate.symbol} (score=${candidate.score})`,
        rationale: `Stagnant position closed for capital rotation. Age=${(target.ageMs / 60000).toFixed(0)}min, pnl=${target.pnlPct.toFixed(2)}%. ` +
          `New candidate score=${candidate.score} persistence=${persistence.persistenceCount} pathEff=${pathEff?.toFixed(2) ?? 'n/a'}. ` +
          `Net EV after all fees+slippage = $${expectedGainNet.toFixed(2)}.`,
        payload: {
          closed_position_id: target.pos.id,
          closed_symbol: target.pos.symbol,
          closed_age_min: target.ageMs / 60000,
          closed_pnl_pct: target.pnlPct,
          new_candidate_symbol: candidate.symbol,
          new_candidate_score: candidate.score,
          new_candidate_persistence: persistence.persistenceCount,
          new_candidate_path_eff: pathEff,
          fees_breakdown: {
            close_stagnant: closeStagnantFees.toFixed(4),
            new_open: newOpenFees.toFixed(4),
            new_close_at_tp: newCloseAtTpFees.toFixed(4),
            slippage_4_sides: stagnantSlip.plus(newOpenSlip).plus(newCloseSlip).toFixed(4),
          },
          expected_gain_net: expectedGainNet.toFixed(4),
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => { /* non-bloquant */ });
      return { rotated: true, closedPositionId: String(target.pos.id) };
    } catch (e) {
      this.logger.warn(`[capital-rotation] close failed: ${String(e).slice(0, 120)}`);
      return { rotated: false };
    }
  }

  /**
   * PR #266 — Force-close avant cloche : pour chaque position du portfolio
   * dont la bourse ferme dans <= offsetMin minutes, déclenche un close
   * via paperBroker.closePosition au prix live.
   *
   * Crypto exclu (24/7). Marchés US/EU/Asia uniquement. Audit decision_log
   * `kind='position_closed'` payload `[FORCE_CLOSE_BEFORE_CLOSE]`.
   *
   * Contrat clé : ne touche **jamais** une position crypto, et ne se
   * déclenche jamais hors horaires session (isApproachingClose vérifie
   * que la bourse est encore ouverte mais proche de close).
   */
  private async runForceCloseBeforeCloseTick(
    portfolioId: string,
    offsetMin: number,
    now: Date,
  ): Promise<void> {
    const { data: openPositions, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, venue, entry_price, entry_timestamp, quantity')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (error || !openPositions || openPositions.length === 0) return;

    for (const pos of openPositions) {
      const assetClass = String(pos.asset_class ?? '');
      const cls = sessionClassFor(assetClass);
      if (cls === null) continue; // crypto / fx / commodity → skip
      if (!isApproachingClose(cls, offsetMin, now)) continue;

      const quote = await this.lisa.getLivePrice(String(pos.symbol)).catch(() => null);
      if (!quote || !quote.price) {
        this.logger.warn(
          `[force-close] ${portfolioId.slice(0, 8)} ${pos.symbol}: no live price — skip (will retry next cycle)`,
        );
        continue;
      }
      const livePrice = parseFloat(quote.price);
      if (!Number.isFinite(livePrice) || livePrice <= 0) continue;

      const minutesToClose = MARKET_SESSION_HOURS[cls].closeUtcMin
        - (now.getUTCHours() * 60 + now.getUTCMinutes());
      const entry = parseFloat(String(pos.entry_price));
      const pnlPct = Number.isFinite(entry) && entry > 0
        ? ((livePrice - entry) / entry) * 100
        : 0;

      try {
        await this.lisa.getPaperBroker().closePosition({
          positionId: String(pos.id),
          reason: 'closed_invalidated',
          livePrice: String(livePrice),
          rationale:
            `[FORCE_CLOSE_BEFORE_CLOSE] ${cls.toUpperCase()} market closing in ${minutesToClose}min ` +
            `(offset=${offsetMin}min) — pnl=${pnlPct.toFixed(2)}%`,
        });
        this.logger.log(
          `[force-close] ${portfolioId.slice(0, 8)} CLOSED ${pos.symbol} (${cls}, T-${minutesToClose}min, pnl=${pnlPct.toFixed(2)}%)`,
        );
        await this.decisionLog.append({
          portfolioId,
          kind: 'position_closed',
          summary: `[FORCE_CLOSE_BEFORE_CLOSE] ${pos.symbol} closed before ${cls.toUpperCase()} session close`,
          rationale:
            `Position ${pos.symbol} (${cls}) closed automatically — market closes in ${minutesToClose}min ` +
            `(configured offset=${offsetMin}min). Avoids overnight gap risk on intraday momentum strategy. ` +
            `pnl=${pnlPct.toFixed(2)}%.`,
          payload: {
            symbol: pos.symbol,
            asset_class: assetClass,
            session_class: cls,
            offset_min: offsetMin,
            minutes_to_close: minutesToClose,
            pnl_pct: pnlPct,
            live_price: livePrice,
            entry_price: entry,
          },
          triggeredBy: 'autopilot_cron',
        }).catch(() => { /* non-bloquant */ });
      } catch (e) {
        this.logger.warn(
          `[force-close] ${portfolioId.slice(0, 8)} ${pos.symbol}: close failed — ${String(e).slice(0, 120)}`,
        );
      }
    }
  }

  /**
   * PR #267 — Orphan close rétroactif. Ferme les positions zombies dont :
   *   - Le marché est actuellement fermé (US/EU/Asia, pas crypto)
   *   - L'âge de la position est ≥ ORPHAN_MIN_AGE_MIN (15 min, anti-race)
   *   - Aucun prix live disponible (quote nul OU source = fallback*)
   *
   * Close à `entry_price` → pnl=0, libère juste le capital. Audit
   * `decision_log` payload `[ORPHAN_CLOSE]`.
   *
   * Toujours actif en mode gainers — c'est un garde-fou structurel, pas
   * une stratégie configurable. Bug observé 06/05/2026 : 4 positions Asia
   * (300209.SHE, 300214.SHE, 001500.KO, 089010.KQ) ouvertes pendant les
   * heures EU/US (15h41-16h11 UTC), Asia fermée depuis 06h30-08h00 UTC →
   * gelées 7-9h sans possibilité de TP/SL/rotation, capital saturé 100%.
   */
  private async runOrphanCloseTick(portfolioId: string, now: Date): Promise<void> {
    const ORPHAN_MIN_AGE_MIN = 15;

    const { data: openPositions, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class, entry_price, entry_timestamp')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (error || !openPositions || openPositions.length === 0) return;

    for (const pos of openPositions) {
      const cls = sessionClassFor(String(pos.asset_class ?? ''));
      if (cls === null) continue; // crypto/fx/commodity → skip
      if (isMarketOpen(cls, now)) continue; // marché ouvert → pas orphan

      const ageMs = now.getTime() - new Date(String(pos.entry_timestamp)).getTime();
      const ageMin = ageMs / 60_000;
      if (ageMin < ORPHAN_MIN_AGE_MIN) continue; // anti-race close-puis-rouvert

      const quote = await this.lisa.getLivePrice(String(pos.symbol)).catch(() => null);
      const source = quote?.source ?? '';
      const hasLivePrice = !!(quote && quote.price && !source.startsWith('fallback'));
      if (hasLivePrice) continue; // live price disponible → pas orphan

      const entry = parseFloat(String(pos.entry_price));
      if (!Number.isFinite(entry) || entry <= 0) continue;

      try {
        await this.lisa.getPaperBroker().closePosition({
          positionId: String(pos.id),
          reason: 'closed_invalidated',
          livePrice: String(entry),
          rationale:
            `[ORPHAN_CLOSE] ${cls.toUpperCase()} market closed + no live quote (source=${source || 'null'}) — ` +
            `position frozen ${ageMin.toFixed(0)}min, freeing capital at entry_price (pnl=0)`,
        });
        this.logger.log(
          `[orphan-close] ${portfolioId.slice(0, 8)} CLOSED ${pos.symbol} (${cls}, age=${ageMin.toFixed(0)}min, source=${source || 'null'})`,
        );
        await this.decisionLog.append({
          portfolioId,
          kind: 'position_closed',
          summary: `[ORPHAN_CLOSE] ${pos.symbol} freed — ${cls.toUpperCase()} market closed, no live price`,
          rationale:
            `Position ${pos.symbol} (${cls}) freed via orphan-close: market closed and no live quote available ` +
            `(source=${source || 'null'}). Position was open ${ageMin.toFixed(0)}min, blocking capital with no possibility ` +
            `of TP/SL/rotation until market reopens. Closed at entry_price (pnl=0) to free slot.`,
          payload: {
            symbol: pos.symbol,
            asset_class: pos.asset_class,
            session_class: cls,
            age_min: ageMin,
            quote_source: source || null,
            entry_price: entry,
          },
          triggeredBy: 'autopilot_cron',
        }).catch(() => { /* non-bloquant */ });
      } catch (e) {
        this.logger.warn(
          `[orphan-close] ${portfolioId.slice(0, 8)} ${pos.symbol}: close failed — ${String(e).slice(0, 120)}`,
        );
      }
    }
  }

  /**
   * PR #250 — Ouvre une position via paperBroker.openPositionDirect (path
   * direct, bypass complet du pipeline LLM). Skip generateThesis (LLM call),
   * skip INSERT lisa_proposals, skip approveProposal. Latence ~250 ms vs
   * 2-3 sec via legacy. proposalId/thesisId NULL (migration 0120).
   *
   * P8 — Si `persistence` fourni, persiste les métriques multi-TF au moment
   * de l'open dans `paper_trades` (forward-compat avec P9).
   */
  private async openTopGainerPosition(
    userId: string,
    portfolioId: string,
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    persistence?: PersistenceResult,
    // PR Hardcodes-fix — toute la sizing config arrive par overrides depuis
    // scanPortfolio (qui a lu lisa_session_configs). Plus aucune valeur
    // hardcodée — capital, notional, position pct, cash reserve, TP, SL.
    overrides?: {
      tpPct: number;
      slPct: number;
      capitalUsd: number;
      positionPct: number;
      positionNotionalUsd: number;
      cashReservePct: number;
    },
    // PR #4 — pWin metrics persistés dans paper_trades pour boucle apprentissage.
    pWinMeta?: {
      pWin: number;
      modelVersion: string;
      sampleSize: number;
      features: Record<string, number>;
    } | null,
  ): Promise<string | null> {
    const effectiveTp = overrides?.tpPct ?? 1.5;
    const effectiveSl = overrides?.slPct ?? 1.0;
    // Fallbacks identiques aux defaults DB migration 0115 si overrides absents
    // (caller hors scanPortfolio = legacy / test).
    const effectiveCapital = overrides?.capitalUsd ?? FALLBACK_CAPITAL_USD;
    const effectivePositionPct = overrides?.positionPct ?? FALLBACK_POSITION_PCT;
    const effectiveNotional = overrides?.positionNotionalUsd
      ?? (effectiveCapital * (effectivePositionPct / 100));

    // PR #250 — DÉCOUPLAGE COMPLET du pipeline LLM Lisa.
    //
    // Avant #250 : generateThesis (LLM) → INSERT lisa_proposals → approveProposal
    // → re-validations + paperBroker.openPosition. ~2-3 sec / candidat. Bug
    // structurels (TypeError riskReward, fix #249) + dépendance pipeline narrative.
    //
    // Après #250 : getLivePrice → paperBroker.openPositionDirect → INSERT
    // lisa_positions. ~250 ms / candidat. Aucune dépendance pipeline LLM.
    // proposalId/thesisId NULL (migration 0120 rend nullable).
    //
    // Garde-fous identiques (notional floor 10$, fees<notional, P20 fees-aware
    // target guard) — implémentés dans openPositionDirect.
    try {
      const quote = await this.lisa.getLivePrice(cand.symbol);
      if (!quote || !quote.price) {
        this.logger.warn(`[top-gainers] ${cand.symbol}: getLivePrice returned no price → skip`);
        return null;
      }
      // Sanity bound : si le prix live diverge > 30% du `cand.close` (snapshot scanner),
      // on skip — soit fallback price soit corruption cache.
      const livePriceNum = parseFloat(quote.price);
      if (!Number.isFinite(livePriceNum) || livePriceNum <= 0) {
        this.logger.warn(`[top-gainers] ${cand.symbol}: invalid live price ${quote.price} → skip`);
        return null;
      }
      // Reject sur source fallback explicite (price corrupted)
      if (typeof quote.source === 'string' && quote.source.startsWith('fallback')) {
        this.logger.warn(`[top-gainers] ${cand.symbol}: fallback source ${quote.source} → skip`);
        return null;
      }
      const candCloseNum = Number(cand.close);
      if (Number.isFinite(candCloseNum) && candCloseNum > 0) {
        const divergePct = Math.abs(livePriceNum - candCloseNum) / candCloseNum;
        if (divergePct > 0.30) {
          this.logger.warn(
            `[top-gainers] ${cand.symbol}: live $${livePriceNum} diverges ${(divergePct * 100).toFixed(1)}% from cand.close $${candCloseNum} → skip (sanity bound)`,
          );
          return null;
        }
      }

      // Compute stop/TP prices from pcts (long only par scanner)
      const stopPrice = (livePriceNum * (1 - effectiveSl / 100)).toFixed(8);
      const tpPrice = (livePriceNum * (1 + effectiveTp / 100)).toFixed(8);

      const openedPos = await this.lisa.getPaperBroker().openPositionDirect({
        portfolioId,
        symbol: cand.symbol,
        assetClass: cand.assetClass,
        direction: 'long',
        venue: cand.exchange ?? 'unknown',
        capitalAllocationUsd: effectiveNotional.toFixed(2),
        livePrice: livePriceNum.toFixed(8),
        stopLossPrice: stopPrice,
        takeProfitPrice: tpPrice,
        horizonDays: 1,
        source: 'scanner_top_gainers',
      });

      this.logger.log(
        `[top-gainers] ${cand.symbol} opened DIRECT (entry=$${livePriceNum.toFixed(4)} qty=${openedPos.quantity} sl=${stopPrice} tp=${tpPrice} score=${cand.score})`,
      );

      // Audit decision_log non-bloquant
      await this.decisionLog.append({
        portfolioId,
        kind: 'position_opened',
        summary: `[GAINERS_DIRECT] ${cand.symbol} opened — score=${cand.score} entry=$${livePriceNum.toFixed(4)}`,
        rationale: `Scanner Gainers déterministe (PR #250) — bypass pipeline LLM. ` +
          `tp=${effectiveTp}% sl=${effectiveSl}% notional=$${effectiveNotional.toFixed(2)} ` +
          `capital=$${effectiveCapital.toFixed(2)} positionPct=${effectivePositionPct}%.`,
        payload: {
          symbol: cand.symbol,
          asset_class: cand.assetClass,
          exchange: cand.exchange,
          score: cand.score,
          change_pct: cand.changePct,
          entry_price: livePriceNum,
          stop_loss_price: parseFloat(stopPrice),
          take_profit_price: parseFloat(tpPrice),
          quantity: openedPos.quantity,
          notional_usd: effectiveNotional.toFixed(2),
          source: 'scanner_top_gainers_direct',
          position_id: openedPos.id,
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => { /* non-bloquant */ });

      // P8 + PR #4 — best-effort persist paper_trades pour boucle apprentissage P9
      if (persistence) {
        await this.persistPaperTrade(userId, portfolioId, cand, openedPos, persistence, effectiveTp, effectiveSl, pWinMeta ?? null)
          .catch((e) =>
            this.logger.debug(`[top-gainers] persistPaperTrade ${cand.symbol} failed: ${String(e).slice(0, 120)}`),
          );
      }

      return openedPos.id;
    } catch (e) {
      this.logger.warn(`[top-gainers] openPositionDirect ${cand.symbol} failed: ${String(e).slice(0, 200)}`);
      // Audit échec (non-bloquant) — équivalent du `position_open_failed` legacy
      await this.decisionLog.append({
        portfolioId,
        kind: 'position_open_failed',
        summary: `[GAINERS_DIRECT] ${cand.symbol} open failed: ${String(e).slice(0, 100)}`,
        rationale: 'Scanner Gainers direct path (PR #250). Reject ou exception sur openPositionDirect.',
        payload: {
          symbol: cand.symbol,
          asset_class: cand.assetClass,
          exchange: cand.exchange,
          score: cand.score,
          change_pct: cand.changePct,
          error_message: String(e).slice(0, 300),
          error_class: e instanceof Error ? e.constructor.name : 'unknown',
          source: 'scanner_top_gainers_direct',
        },
        triggeredBy: 'autopilot_cron',
      }).catch(() => { /* non-bloquant */ });
      return null;
    }
  }

  /**
   * P8 — Insert append-only dans paper_trades. Ne fait pas échouer le flow
   * principal en cas de pb (best effort, table optionnelle ce PR).
   * tpPct/slPct : valeurs effectives depuis DB (gainers_default_tp/sl_pct),
   * alignées avec les stops actifs dans openTopGainerPosition.
   */
  private async persistPaperTrade(
    userId: string,
    portfolioId: string,
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    openedPos: { id: string; entryPrice?: string | number; entryNotionalUsd?: string | number },
    persistence: PersistenceResult,
    tpPct: number,
    slPct: number,
    // PR #4 — pWin metrics persistés pour boucle apprentissage. Optionnel
    // (null si gate désactivé OU modèle non prêt).
    pWinMeta?: {
      pWin: number;
      modelVersion: string;
      sampleSize: number;
      features: Record<string, number>;
    } | null,
  ): Promise<void> {
    const entryPrice = Number(openedPos.entryPrice ?? cand.close);
    const sizeUsd = Number(openedPos.entryNotionalUsd ?? 0);
    const stopLoss = entryPrice * (1 - slPct / 100);
    const takeProfit = entryPrice * (1 + tpPct / 100);
    const tfChanges = {
      tf1m: persistence.tf1m,
      tf5m: persistence.tf5m,
      tf10m: persistence.tf10m,
      tf15m: persistence.tf15m,
      tf30m: persistence.tf30m,
      tf1h: persistence.tf1h,
    };
    const insertRow: Record<string, unknown> = {
      user_id: userId,
      portfolio_id: portfolioId,
      symbol: cand.symbol,
      asset_class: cand.assetClass,
      exchange: cand.exchange ?? null,
      entry_price: String(entryPrice),
      size_usd: String(sizeUsd || 0),
      stop_loss: String(stopLoss),
      take_profit: String(takeProfit),
      status: 'open',
      strategy: 'top_gainers_v1',
      scanner_position_id: openedPos.id,
      persistence_score_at_entry: String(persistence.persistenceScore.toFixed(2)),
      persistence_count_at_entry: persistence.persistenceCount,
      tf_changes_at_entry: tfChanges,
    };
    // PR #4 — features + p_win + model_version persistés pour boucle apprentissage
    if (pWinMeta) {
      insertRow.features_at_entry = pWinMeta.features;
      insertRow.p_win_at_entry = String(pWinMeta.pWin);
      insertRow.model_version_at_entry = pWinMeta.modelVersion;
    }
    await this.supabase.getClient().from('paper_trades').insert(insertRow);
  }

  /**
   * P18 — Analyse signal LLM : valide si le top candidat est un genuine momentum signal.
   * Fallback déterministe (pass=true) si router off ou échec LLM — comportement P17 préservé.
   */
  private async analyzeSignal(
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    persistence: PersistenceResult,
  ): Promise<{ pass: boolean; signal_quality: number; reason: string }> {
    const fallback = { pass: true, signal_quality: 1.0, reason: 'deterministic_fallback' };
    if (!this.llmRouter.isEnabled()) return fallback;
    try {
      const user = JSON.stringify({
        symbol: cand.symbol,
        assetClass: cand.assetClass,
        exchange: cand.exchange,
        changePct: cand.changePct,
        price: cand.close,
        volume: cand.volume,
        avgVol50d: cand.avgVol50d,
        persistenceScore: persistence.persistenceScore,
        persistenceCount: persistence.persistenceCount,
        tf1m: persistence.tf1m,
        tf5m: persistence.tf5m,
        tf10m: persistence.tf10m,
        tf15m: persistence.tf15m,
        tf30m: persistence.tf30m,
        tf1h: persistence.tf1h,
      });
      const res = await this.llmRouter.call({
        system:
          'You are a momentum scanner validating top market gainers. Assess if this is a genuine momentum signal or noise (pump-and-dump, thin volume, etc.). Return ONLY a JSON object: {"pass":true,"signal_quality":0.85,"reason":"brief reason max 60 chars"}. signal_quality in [0,1]. Set pass=false when signal_quality<0.4.',
        user,
        temperature: 0.1,
        maxTokens: 128,
      });
      const parsed = JSON.parse(res.content) as { pass: boolean; signal_quality: number; reason: string };
      this.logger.log(
        `[scanner-llm:signal] symbol=${cand.symbol} provider=${res.providerId} latencyMs=${res.latencyMs} costUsd=${res.costUsd.toFixed(6)} pass=${parsed.pass} signal_quality=${parsed.signal_quality}`,
      );
      return parsed;
    } catch (e) {
      this.logger.warn(`[scanner-llm:signal] ${cand.symbol} failed — deterministic fallback: ${String(e).slice(0, 100)}`);
      return fallback;
    }
  }

  /**
   * P18 — Re-ranking LLM : réordonne les top candidats par probabilité de continuation.
   * Fallback : ordre déterministe si router off ou échec LLM — comportement P17 préservé.
   */
  private async rankCandidates(
    top: Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>,
  ): Promise<Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>> {
    if (!this.llmRouter.isEnabled() || top.length <= 1) return top;
    try {
      const user = JSON.stringify(
        top.map((c) => ({ symbol: c.symbol, assetClass: c.assetClass, changePct: c.changePct, score: c.score, exchange: c.exchange })),
      );
      const res = await this.llmRouter.call({
        system:
          'You are a momentum scanner. Re-rank these candidates by expected momentum continuation probability. Return ONLY a JSON array of symbols in rank order, most promising first. Example: ["BTCUSDT","AAPL"]. Preserve all symbols.',
        user,
        temperature: 0.1,
        maxTokens: 128,
      });
      const ranked: string[] = JSON.parse(res.content);
      const reordered = [
        ...ranked
          .map((sym) => top.find((c) => c.symbol === sym))
          .filter((c): c is TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass } => c !== undefined),
        ...top.filter((c) => !ranked.includes(c.symbol)),
      ];
      const reordering = ranked.join(',') !== top.map((c) => c.symbol).join(',');
      this.logger.log(
        `[scanner-llm:ranking] symbols=${top.map((c) => c.symbol).join(',')} provider=${res.providerId} latencyMs=${res.latencyMs} costUsd=${res.costUsd.toFixed(6)} reordered=${reordering}`,
      );
      return reordered;
    } catch (e) {
      this.logger.warn(`[scanner-llm:ranking] failed — deterministic order preserved: ${String(e).slice(0, 100)}`);
      return top;
    }
  }

  /**
   * P18 — Génération de thèse LLM : produit un résumé descriptif pour la position.
   * Fallback : template déterministe si router off ou échec LLM — comportement P17 préservé.
   */
  private async generateThesis(
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
  ): Promise<{ summary: string; category: string; conviction_score: number }> {
    const fallback = {
      summary: `TopGainer ${cand.symbol} +${cand.changePct.toFixed(1)}% (${cand.assetClass})`,
      category: 'flow_timing',
      conviction_score: 7,
    };
    if (!this.llmRouter.isEnabled()) return fallback;
    try {
      const user = JSON.stringify({
        symbol: cand.symbol,
        assetClass: cand.assetClass,
        changePct: cand.changePct,
        exchange: cand.exchange,
        score: cand.score,
        volume: cand.volume,
      });
      const res = await this.llmRouter.call({
        system:
          'You are a momentum trading thesis writer. Write a concise intraday thesis for this top gainer. Return ONLY JSON: {"summary":"one-line thesis max 100 chars","category":"flow_timing|technical_breakout|momentum","conviction_score":7}. conviction_score 1-10.',
        user,
        temperature: 0.2,
        maxTokens: 128,
      });
      const parsed = JSON.parse(res.content) as { summary: string; category: string; conviction_score: number };
      this.logger.log(
        `[scanner-llm:thesis] symbol=${cand.symbol} provider=${res.providerId} latencyMs=${res.latencyMs} costUsd=${res.costUsd.toFixed(6)} category=${parsed.category} conviction=${parsed.conviction_score}`,
      );
      return parsed;
    } catch (e) {
      this.logger.warn(`[scanner-llm:thesis] ${cand.symbol} failed — deterministic fallback: ${String(e).slice(0, 100)}`);
      return fallback;
    }
  }

  /**
   * Persist log entries dans top_gainers_log.
   * Logge tous les top retenus (decision='passed') + sample de filtered (audit).
   */
  private async persistLog(
    allCandidates: TopGainerCandidate[],
    top: Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>,
  ): Promise<void> {
    const topSet = new Set(top.map((t) => t.symbol));
    const rows: Record<string, unknown>[] = [];
    // PR #246 — `top_gainers_log.volume` et `avg_vol_50d` sont déclarés BIGINT.
    // Binance retourne ces valeurs en float (ex: 850934.06) → INSERT fail avec
    // `invalid input syntax for type bigint: "850934.06"`. Math.round() avant.
    const toBigint = (n: number | undefined | null): number =>
      n == null || !Number.isFinite(n) ? 0 : Math.round(n);
    for (const t of top) {
      rows.push({
        symbol: t.symbol,
        market: t.assetClass,
        exchange: t.exchange ?? 'unknown',
        close_price: String(t.close),
        high_price: String(t.high),
        change_pct: String(t.changePct),
        volume: toBigint(t.volume),
        avg_vol_50d: toBigint(t.avgVol50d),
        market_cap_usd: String(t.marketCap),
        score: String(t.score),
        decision: 'passed',
        detected_asset_class: t.assetClass,
      });
    }
    // Sample 10 filtered candidates pour audit
    const filtered = allCandidates.filter((c) => !topSet.has(c.symbol)).slice(0, 10);
    for (const c of filtered) {
      rows.push({
        symbol: c.symbol,
        market: 'us_equity_small_mid', // best-effort, asset class non recalculée pour log
        exchange: c.exchange ?? 'unknown',
        close_price: String(c.close),
        high_price: String(c.high),
        change_pct: String(c.changePct),
        volume: toBigint(c.volume),
        avg_vol_50d: toBigint(c.avgVol50d),
        market_cap_usd: String(c.marketCap),
        score: '0',
        decision: 'filtered',
      });
    }
    if (rows.length === 0) {
      this.recordPersistLogAttempt(0);
      return;
    }
    const { error } = await this.supabase.getClient().from('top_gainers_log').insert(rows);
    if (error) {
      this.logger.debug(`[top-gainers] persistLog failed: ${error.message}`);
      this.recordPersistLogAttempt(rows.length, error.message);
      this.recordEarlyReturn('persist_log_failed', error.message);
    } else {
      this.recordPersistLogAttempt(rows.length);
    }
  }

  /**
   * Met à jour le log row avec opened_position_id après ouverture position.
   */
  private async markLogOpened(symbol: string, portfolioId: string, positionId: string): Promise<void> {
    await this.supabase.getClient()
      .from('top_gainers_log')
      .update({ decision: 'opened', opened_position_id: positionId, portfolio_id: portfolioId })
      .eq('symbol', symbol)
      .eq('decision', 'passed')
      .gte('captured_at', new Date(Date.now() - 60_000).toISOString());
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
