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
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { BinanceMarketService } from './binance-market.service';
import { MultiTimeframePersistenceService } from './multi-tf-persistence.service';
import { ScannerLlmRouterService } from './scanner-llm-router.service';
import {
  selectTopGainers,
  type TopGainerCandidate,
  type TopGainerAssetClass,
  type PersistenceResult,
  isWithinSession,
} from '@smartvest/ai-analyst';

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
const NON_EU_EXCHANGES = ['US', 'TSE', 'HK', 'AU', 'KO', 'KQ', 'TO', 'NSE', 'BSE', 'SS', 'SZ'];
/** Watchlists EU dont la session_open_utc / session_close_utc gate l'EODHD scan. */
const EU_WATCHLIST_NAMES = ['cac40', 'dax40', 'ftse100'];
const CRYPTO_PAIRS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT'];

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
 * P5-PIVOT-TOP-GAINERS v1 — Cap conservatif : 1 position/cycle.
 * Permet de valider end-to-end avant scaling à 3 (PR2).
 */
const MAX_POSITIONS_PER_CYCLE_V1 = 1;

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
  ) {}

  /**
   * P8 — Resolve config min persistence score.
   * Priority chain : DB > env > default(0.67).
   * `lisa_session_configs.gainers_min_persistence_score` est par-portfolio
   * mais le seuil est globalement uniforme dans v1 (1 valeur côté scanner).
   * Le caller passe `portfolioMinScore` quand il a la row sous la main ;
   * sinon on retombe sur env / default.
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
   * `SCAN_INTERVAL_MINUTES` (default 15). Range valide 1-1440 min.
   * Scheduling dynamique au boot : `fly secrets set SCAN_INTERVAL_MINUTES=5`
   * + reboot machine → cron tourne toutes les 5 min.
   *
   * UI dynamique (changement live sans reboot) = deferred PR2.
   */
  onModuleInit(): void {
    const raw = this.config.get<string>('SCAN_INTERVAL_MINUTES');
    const parsed = parseInt(String(raw ?? '15'), 10);
    const validated = Number.isFinite(parsed)
      ? Math.max(1, Math.min(1440, parsed))
      : 15;
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
    // P19v (30/04/2026 09:00 UTC) — SCANNER_PAUSE feature flag.
    // Émergency kill-switch sans deploy : `flyctl secrets set SCANNER_PAUSE=true`.
    // Pause le scanner cron + les calls EODHD screener associés. Permet d'éponger
    // une saturation quota sans toucher au code. Reset après 00:00 UTC = unset
    // ou false.
    const scannerPaused = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';
    if (scannerPaused) {
      this.logger.log('[top-gainers] SCANNER_PAUSE=true — cycle skipped');
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
        return;
      }
      configs = envConfigs ?? [];
      if (configs.length > 0) {
        this.logger.log(
          `[top-gainers] using env STRATEGY_MODE fallback (${configs.length} portfolios)`,
        );
      }
    }

    if (configs.length === 0) return;

    // Fetch global candidates UNE SEULE fois (partagé entre tous les portfolios)
    const candidates = await this.fetchAllCandidates();
    if (candidates.length === 0) {
      this.logger.warn('[top-gainers] 0 candidate fetched — skip cycle');
      return;
    }

    const top = selectTopGainers(candidates, 3);
    this.logger.log(
      `[top-gainers] ${candidates.length} scanned → ${top.length} retained: ${top.map((t) => `${t.symbol}(${t.assetClass},${t.changePct.toFixed(1)}%,score=${t.score})`).join(', ')}`,
    );

    // Persist log entries pour les top retenus + filtered samples (audit)
    await this.persistLog(candidates, top);

    if (top.length === 0) return;

    // P18 — LLM re-ranking (inert when SCANNER_LLM_ROUTER_ENABLED=false)
    const rankedTop = await this.rankCandidates(top);

    // P9-UX — Pour chaque portfolio, gate par per-portfolio cycle puis scan.
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
        await this.scanPortfolio(cfg.user_id as string, portfolioId, rankedTop);
      } catch (e) {
        this.logger.warn(
          `[top-gainers] portfolio ${portfolioId.slice(0, 8)} failed: ${String(e).slice(0, 120)}`,
        );
      }
    }
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
    const scannerPaused = (this.config.get<string>('SCANNER_PAUSE') ?? 'false').toLowerCase() === 'true';
    if (scannerPaused) {
      this.logger.debug('[top-gainers] SCANNER_PAUSE=true — fetchAllCandidates returns cache');
      return this.allCandidatesCache?.candidates ?? [];
    }

    // P19s++ — Cache hit (TTL 15min). Évite N×11 calls EODHD quand l'UI
    // poll /lisa/gainers-persistence-snapshot toutes les 60s.
    if (
      this.allCandidatesCache
      && now.getTime() - this.allCandidatesCache.asOf < this.ALL_CANDIDATES_CACHE_TTL_MS
    ) {
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
          this.fetchEodhdScreener(ex, apiKey).catch((e) => {
            this.logger.warn(`[top-gainers] ${ex} failed: ${e?.message ?? String(e)}`);
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
    tasks.push(this.fetchBinanceGainers().catch(() => []));

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

  private mapEodhdRow(r: EodhdScreenerRow, exchange: string): TopGainerCandidate | null {
    const symbol = r.code;
    if (!symbol) return null;
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
          close: t.lastPrice,
          high: t.high ?? t.lastPrice,
          changePct: t.priceChangePct,
          volume: t.quoteVolume ?? 0,
          avgVol50d: 0,
          marketCap: 0, // Crypto major filter ne nécessite pas marketCap si on whitelist top pairs
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
    top: Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>,
  ): Promise<void> {
    // P19x.4 — Watchdog expectancy : skip opens si E<0 sur 10 derniers trades.
    const expectancyNegative = await this.checkExpectancyWatchdog(portfolioId);
    if (expectancyNegative) {
      return; // skip cycle pour ce portfolio
    }

    // Garde-fou : count current open positions
    const { data: openPositions } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const openSymbols = new Set((openPositions ?? []).map((p) => String(p.symbol).toUpperCase()));
    const maxOpen = 3;
    const slotsAvailable = Math.max(0, maxOpen - (openPositions?.length ?? 0));
    if (slotsAvailable === 0) {
      this.logger.log(`[top-gainers] ${portfolioId.slice(0, 8)}: no slots (${openPositions?.length}/3 open)`);
      return;
    }

    // P8 + P19x.2 — Charge config gainers pour ce portfolio :
    // min persistance + path efficiency + TP/SL defaults.
    const { data: cfgRow } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('gainers_min_persistence_score, gainers_min_path_efficiency, gainers_default_tp_pct, gainers_default_sl_pct')
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

    // P8 — Calcule la persistance multi-TF pour les top candidats (parallèle)
    const persistenceMap = await this.mtfPersistence.analyzeBatch(
      top.map((c) => ({
        symbol: c.symbol,
        exchange: c.exchange,
        currentPrice: c.close,
      })),
    );

    // Guard 3 v1 — cap conservatif : 1 position/cycle (test prudent avant
    // bump à 3 dans v2). Permet de valider le pipeline end-to-end.
    const maxThisCycle = Math.min(slotsAvailable, MAX_POSITIONS_PER_CYCLE_V1);
    let opened = 0;
    // P18e — accumule les skips pour log agrégé en fin de cycle (au lieu de
    // N lignes "no persistence data → skip" qui polluent les logs Fly).
    const skippedNoPersistence: string[] = [];
    // P19x.3 (29/04/2026) — Cooldown 30 min same symbol/side après close.
    //
    // User constat (29/04 02:00 UTC) : "Observé SLV 3× / LMT 3× / XLE 2× en
    // boucle = churn fees pur." Le scanner ouvre un trade, le ferme, le
    // re-ouvre 5 min plus tard sur le même symbol/side car le ticker reste
    // top gainer et passe les gates → fees s'accumulent sans valeur ajoutée.
    //
    // Garde-fou : refuse toute open sur un (symbol, direction) si une
    // position était fermée pour ce couple dans les 30 dernières minutes.
    // Lookup unique par cycle : on charge tous les recent closes avant la
    // boucle puis on check en mémoire (évite N queries DB).
    const cooldownMs = 30 * 60_000;
    const cooldownSinceIso = new Date(Date.now() - cooldownMs).toISOString();
    // Failure-tolerant : si la query échoue (mock partiel en test, schema
    // out-of-sync, etc.), on passe le cooldown sans bloquer le pipeline.
    // Le worst case est de ré-ouvrir un trade fermé < 30 min — c'est ce qu'on
    // observait avant P19x.3 et le P19x.1 MIN_NET_PROFIT guard limite déjà
    // les fake TPs en cascade.
    const recentCloseByKey = new Map<string, number>();
    try {
      const { data: recentClosesRaw } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('symbol, direction, exit_timestamp')
        .eq('portfolio_id', portfolioId)
        .neq('status', 'open')
        .gte('exit_timestamp', cooldownSinceIso);
      for (const row of recentClosesRaw ?? []) {
        const key = `${String(row.symbol).toUpperCase()}::${String(row.direction)}`;
        const exitMs = new Date(String(row.exit_timestamp)).getTime();
        if (!Number.isFinite(exitMs)) continue;
        const prev = recentCloseByKey.get(key) ?? 0;
        if (exitMs > prev) recentCloseByKey.set(key, exitMs);
      }
    } catch (e) {
      this.logger.debug(`[top-gainers] cooldown query skipped: ${String(e).slice(0, 100)}`);
    }

    for (const cand of top) {
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
          `[top-gainers] ${cand.symbol} cooldown actif (fermé il y a ${elapsedMin} min < 30 min) → skip re-entry`,
        );
        continue;
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
        // NB : 4/6 = 0.66666… donc le cutoff est 0.66, PAS 0.67. Le seuil
        // historique `gainers_min_persistence_score` default = 0.67 est en
        // pratique strict ≥ 5/6 (0.8333 ≥ 0.67 ✓ ; 0.6667 < 0.67 ✗).
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

        if (persistence.persistenceScore < minScore) {
          this.logger.log(
            `[top-gainers] ${cand.symbol} persistenceScore=${persistence.persistenceScore.toFixed(2)} (${persistence.persistenceCount}) < min=${minScore.toFixed(2)} → skip`,
          );
          continue;
        }
        // P9-UX ADDENDUM — Path quality gate (skip pump-and-dump qui passent persistence)
        if (
          minPathEff != null &&
          persistence.pathQuality &&
          persistence.pathQuality.overallEfficiency != null &&
          persistence.pathQuality.overallEfficiency < minPathEff
        ) {
          this.logger.log(
            `[top-gainers] ${cand.symbol} pathEff=${persistence.pathQuality.overallEfficiency.toFixed(2)} (${persistence.pathQuality.overallSmoothness}) < min=${minPathEff.toFixed(2)} → skip`,
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

      const insertedPosId = await this.openTopGainerPosition(
        userId,
        portfolioId,
        cand,
        persistence,
        { tpPct, slPct },
      ).catch((e) => {
        this.logger.warn(
          `[top-gainers] open ${cand.symbol} failed: ${String(e).slice(0, 120)}`,
        );
        return null;
      });
      if (insertedPosId) {
        opened++;
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
   * Crée une pseudo-proposal + thèse minimale, puis call paperBroker.openPosition.
   * Le paperBroker existant exige (proposalId, thesisId) → on synthétise ces 2.
   *
   * P8 — Si `persistence` fourni, persiste les métriques multi-TF au moment
   * de l'open dans `paper_trades` (forward-compat avec P9).
   */
  private async openTopGainerPosition(
    userId: string,
    portfolioId: string,
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    persistence?: PersistenceResult,
    // P19x.2 — TP/SL config par portfolio (DB lisa_session_configs.gainers_default_*).
    // Fallback aux nouveaux defaults P19x.2 spec : TP=1.5% / SL=1.0%.
    overrides?: { tpPct: number; slPct: number },
  ): Promise<string | null> {
    const proposalId = randomUUID();
    const thesisId = randomUUID();
    const effectiveTp = overrides?.tpPct ?? 1.5;
    const effectiveSl = overrides?.slPct ?? 1.0;

    // P18 — LLM thesis generation (inert when SCANNER_LLM_ROUTER_ENABLED=false)
    const llmThesis = await this.generateThesis(cand);

    const thesis = {
      id: thesisId,
      summary: llmThesis.summary,
      conviction: 0.7,
      conviction_score: llmThesis.conviction_score,
      category: llmThesis.category,
      kind: 'momentum',
      preferredExpressionIndex: 0,
      expressions: [
        {
          symbol: cand.symbol,
          assetClass: cand.assetClass,
          direction: 'long',
          venue: cand.exchange ?? 'unknown',
          // P19x.2 — Lit DB : default 1.5% TP / 1.0% SL (vs 3.0/1.5 pré-P19x.2).
          // User spec (29/04 02:00 UTC) : lock profits earlier + tighter stops.
          stopLossPct: effectiveSl,
          takeProfitPct: effectiveTp,
          horizonDays: 1,
        },
      ],
    };
    const allocations = [
      { thesisId, pctCapital: 30, amountUsd: '3000.00' },
    ];

    // INSERT pseudo-proposal
    const { error: insErr } = await this.supabase.getClient().from('lisa_proposals').insert({
      id: proposalId,
      portfolio_id: portfolioId,
      user_id: userId,
      capital_usd: '10000.00',
      base_currency: 'USD',
      detected_regime: 'momentum_top_gainers',
      market_momentum: 'bullish_strong',
      regime_summary: `TopGainer scanner candidate: ${cand.symbol} ${cand.assetClass}`,
      favored_pockets: [],
      avoided_pockets: [],
      theses: [thesis],
      allocations,
      cash_reserve_pct: 70,
      warnings: [],
      status: 'proposed',
      claude_cost_usd: 0,
      generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    });
    if (insErr) {
      this.logger.warn(`[top-gainers] insert pseudo-proposal failed: ${insErr.message}`);
      return null;
    }

    // Call approveProposal (réutilise toute la logique cooldown / max_pos /
    // cash buffer / fallback price guard / decision_log position_opened).
    try {
      const result = await this.lisa.approveProposal(userId, proposalId);
      if (result.openedPositions.length === 0) {
        this.logger.log(`[top-gainers] ${cand.symbol}: approveProposal returned 0 (rejected by gates)`);
        return null;
      }
      const openedPos = result.openedPositions[0];
      this.logger.log(
        `[top-gainers] ${cand.symbol} opened (${result.openedPositions.length} pos, score=${cand.score})`,
      );

      // P8 — best-effort persist du snapshot persistance dans paper_trades
      // (forward-compat avec P9 qui ajoutera features_at_entry / p_win).
      if (persistence) {
        await this.persistPaperTrade(userId, portfolioId, cand, openedPos, persistence)
          .catch((e) =>
            this.logger.debug(`[top-gainers] persistPaperTrade ${cand.symbol} failed: ${String(e).slice(0, 120)}`),
          );
      }

      return openedPos.id;
    } catch (e) {
      this.logger.warn(`[top-gainers] approveProposal ${cand.symbol} failed: ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * P8 — Insert append-only dans paper_trades. Ne fait pas échouer le flow
   * principal en cas de pb (best effort, table optionnelle ce PR).
   */
  private async persistPaperTrade(
    userId: string,
    portfolioId: string,
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
    openedPos: { id: string; entryPrice?: string | number; entryNotionalUsd?: string | number },
    persistence: PersistenceResult,
  ): Promise<void> {
    const entryPrice = Number(openedPos.entryPrice ?? cand.close);
    const sizeUsd = Number(openedPos.entryNotionalUsd ?? 0);
    const stopLoss = entryPrice * (1 - 0.015);
    const takeProfit = entryPrice * (1 + 0.03);
    const tfChanges = {
      tf1m: persistence.tf1m,
      tf5m: persistence.tf5m,
      tf10m: persistence.tf10m,
      tf15m: persistence.tf15m,
      tf30m: persistence.tf30m,
      tf1h: persistence.tf1h,
    };
    await this.supabase.getClient().from('paper_trades').insert({
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
    });
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
    for (const t of top) {
      rows.push({
        symbol: t.symbol,
        market: t.assetClass,
        exchange: t.exchange ?? 'unknown',
        close_price: String(t.close),
        high_price: String(t.high),
        change_pct: String(t.changePct),
        volume: t.volume,
        avg_vol_50d: t.avgVol50d,
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
        volume: c.volume,
        avg_vol_50d: c.avgVol50d,
        market_cap_usd: String(c.marketCap),
        score: '0',
        decision: 'filtered',
      });
    }
    if (rows.length === 0) return;
    const { error } = await this.supabase.getClient().from('top_gainers_log').insert(rows);
    if (error) this.logger.debug(`[top-gainers] persistLog failed: ${error.message}`);
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
