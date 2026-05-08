import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { bootstrapMeanCI, verdictFromCI, GateVerdict } from '@smartvest/ai-analyst';

/**
 * GainersUserShadowService — PR #280
 *
 * Mesure le regret-cost des gates user-pipeline (path_eff, persistence,
 * cooldown, etc.). Distinct du shadow V1 BLOC1 (gainers_v1_shadow_signals)
 * qui est pour la migration ADR-005.
 *
 * Workflow :
 *   1. À chaque gate dans TopGainersScannerService.scanPortfolio, le
 *      scanner appelle `recordDecision(...)` avec le candidat + raison.
 *   2. simulatePending() (appelé en début de chaque cycle scanner) walk-
 *      forward sur candles 5m EODHD pour trouver TP_HIT / SL_HIT / TIME_LIMIT.
 *   3. getRegretSummary() aggrège par gate × grille avec bootstrap CI 95%
 *      sur sim_pnl_pct → verdict GATE_TOO_STRICT / GATE_HEALTHY / INCONCLUSIVE.
 *
 * Slippage haircut : 30bps round-trip (15bps × 2) sur chaque pnl_pct simulé,
 * soustrait avant persistence.
 */

export type ShadowDecision =
  | 'accept'
  | 'reject_path_eff'
  | 'reject_persistence'
  | 'reject_cooldown'
  | 'reject_post_sl_cooldown'
  | 'reject_p_win'
  | 'reject_budget_cap'
  | 'reject_no_tf_data'
  | 'reject_other';

export interface RecordDecisionInput {
  portfolioId: string;
  symbol: string;          // ex "WFCF.US" or "AAPL"
  assetClass: string;      // 'us_equity_small_mid' etc.
  isAsia: boolean;
  changePct1m: number | null;
  score: number | null;
  pathEff: number | null;
  persistenceScore: number | null;
  persistenceCount: string | null;  // "5/6"
  entryPrice: number | null;
  notionalUsd: number;
  decision: ShadowDecision;
  cfg: {
    minPathEff: number | null;
    minPersistence: number | null;
    asiaBoost: number | null;
    tpPct: number;
    slPct: number;
  };
}

export interface SimGrid {
  key: string;
  tpPct: number;
  slPct: number;
  windowMin: number;
}

const SIM_GRIDS: SimGrid[] = [
  { key: 'baseline_30m', tpPct: 0.020, slPct: 0.009, windowMin: 30 },
  { key: 'baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60 },
  { key: 'alt15_30m',    tpPct: 0.015, slPct: 0.006, windowMin: 30 },
  { key: 'alt15_60m',    tpPct: 0.015, slPct: 0.006, windowMin: 60 },
];

// PR #288 — TZ offset par exchange Asia/Pacific.
//
// Bug observé prod 08/05/2026 07:30 UTC : Asia rows 100% NO_DATA même
// après PR #284-#287. Diagnostic via fetch_diag JSONB (PR #287) confirme :
// EODHD intraday renvoie les timestamps des candles encodés en LOCAL exchange
// time traités comme UTC. Pour 300161.SHE Shenzhen :
//   - Candle réelle close à 15:00 CST (= 07:00 UTC May 8)
//   - EODHD encode timestamp = "2026-05-07 23:00 UTC" (= 15:00 CST en lecture
//     naïve treating as UTC, soit -8h vs real UTC)
// → notre filtre `c.timestamp >= startTs` (en real UTC) rejette tout.
//
// Fix : ajouter l'offset timezone de l'exchange aux timestamps avant filter.
// Vérifié manuellement par utilisateur via SQL : step4_last + 8h = ~Shenzhen
// close TODAY ; step4_last + 9h = ~KOSDAQ close TODAY. Cohérent.
//
// Sources : ces offsets sont stables (pas de DST en Asia/China/Korea/Japan).
// Australie a DST mais en May/June = AEST stable UTC+10. DST Australia
// (Oct-Avr UTC+11) sera fix follow-up si besoin.
const EXCHANGE_UTC_OFFSET_SEC: Record<string, number> = {
  SHE: 8 * 3600,   // Shenzhen — China Standard Time (no DST)
  SHG: 8 * 3600,   // Shanghai
  HK:  8 * 3600,   // Hong Kong
  KO:  9 * 3600,   // KOSPI — Korea Standard Time (no DST)
  KQ:  9 * 3600,   // KOSDAQ
  T:   9 * 3600,   // Tokyo — JST (no DST)
  AU: 10 * 3600,   // ASX — AEST (May-Sep, no DST during this window)
};

export function getExchangeUtcOffsetSec(symbol: string | null | undefined): number {
  if (!symbol) return 0;
  const suffix = symbol.split('.').pop()?.toUpperCase() ?? '';
  return EXCHANGE_UTC_OFFSET_SEC[suffix] ?? 0;
}

const SLIPPAGE_HAIRCUT_BILATERAL = 0.0015;  // 15bps each side
const SLIPPAGE_TOTAL = SLIPPAGE_HAIRCUT_BILATERAL * 2;  // 30bps round-trip
const SIMULATE_AFTER_MIN = 60;  // attendre que la fenêtre 60m soit close
const SIMULATE_BATCH_SIZE = 50;

// PR #283 — Lookback fenêtre 5m pour fetch candles. Configurable via env
// `USER_SHADOW_5M_LOOKBACK_MIN` (default 150 min). Couvre largement la sim
// window 60min + un buffer pour les rows pickées tardivement par le worker
// (cron lag, ré-essais retro). Floor 75min (= 15 candles, le minimum
// historique avant PR #283 où on observait 100% NO_DATA à cause du bug
// d'ordering DESC dans walkForward).
const SHADOW_5M_LOOKBACK_MIN_DEFAULT = 150;
function resolveShadowLookbackCandles(): number {
  const raw = process.env.USER_SHADOW_5M_LOOKBACK_MIN;
  const minutes = raw != null ? Number(raw) : SHADOW_5M_LOOKBACK_MIN_DEFAULT;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return Math.ceil(SHADOW_5M_LOOKBACK_MIN_DEFAULT / 5);
  }
  return Math.max(15, Math.ceil(minutes / 5));
}

export interface SimOutcome {
  outcome: 'TP_HIT' | 'SL_HIT' | 'TIME_LIMIT' | 'NO_DATA' | 'OFF_SESSION';
  exit_price: number | null;
  exit_at: string | null;
  pnl_pct: number | null;       // NET (slippage already subtracted)
  hit_at_min: number | null;
}

// PR #286 — fetch_diag schema persisté en JSONB après chaque sim.
// Permet SQL post-mortem de la fallback chain sans grep Fly logs.
export interface FetchDiagStep {
  endpoint: string;             // 'eodhd_getCandles_5m_range' | 'eodhd_ticks_range' | ...
  interval: '1m' | '5m' | '1h';
  rangeMode: boolean;
  fromTs: number | null;
  toTs: number | null;
  inputSymbol: string;
  requestedSymbol: string | null;
  rawCount: number;             // pre-filter close>0 (selon fallback path)
  validClose: number;           // post-filter
  nulls: number;                // rawCount - validClose
  ms: number;                   // latency
  // PR #287 — Diagnostic timestamps : extrema des candles retournées par
  // ce step. Permet SQL post-deploy de comparer aux startTs/cutoffTs et
  // détecter cause exacte du `forward_count=0` malgré `selectedStep>=0`.
  // Populated UNIQUEMENT quand validClose > 0 (sinon undefined).
  firstCandleTs?: number;
  lastCandleTs?: number;
  // PR #287 — forwardCount par step (= candles avec timestamp >= startTs).
  // Pour le step `selectedStep`, c'est le même que fetchDiag.forwardCount
  // (compatibility). Pour les autres, undefined (on ne calcule pas).
  forwardCountAfterFilter?: number;
  error?: string;
}
export interface FetchDiag {
  steps: FetchDiagStep[];
  selectedStep: number | null;  // index 0-based dans steps[] qui a fourni les candles
  forwardCount: number;         // post normalize+filter par startTs
  outcome: 'ok' | 'no_data' | 'error' | 'off_session';
  // PR #287 — Pour analyse SQL : on persiste startTs et cutoffTs (sim window
  // 60min). Sans ça il faut recalculer depuis created_at à chaque query.
  startTs?: number;
  cutoffTs60?: number;
  // PR #288 — Offset TZ appliqué sur les candles (positif si Asia/Pacific,
  // 0 sinon). Audit SQL : permet de vérifier qu'on a bien shifté pour Asia
  // et de débugguer si certains tickers sont mal détectés.
  applied_tz_offset_sec?: number;
}

// PR #283 — Type minimal pour walkForward (ne nécessite pas EodhdIntradayService.Candle)
export interface CandleLike {
  timestamp: number;  // unix seconds (auto-normalisé si en ms)
  high: number;
  low: number;
  close: number;
}

/**
 * PR #283 — Normalise les candles avant walkForward :
 *   1. Auto-detect ms vs seconds : si timestamp > 1e12 (= année 33658 en sec,
 *      = ~2001 en ms), on divise par 1000 (ms → s).
 *   2. Sort ASC (most-old-first). EODHD intraday retournait DESC, ce qui
 *      cassait walkForward (premier candle hors cutoff → break immédiat
 *      → lastBeforeCutoff null → NO_DATA). Bug observé prod 07/05/2026
 *      sur 1304 rows / 24h, 100% NO_DATA.
 *
 * Fonction pure exportée pour testabilité.
 */
export function normalizeAndSortCandles<T extends CandleLike>(candles: readonly T[]): T[] {
  return [...candles]
    .map((c) => (
      c.timestamp > 1e12 ? { ...c, timestamp: Math.floor(c.timestamp / 1000) } : c
    ))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * PR #283 — walkForward : itère les candles ASCENDING, applique TP/SL d'une
 * grille (TP%, SL%, windowMin), retourne le premier hit ou TIME_LIMIT.
 *
 * Conventions :
 *   - candles DOIVENT être triées ASC (utiliser normalizeAndSortCandles)
 *   - candles[i].timestamp en unix seconds
 *   - startTs en unix seconds (timestamp de la décision originale)
 *   - tie-break SL-first si les deux pourraient déclencher dans la même
 *     candle 5m (impossible de connaître l'ordre intra-bougie sans tick data)
 *   - slippage haircut SLIPPAGE_TOTAL (30bps) appliqué au pnl_pct net
 *
 * Fonction pure exportée pour testabilité.
 */
export function walkForward(
  entry: number,
  candles: readonly CandleLike[],
  startTs: number,
  grid: SimGrid,
): SimOutcome {
  const tpPrice = entry * (1 + grid.tpPct);
  const slPrice = entry * (1 - grid.slPct);
  const cutoffTs = startTs + grid.windowMin * 60;
  let lastBeforeCutoff: CandleLike | null = null;

  for (const c of candles) {
    if (c.timestamp > cutoffTs) break;
    lastBeforeCutoff = c;
    if (c.low <= slPrice) {
      return {
        outcome: 'SL_HIT',
        exit_price: slPrice,
        exit_at: new Date(c.timestamp * 1000).toISOString(),
        pnl_pct: -grid.slPct - SLIPPAGE_TOTAL,
        hit_at_min: Math.round((c.timestamp - startTs) / 60),
      };
    }
    if (c.high >= tpPrice) {
      return {
        outcome: 'TP_HIT',
        exit_price: tpPrice,
        exit_at: new Date(c.timestamp * 1000).toISOString(),
        pnl_pct: grid.tpPct - SLIPPAGE_TOTAL,
        hit_at_min: Math.round((c.timestamp - startTs) / 60),
      };
    }
  }

  if (lastBeforeCutoff) {
    const closePnl = (lastBeforeCutoff.close - entry) / entry;
    return {
      outcome: 'TIME_LIMIT',
      exit_price: lastBeforeCutoff.close,
      exit_at: new Date(lastBeforeCutoff.timestamp * 1000).toISOString(),
      pnl_pct: closePnl - SLIPPAGE_TOTAL,
      hit_at_min: Math.round((lastBeforeCutoff.timestamp - startTs) / 60),
    };
  }
  return { outcome: 'NO_DATA', exit_price: null, exit_at: null, pnl_pct: null, hit_at_min: null };
}

@Injectable()
export class GainersUserShadowService {
  private readonly logger = new Logger(GainersUserShadowService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eodhd: EodhdIntradayService,
  ) {}

  /**
   * Capture une décision (ACCEPT ou REJECT) au moment où le scanner traverse
   * un gate. Fire-and-forget : non-bloquant, erreur loggée mais n'arrête pas
   * le cycle scanner.
   */
  async recordDecision(input: RecordDecisionInput): Promise<void> {
    try {
      await this.supabase.getClient().from('gainers_user_shadow_signals').insert({
        portfolio_id: input.portfolioId,
        symbol: input.symbol,
        asset_class: input.assetClass,
        change_pct_1m: input.changePct1m,
        score: input.score,
        path_eff: input.pathEff,
        persistence_score: input.persistenceScore,
        persistence_count: input.persistenceCount,
        entry_price: input.entryPrice,
        notional_usd: input.notionalUsd,
        decision: input.decision,
        cfg_min_path_eff: input.cfg.minPathEff,
        cfg_min_persistence: input.cfg.minPersistence,
        cfg_asia_boost: input.cfg.asiaBoost,
        cfg_tp_pct: input.cfg.tpPct,
        cfg_sl_pct: input.cfg.slPct,
        is_asia: input.isAsia,
      });
    } catch (e) {
      this.logger.warn(`[user-shadow] recordDecision failed for ${input.symbol}: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Pick rows where sim_run_at IS NULL AND created_at > 60 min ago,
   * fetch 5m candles forward, walk-forward to find TP/SL hits sur 4 grilles.
   * Cap batch à SIMULATE_BATCH_SIZE pour éviter timeouts.
   */
  async simulatePending(): Promise<{ processed: number; failures: number }> {
    const cutoff = new Date(Date.now() - SIMULATE_AFTER_MIN * 60_000).toISOString();
    const { data: rows, error } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .select('id, symbol, asset_class, entry_price, created_at')
      .is('sim_run_at', null)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(SIMULATE_BATCH_SIZE);

    if (error) {
      this.logger.warn(`[user-shadow] simulatePending query failed: ${error.message}`);
      return { processed: 0, failures: 1 };
    }
    if (!rows || rows.length === 0) return { processed: 0, failures: 0 };

    let processed = 0;
    let failures = 0;
    for (const row of rows) {
      try {
        const { results: simResults, fetchDiag } = await this.simulateRow({
          symbol: String(row.symbol),
          assetClass: String(row.asset_class),
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          createdAt: String(row.created_at),
        });
        await this.supabase.getClient()
          .from('gainers_user_shadow_signals')
          .update({
            sim_results: simResults,
            fetch_diag: fetchDiag,        // PR #286 — diagnostic JSONB
            sim_run_at: new Date().toISOString(),
            sim_window_max_min: 60,
          })
          .eq('id', row.id);
        processed++;
      } catch (e) {
        failures++;
        this.logger.warn(`[user-shadow] simulate ${row.symbol} failed: ${String(e).slice(0, 100)}`);
        // Mark as run with empty results to avoid infinite retry.
        // PostgrestFilterBuilder is thenable but not a Promise — wrap in
        // try/catch instead of .catch().
        try {
          await this.supabase.getClient()
            .from('gainers_user_shadow_signals')
            .update({ sim_results: { error: String(e).slice(0, 200) }, sim_run_at: new Date().toISOString() })
            .eq('id', row.id);
        } catch { /* nothing */ }
      }
    }
    if (processed > 0 || failures > 0) {
      this.logger.log(`[user-shadow] simulated ${processed} rows (${failures} failures)`);
    }
    return { processed, failures };
  }

  private async simulateRow(args: {
    symbol: string;
    assetClass: string;
    entryPrice: number | null;
    createdAt: string;
  }): Promise<{ results: Record<string, SimOutcome>; fetchDiag: FetchDiag }> {
    const results: Record<string, SimOutcome> = {};
    const noEntry = (): SimOutcome => ({
      outcome: 'NO_DATA', exit_price: null, exit_at: null, pnl_pct: null, hit_at_min: null,
    });
    const fetchDiag: FetchDiag = {
      steps: [],
      selectedStep: null,
      forwardCount: 0,
      outcome: 'no_data',
    };

    if (args.entryPrice == null || args.entryPrice <= 0) {
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      fetchDiag.outcome = 'error';
      fetchDiag.steps.push({
        endpoint: 'precondition',
        interval: '5m',
        rangeMode: false,
        fromTs: null,
        toTs: null,
        inputSymbol: args.symbol,
        requestedSymbol: null,
        rawCount: 0,
        validClose: 0,
        nulls: 0,
        ms: 0,
        error: 'no_entry_price',
      });
      return { results, fetchDiag };
    }

    // Crypto = no support yet (would need Binance klines), skip gracefully
    if (args.assetClass === 'crypto_major' || args.assetClass === 'crypto_alt') {
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      fetchDiag.outcome = 'error';
      fetchDiag.steps.push({
        endpoint: 'precondition',
        interval: '5m',
        rangeMode: false,
        fromTs: null,
        toTs: null,
        inputSymbol: args.symbol,
        requestedSymbol: null,
        rawCount: 0,
        validClose: 0,
        nulls: 0,
        ms: 0,
        error: 'crypto_not_supported',
      });
      return { results, fetchDiag };
    }

    const eodhdTicker = args.symbol;
    const startTs = new Date(args.createdAt).getTime() / 1000;
    const fromTs = Math.floor(startTs - 300);
    const toTs = Math.floor(startTs + 60 * 60 + 300);
    const candleCount = resolveShadowLookbackCandles();
    const isAsia = args.assetClass === 'asia_equity';
    // PR #287 — Capture top-level pour SQL post-mortem (vs recalcul depuis created_at)
    fetchDiag.startTs = Math.floor(startTs);
    fetchDiag.cutoffTs60 = Math.floor(startTs + 60 * 60);

    // PR #286 — Fallback chain alignée sur MultiTimeframePersistenceService
    // (cf. multi-tf-persistence.service.ts:321-431) mais adaptée pour le
    // mode range-fetch (PR #284). L'ordre maximise la probabilité de
    // récupérer des candles dans la fenêtre [startTs - 5min, +65min]
    // d'un row potentiellement vieux de plusieurs heures :
    //
    //   step1 : EODHD getCandles 5m + range mode  (primary, déjà testé)
    //   step2 : EODHD getCandlesViaTicks 5m + range  (sparse coverage)
    //   step3 : EODHD getCandles 1m + range mode  (parfois plus complet sur Asia)
    //   step4 : EODHD getCandles 5m + DEFAULT mode + filter client-side
    //           (si range mode pète, default mode peut couvrir si row récent)
    //
    // Chaque step alimente fetchDiag.steps[] persisté en JSONB pour SQL
    // post-mortem. selectedStep = index du premier step qui a fourni
    // assez de candles pour walkForward.

    type StepDef = {
      endpoint: string;
      interval: '1m' | '5m';
      fn: () => Promise<{ candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>; rawCount?: number; requestedSymbol?: string } | null>;
      rangeMode: boolean;
    };
    const stepDefs: StepDef[] = [
      {
        endpoint: 'eodhd_getCandles_5m_range',
        interval: '5m',
        rangeMode: true,
        fn: () => this.eodhd.getCandles(eodhdTicker, '5m', candleCount, { fromTs, toTs }).catch(() => null),
      },
      {
        endpoint: 'eodhd_ticks_5m_range',
        interval: '5m',
        rangeMode: true,
        fn: () => this.eodhd.getCandlesViaTicks(eodhdTicker, '5m', candleCount, { fromTs, toTs }).catch(() => null),
      },
      {
        endpoint: 'eodhd_getCandles_1m_range',
        interval: '1m',
        rangeMode: true,
        fn: () => this.eodhd.getCandles(eodhdTicker, '1m', 65, { fromTs, toTs }).catch(() => null),
      },
      {
        endpoint: 'eodhd_getCandles_5m_default',
        interval: '5m',
        rangeMode: false,
        fn: () => this.eodhd.getCandles(eodhdTicker, '5m', candleCount).catch(() => null),
      },
    ];

    let selectedSeries: { candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> } | null = null;
    for (let i = 0; i < stepDefs.length; i++) {
      const step = stepDefs[i];
      const t0 = Date.now();
      const series = await step.fn();
      const ms = Date.now() - t0;
      const validClose = series?.candles?.length ?? 0;
      const rawCount = series?.rawCount ?? validClose;
      const stepEntry: FetchDiagStep = {
        endpoint: step.endpoint,
        interval: step.interval,
        rangeMode: step.rangeMode,
        fromTs: step.rangeMode ? fromTs : null,
        toTs: step.rangeMode ? toTs : null,
        inputSymbol: args.symbol,
        // PR #287 — Force fallback à inputSymbol si requestedSymbol est null
        // (cas où la call EODHD a retourné null sans construire de series).
        // Permet diagnostic SQL : voir le ticker qu'on AURAIT envoyé.
        requestedSymbol: series?.requestedSymbol ?? args.symbol,
        rawCount,
        validClose,
        nulls: rawCount - validClose,
        ms,
      };
      // PR #287 — Capture extrema timestamps (utiles SQL pour comparer
      // au startTs et identifier les patterns "candles d'une session OLDER").
      if (series?.candles && series.candles.length > 0) {
        const tsList = series.candles.map((c) => Number(c.timestamp)).filter((t) => Number.isFinite(t));
        if (tsList.length > 0) {
          stepEntry.firstCandleTs = Math.min(...tsList);
          stepEntry.lastCandleTs = Math.max(...tsList);
          stepEntry.forwardCountAfterFilter = tsList.filter((t) => {
            // Auto-detect ms vs s (mirror normalizeAndSortCandles logic)
            const tsec = t > 1e12 ? Math.floor(t / 1000) : t;
            return tsec >= startTs;
          }).length;
        }
      }
      fetchDiag.steps.push(stepEntry);

      if (isAsia) {
        this.logger.warn(
          `[user-shadow-fetch-asia] step${i + 1}=${step.endpoint} ` +
          `inputSymbol=${args.symbol} requestedSymbol=${stepEntry.requestedSymbol ?? 'n/a'} ` +
          `rangeMode=${step.rangeMode} rawCount=${rawCount} validClose=${validClose} nulls=${stepEntry.nulls} ms=${ms}`,
        );
      }

      if (validClose > 0) {
        selectedSeries = series;
        fetchDiag.selectedStep = i;
        break;
      }
    }

    this.logger.log(
      `[user-shadow-fetch] ${eodhdTicker}: from=${fromTs} to=${toTs} ` +
      `selectedStep=${fetchDiag.selectedStep ?? 'none'} got=${selectedSeries?.candles?.length ?? 0}`,
    );

    if (!selectedSeries || selectedSeries.candles.length === 0) {
      if (isAsia) {
        this.logger.warn(
          `[user-shadow-fetch-asia] EARLY_RETURN_NO_DATA inputSymbol=${args.symbol} ` +
          `fromTs=${fromTs} toTs=${toTs} reason=all_4_steps_empty`,
        );
      }
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      fetchDiag.outcome = 'no_data';
      return { results, fetchDiag };
    }

    // PR #283 — Critique : normaliser unité (ms→s) ET trier ASC AVANT
    // walkForward. EODHD retournait DESC, le bug a causé 100% NO_DATA prod.
    const normalizedCandles = normalizeAndSortCandles(selectedSeries.candles);

    // PR #289 — REVERT du +offset shift (PR #288 introduit par mauvaise
    // interprétation). Postgres `to_timestamp` confirme : EODHD retourne
    // déjà real UTC pour les timestamps Asia. Le helper getExchangeUtcOffsetSec
    // est conservé pour future logic session-aware (PR #290+) mais N'EST PLUS
    // appliqué sur les candles. Persisted = 0 pour audit.
    fetchDiag.applied_tz_offset_sec = 0;

    const forward = normalizedCandles.filter((c) => c.timestamp >= startTs);
    fetchDiag.forwardCount = forward.length;

    // PR #289 — Détection OFF_SESSION : si on a fetché des candles MAIS
    // toutes sont AVANT startTs, ça signifie que la row a été créée en
    // dehors de la session de trading active du symbole (ex: scanner
    // capture Asia ticker pendant US session 18:02 UTC → Shenzhen fermé
    // depuis 11h, latest candle = 07:00 UTC bien avant startTs).
    //
    // Sémantique : "row hors session, sim impossible structurellement".
    // Distinct de NO_DATA (= échec EODHD) et de TIME_LIMIT (= sim normal
    // sans hit). Exclu de getRegretSummary pour ne pas polluer les stats.
    const isOffSession = forward.length === 0
      && normalizedCandles.length > 0
      && normalizedCandles[normalizedCandles.length - 1].timestamp < startTs;

    if (forward.length === 0) {
      const first = normalizedCandles[0];
      const last = normalizedCandles[normalizedCandles.length - 1];
      this.logger.warn(
        `[user-shadow] ${eodhdTicker}: forward=0 fetched=${normalizedCandles.length} ` +
        `firstTs=${first?.timestamp ?? 'n/a'} lastTs=${last?.timestamp ?? 'n/a'} ` +
        `startTs=${startTs} cutoffMaxTs=${startTs + 60 * 60}`,
      );
    }

    if (isAsia) {
      const firstValid = normalizedCandles[0]?.timestamp ?? null;
      const lastValid = normalizedCandles[normalizedCandles.length - 1]?.timestamp ?? null;
      this.logger.warn(
        `[user-shadow-fetch-asia] post_filter inputSymbol=${args.symbol} ` +
        `selectedStep=${fetchDiag.selectedStep} ` +
        `fetched=${normalizedCandles.length} forward=${forward.length} ` +
        `firstValidTs=${firstValid} lastValidTs=${lastValid} ` +
        `startTs=${startTs} cutoffMaxTs=${startTs + 60 * 60}`,
      );
    }

    // PR #289 — Si OFF_SESSION détecté, court-circuiter walkForward avec
    // outcome dédié sur toutes les grilles (au lieu de NO_DATA générique).
    if (isOffSession) {
      const offSessionOutcome: SimOutcome = {
        outcome: 'OFF_SESSION',
        exit_price: null,
        exit_at: null,
        pnl_pct: null,
        hit_at_min: null,
      };
      for (const g of SIM_GRIDS) results[g.key] = offSessionOutcome;
      fetchDiag.outcome = 'off_session';
      return { results, fetchDiag };
    }

    for (const grid of SIM_GRIDS) {
      results[grid.key] = walkForward(args.entryPrice, forward, startTs, grid);
    }
    fetchDiag.outcome = forward.length > 0 ? 'ok' : 'no_data';
    return { results, fetchDiag };
  }

  /**
   * Aggregate par (decision × grid) avec bootstrap CI 95% sur pnl_pct.
   * cumulative_regret_usd = somme(pnl_pct × notional) — positif = on rate
   * de l'argent en moyenne, négatif = le gate sauve de l'argent.
   */
  async getRegretSummary(
    portfolioId: string,
    days: number = 7,
  ): Promise<RegretSummary> {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .select('decision, sim_results, notional_usd')
      .eq('portfolio_id', portfolioId)
      .gte('created_at', since)
      .not('sim_results', 'is', null);

    if (error || !data) {
      return { since, days, byGate: [], totalRows: 0 };
    }

    type Bucket = { pnls: number[]; notional: number };
    const buckets = new Map<string, Bucket>();

    for (const row of data) {
      const sim = row.sim_results as Record<string, SimOutcome> | null;
      if (!sim || sim.error) continue;
      const notional = row.notional_usd != null ? Number(row.notional_usd) : 1000;
      for (const grid of SIM_GRIDS) {
        const o = sim[grid.key];
        if (!o || o.pnl_pct == null) continue;
        // PR #289 — Exclure OFF_SESSION du calcul regret stats. Ces rows
        // n'ont pas pu être simulées car capturées hors session de trading
        // (ex: scanner détecte Asia ticker en US session). Pas un échec
        // de gate, juste un constraint structurel — ne pollue pas les KPI.
        if (o.outcome === 'OFF_SESSION') continue;
        const key = `${row.decision}|${grid.key}`;
        if (!buckets.has(key)) buckets.set(key, { pnls: [], notional });
        buckets.get(key)!.pnls.push(Number(o.pnl_pct));
      }
    }

    const byGate: RegretGateRow[] = [];
    for (const [key, bucket] of buckets) {
      const [decision, grid] = key.split('|');
      const ci = bootstrapMeanCI(bucket.pnls);
      const verdict: GateVerdict = verdictFromCI(ci, { minN: 100 });
      const cumulative_regret_usd = bucket.pnls.reduce(
        (acc, p) => acc + p * bucket.notional, 0,
      );
      byGate.push({
        decision,
        grid,
        n: ci.n,
        mean_pnl_pct: ci.mean,
        ci_low: ci.ciLow,
        ci_high: ci.ciHigh,
        cumulative_regret_usd,
        verdict,
      });
    }

    byGate.sort((a, b) => {
      if (a.decision !== b.decision) return a.decision.localeCompare(b.decision);
      return a.grid.localeCompare(b.grid);
    });

    return { since, days, byGate, totalRows: data.length };
  }
}

export interface RegretGateRow {
  decision: string;
  grid: string;
  n: number;
  mean_pnl_pct: number;
  ci_low: number;
  ci_high: number;
  cumulative_regret_usd: number;
  verdict: GateVerdict;
}

export interface RegretSummary {
  since: string;
  days: number;
  totalRows: number;
  byGate: RegretGateRow[];
}
