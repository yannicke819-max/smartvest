import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { YahooIntradayService } from './yahoo-intraday.service';
import { BinanceMarketService } from './binance-market.service';
import { bootstrapMeanCI, verdictFromCI, GateVerdict } from '@smartvest/ai-analyst';
import { isInExchangeSession } from './exchange-sessions.helper';

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
  | 'reject_earnings_imminent'  // PR Phase 1 — earnings dans la fenêtre filter
  | 'reject_opening_buffer'     // PR Phase 1 — premières N min après open
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
  /**
   * SHORT-SHADOW (11/05/2026) — Direction du signal simulé.
   * 'long'  : signal classique, TP au-dessus entry, SL en-dessous (default backward-compat)
   * 'short' : signal inversé (mean-reversion fade), TP en-dessous entry, SL au-dessus
   * Field optionnel pour préserver toutes les grilles LONG existantes sans modification.
   */
  direction?: 'long' | 'short';
}

/**
 * SHORT-SHADOW (11/05/2026) — Retourne les grilles de simulation selon l'asset class.
 *
 * Stratégie : SHORT grids UNIQUEMENT sur `us_equity_small_mid` (scope strict MESURE,
 * basé sur observation n=147 trades mono-journée 07/05/2026, expectancy LONG -1.20%
 * vs proxy SHORT +1.18%). Hypothèse "fade the gainer" sur small caps illiquides.
 *
 * Toutes les autres classes (us_equity_large, eu_equity, asia_equity, crypto_*)
 * conservent uniquement les 4 grilles LONG historiques. Aucun changement de
 * comportement pour ces classes (rétro-compat parfaite).
 *
 * Calibration grilles SHORT (us_equity_small_mid uniquement) :
 *   - short_baseline_30m/60m : TP 2.0% / SL 0.9% (mirror LONG baseline pour comparaison
 *     apples-to-apples)
 *   - short_alt15_30m/60m    : TP 1.5% / SL 0.6% (mirror LONG alt15)
 *   - short_calibrated_30m/60m : TP 0.8% / SL 0.4% (ratio 2:1, breakeven 33%, calibré
 *     sur range 60min réellement observé small/mid US 0.5-1.2%)
 */
export function getGridsForAssetClass(assetClass: string): SimGrid[] {
  const longGrids: SimGrid[] = [
    { key: 'baseline_30m', tpPct: 0.020, slPct: 0.009, windowMin: 30, direction: 'long' },
    { key: 'baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60, direction: 'long' },
    { key: 'alt15_30m',    tpPct: 0.015, slPct: 0.006, windowMin: 30, direction: 'long' },
    { key: 'alt15_60m',    tpPct: 0.015, slPct: 0.006, windowMin: 60, direction: 'long' },
  ];

  if (assetClass !== 'us_equity_small_mid') {
    return longGrids;
  }

  // SHORT grids — SCOPE STRICT us_equity_small_mid uniquement
  return [
    ...longGrids,
    // Mirror LONG baseline (apples-to-apples comparison)
    { key: 'short_baseline_30m', tpPct: 0.020, slPct: 0.009, windowMin: 30, direction: 'short' },
    { key: 'short_baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60, direction: 'short' },
    // Mirror LONG alt15
    { key: 'short_alt15_30m', tpPct: 0.015, slPct: 0.006, windowMin: 30, direction: 'short' },
    { key: 'short_alt15_60m', tpPct: 0.015, slPct: 0.006, windowMin: 60, direction: 'short' },
    // Calibrated for small/mid US 60m range (TP 0.8% / SL 0.4%, ratio 2:1)
    { key: 'short_calibrated_30m', tpPct: 0.008, slPct: 0.004, windowMin: 30, direction: 'short' },
    { key: 'short_calibrated_60m', tpPct: 0.008, slPct: 0.004, windowMin: 60, direction: 'short' },
  ];
}

/**
 * @deprecated SHORT-SHADOW (11/05/2026) — Préservé pour rétro-compat lecture.
 * Utiliser getGridsForAssetClass(assetClass) pour le nouveau comportement
 * conditionnel par asset class.
 */
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

/**
 * SHORT-SHADOW TIMING-FIX (11/05/2026) — Cutoff dynamique pour simulatePending.
 *
 * Bug observé 08/05/2026 : 0/503 mesurables (100% OFF_SESSION stale_data) sur les
 * signaux du jour, alors que 07/05/2026 = 141/143 mesurables (98%). Diagnostic :
 * scan→sim délai 0-1h sur 8 mai vs 10h+ sur 7 mai. À 60min sharp (cutoff
 * pré-existant), race condition avec EODHD candle propagation lag (~5min typique
 * post-bar-close) → fetch retourne empty / partial → outcome marqué OFF_SESSION.
 *
 * Fix : `max(windowMin) + buffer 5min`. Pour les grilles actuelles (LONG + SHORT,
 * max window = 60min), cutoff = 65min. Tolère le lag sans retarder excessivement
 * la simulation.
 *
 * Si nouvelles grilles ajoutées avec windowMin > 60, la constante MAX_WINDOW_MIN
 * doit être mise à jour manuellement (pas dérivé du tableau pour éviter circular
 * dep avec getGridsForAssetClass au module init).
 */
export const MAX_WINDOW_MIN = 60;
export const SIMULATE_BUFFER_MIN = 5;
/**
 * @deprecated Bug #H (13/05/2026) — Conservé pour rétro-compat (tests
 * TIMING-FIX SHORT-SHADOW référencent SIMULATE_AFTER_MIN === 65). Le code
 * de simulatePending utilise désormais `getSimulateAfterMin(assetClass)`
 * qui retourne 120 pour US, 65 pour les autres.
 */
export const SIMULATE_AFTER_MIN = MAX_WINDOW_MIN + SIMULATE_BUFFER_MIN;  // = 65
const SIMULATE_BATCH_SIZE = 50;

/**
 * Bug #H (13/05/2026) — Buffer dynamique par asset_class pour absorber le lag
 * de propagation EODHD intraday US live.
 *
 * Observation 12/05/2026 : 246/246 captures us_equity_large session ouverte
 * 13:30-20:00 UTC marquées off_session/stale_data. Trace fetch_diag QCOM.US :
 *   - Step1-3 (range mode, fenêtre [startTs-5min, +65min]) → rawCount=0
 *   - Step4 (default mode latest) → rawCount=210, lastCandleTs J-1 close
 *     (~20h stale vs startTs), forwardCountAfterFilter=0
 *
 * Test empirique curl T+22h sur EXACTEMENT la même fenêtre échouée :
 *   curl ".../intraday/QCOM.US?...&from=1778596418&to=1778600618"
 *   → 14 candles propres, volumes réalistes (14M sur 15:00-15:05).
 *
 * Conclusion : EODHD intraday US live lag de propagation ≫ 65 min. Pour Asia
 * (TZ shift + session-aware pre-fetch déjà déployés) et crypto (Binance live
 * via Bug #A), 5 min suffisent. EU baseline modéré.
 *
 * Trade-off US : signaux attendent 120 min avant simulation (vs 65 min). Délai
 * +55 min sur shadow verdict, accepté car alternative = 100% off_session.
 */
export const SIMULATE_BUFFER_BY_CLASS: Readonly<Record<string, number>> = {
  us_equity_large:     60,  // lag EODHD live constaté ≫ 65 min (Bug #H)
  us_equity_small_mid: 60,  // même plan EODHD, même lag présumé
  eu_equity:            5,  // baseline ~17% pass rate
  asia_equity:         60,  // Bug #I — lag EODHD live identique US (trace 003550.KO candle_freshness=90134s, 493/493 signaux off_session sur 24h)
  crypto_major:         5,  // Binance live (Bug #A)
  crypto_alt:           5,  // idem
};
export const DEFAULT_SIMULATE_BUFFER_MIN = 5;

/**
 * Bug #H — Retourne le buffer post-window pour la classe donnée. Default 5 min
 * pour les classes non listées (rétro-compat + future-proof).
 */
export function getSimulateBufferMin(assetClass: string): number {
  return SIMULATE_BUFFER_BY_CLASS[assetClass] ?? DEFAULT_SIMULATE_BUFFER_MIN;
}

/**
 * Bug #H — Délai total post-création (MAX_WINDOW + buffer) avant qu'un row
 * soit éligible à la simulation. US = 120, autres = 65.
 */
export function getSimulateAfterMin(assetClass: string): number {
  return MAX_WINDOW_MIN + getSimulateBufferMin(assetClass);
}

/**
 * Bug #H — MIN des seuils par classe. Sert de cutoff SQL côté simulatePending
 * pour récupérer tous les candidats potentiellement matures ; le filtre per-row
 * applique ensuite le seuil exact (US 120 vs autres 65).
 *
 * Choix MIN plutôt que MAX : MAX (120) délaierait inutilement Asia/EU/crypto
 * de 55 min — régression sur 95% du volume signaux. MIN (65) préserve la
 * latence existante pour les autres classes, tighten via JS uniquement pour US.
 */
const MIN_SIMULATE_AFTER_MIN = MAX_WINDOW_MIN + Math.min(
  DEFAULT_SIMULATE_BUFFER_MIN,
  ...Object.values(SIMULATE_BUFFER_BY_CLASS),
);

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
  /**
   * PR #296 — Sub-classification du marker OFF_SESSION pour distinguer :
   *   - 'capture'     : capture créée pendant fermeture exchange (pas de
   *                     trade possible). Skip fetch entirely (économise
   *                     ~6 API calls EODHD/row). Détecté par session helper.
   *   - 'stale_data'  : capture créée pendant session active mais EODHD/Yahoo
   *                     ne renvoient pas de candle forward. Cas où Yahoo
   *                     fallback (PR #297 future) pourrait débloquer.
   * Undefined pour outcomes != OFF_SESSION (backward-compatible).
   */
  off_session_reason?: 'capture' | 'stale_data';
  /**
   * PR #296 — Flag prévention biais Kelly/regret stats. Set à `true` quand
   * la fenêtre forward effective est <50% de la fenêtre attendue (ex :
   * capture 5min avant close NYSE → seulement 5 candles 1m forward au lieu
   * de 60 attendues). Permet d'exclure ces rows du calcul Kelly sans les
   * supprimer de l'audit trail.
   *
   * Seuil configurable via env `PARTIAL_WINDOW_THRESHOLD` (default 0.5).
   *
   * Populated uniquement quand outcome ∈ {TP_HIT, SL_HIT, TIME_LIMIT}
   * (les outcomes OFF_SESSION/NO_DATA sont déjà exclus par leur nature).
   */
  partial_window?: boolean;
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
  // PR #291 — Freshness diagnostic. Permet de détecter la latence d'ingestion
  // EODHD (observée 22h sur US à 18:01 UTC, signe d'un problème data-side
  // qui invalide tout le shadow simulator). SQL post-deploy : si age_ms
  // est dominant > 30min sur tous les rows, c'est le data-source qui patine.
  //   age_ms = (now_ms - lastCandleTs_ms)  → fraicheur de la candle la
  //                                            plus récente fetchée
  //   candle_freshness_s = age_ms / 1000  (alias plus lisible en SQL)
  age_ms?: number;
  candle_freshness_s?: number;
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
 * MESURE-PR (11/05/2026) — Raw close prices à 5/15/30/60min après startTs,
 * indépendants de tout TP/SL. Stockés au niveau RACINE de sim_results JSONB
 * (pas dupliqués par grille). Permet de mesurer la persistance directionnelle
 * pure P(up_60m | up_30m) sur TIME_LIMIT et sur outcomes où TP/SL fire tard.
 * Null si aucune candle ne couvre l'instant cible.
 */
export type PriceSnapshots = {
  '5': number | null;
  '15': number | null;
  '30': number | null;
  '60': number | null;
};

/**
 * MESURE-PR — Helper pur : extrait close prices aux 4 instants cibles
 * indépendamment de la logique TP/SL. À appeler UNE FOIS par row, pas par
 * grille, pour éviter la duplication 4× dans sim_results JSONB.
 *
 * Itère candles ASC. Pour chaque candle, set result[key]=c.close si
 * minSinceStart >= key et pas encore set. Boucle interne O(4) négligeable.
 *
 * Fonction pure exportée pour testabilité.
 */
export function computePriceSnapshots(
  candles: readonly CandleLike[],
  startTs: number,
): PriceSnapshots {
  const targets = [5, 15, 30, 60] as const;
  const result: PriceSnapshots = { '5': null, '15': null, '30': null, '60': null };
  for (const c of candles) {
    const minSinceStart = (c.timestamp - startTs) / 60;
    for (const t of targets) {
      const key = String(t) as keyof PriceSnapshots;
      if (minSinceStart >= t && result[key] === null) {
        result[key] = c.close;
      }
    }
  }
  return result;
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
  // SHORT-SHADOW (11/05/2026) — Direction read from grid (default 'long' rétro-compat).
  // LONG : TP au-dessus entry, SL en-dessous, profit si prix monte
  // SHORT : TP en-dessous entry, SL au-dessus, profit si prix descend
  const direction = grid.direction ?? 'long';
  const isShort = direction === 'short';

  const tpPrice = isShort ? entry * (1 - grid.tpPct) : entry * (1 + grid.tpPct);
  const slPrice = isShort ? entry * (1 + grid.slPct) : entry * (1 - grid.slPct);
  const cutoffTs = startTs + grid.windowMin * 60;
  let lastBeforeCutoff: CandleLike | null = null;

  for (const c of candles) {
    if (c.timestamp > cutoffTs) break;
    lastBeforeCutoff = c;

    // SHORT-SHADOW : hit conditions inversées
    // SHORT SL hit si c.high >= slPrice (prix MONTE à travers SL au-dessus)
    // SHORT TP hit si c.low  <= tpPrice (prix DESCEND à travers TP en-dessous)
    const slHit = isShort ? c.high >= slPrice : c.low <= slPrice;
    const tpHit = isShort ? c.low <= tpPrice : c.high >= tpPrice;

    if (slHit) {
      return {
        outcome: 'SL_HIT',
        exit_price: slPrice,
        exit_at: new Date(c.timestamp * 1000).toISOString(),
        // pnl_pct sign : SL loss is negative for both LONG and SHORT (grid.slPct is magnitude)
        pnl_pct: -grid.slPct - SLIPPAGE_TOTAL,
        hit_at_min: Math.round((c.timestamp - startTs) / 60),
      };
    }
    if (tpHit) {
      return {
        outcome: 'TP_HIT',
        exit_price: tpPrice,
        exit_at: new Date(c.timestamp * 1000).toISOString(),
        // pnl_pct sign : TP profit is positive for both LONG and SHORT
        pnl_pct: grid.tpPct - SLIPPAGE_TOTAL,
        hit_at_min: Math.round((c.timestamp - startTs) / 60),
      };
    }
  }

  if (lastBeforeCutoff) {
    // SHORT-SHADOW : TIME_LIMIT pnl signe inversé pour SHORT
    // LONG  closePnl = (close - entry) / entry  (positif si close > entry = profit long)
    // SHORT closePnl = (entry - close) / entry  (positif si entry > close = profit short)
    const closePnl = isShort
      ? (entry - lastBeforeCutoff.close) / entry
      : (lastBeforeCutoff.close - entry) / entry;
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
    /**
     * PR #296 Partie B — Yahoo fallback pour les captures RTH où EODHD est
     * stale (24-25h lag observé prod). Yahoo intraday lag ~15min.
     * Optional pour back-compat avec tests existants (qui n'injectent pas yahoo).
     */
    private readonly yahoo?: YahooIntradayService,
    /**
     * Bug #A (13/05/2026) — Binance pour crypto walkForward via getKlinesRange.
     * Optional pour back-compat tests. Gated par env CRYPTO_SIMULATOR_ENABLED=true.
     * Si non injecté OU flag off → short-circuit legacy crypto_not_supported préservé.
     */
    private readonly binance?: BinanceMarketService,
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
   * Pick rows where sim_run_at IS NULL AND created_at > getSimulateAfterMin(asset_class) ago,
   * fetch 5m candles forward, walk-forward to find TP/SL hits sur 4 grilles.
   * Cap batch à SIMULATE_BATCH_SIZE pour éviter timeouts.
   *
   * SHORT-SHADOW TIMING-FIX (11/05/2026) — SIMULATE_AFTER_MIN bumped 60→65 pour
   * tolérer EODHD candle propagation lag ~5min.
   *
   * Bug #H (13/05/2026) — Cutoff dynamique par classe via getSimulateAfterMin.
   * Query SQL utilise MIN_SIMULATE_AFTER_MIN (= 65) pour récupérer tous les
   * candidats potentiellement matures, filtre per-row JS applique le seuil exact
   * (US = 120 min pour absorber lag EODHD live, autres = 65 min inchangé).
   */
  async simulatePending(): Promise<{ processed: number; failures: number }> {
    // Bug #H — Query cutoff permissif (MIN) ; filtre JS tightens per-class.
    const queryCutoff = new Date(Date.now() - MIN_SIMULATE_AFTER_MIN * 60_000).toISOString();
    const { data: rows, error } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .select('id, symbol, asset_class, entry_price, created_at')
      .is('sim_run_at', null)
      .lte('created_at', queryCutoff)
      .order('created_at', { ascending: true })
      .limit(SIMULATE_BATCH_SIZE);

    if (error) {
      this.logger.warn(`[user-shadow] simulatePending query failed: ${error.message}`);
      return { processed: 0, failures: 1 };
    }
    if (!rows || rows.length === 0) return { processed: 0, failures: 0 };

    let processed = 0;
    let failures = 0;
    let skippedNotMature = 0;
    const nowMs = Date.now();
    for (const row of rows) {
      // Bug #H — Skip row si pas encore mature pour sa classe (US needs 120 min
      // vs 65 min query cutoff). Sera repris au prochain cycle quand mûr.
      const assetClass = String(row.asset_class);
      const matureThresholdMs = nowMs - getSimulateAfterMin(assetClass) * 60_000;
      const createdMs = new Date(String(row.created_at)).getTime();
      if (createdMs > matureThresholdMs) {
        skippedNotMature++;
        continue;
      }
      try {
        const { results: simResults, fetchDiag, priceSnapshots } = await this.simulateRow({
          symbol: String(row.symbol),
          assetClass: String(row.asset_class),
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          createdAt: String(row.created_at),
        });
        // MESURE-PR — Merge priceSnapshots au niveau RACINE de sim_results JSONB.
        // Early-returns de simulateRow (no_entry, off_session capture) ne calculent
        // pas snapshots → fallback all-null pour cohérence schéma.
        const simResultsRoot = {
          ...simResults,
          price_snapshots: priceSnapshots ?? { '5': null, '15': null, '30': null, '60': null },
        };
        await this.supabase.getClient()
          .from('gainers_user_shadow_signals')
          .update({
            sim_results: simResultsRoot,
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
    if (processed > 0 || failures > 0 || skippedNotMature > 0) {
      this.logger.log(
        `[user-shadow] simulated ${processed} rows (${failures} failures, ${skippedNotMature} skipped not-mature per class buffer)`,
      );
    }
    return { processed, failures };
  }

  private async simulateRow(args: {
    symbol: string;
    assetClass: string;
    entryPrice: number | null;
    createdAt: string;
  }): Promise<{
    results: Record<string, SimOutcome>;
    fetchDiag: FetchDiag;
    /** MESURE-PR (e1dfec6) — Snapshots prix raw aux 4 instants cibles, undefined sur early-returns */
    priceSnapshots?: PriceSnapshots;
  }> {
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
      for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
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

    // Bug #A (13/05/2026) — Crypto support via Binance klines range.
    //
    // Avant : short-circuit explicite `crypto_not_supported`. Les ~13 crypto/4j
    // capturées par fetchBinanceGainers (top-gainers-scanner.service.ts:1136-1146)
    // étaient toutes marquées outcome='error' → 0 mesurable.
    //
    // Après : gated par CRYPTO_SIMULATOR_ENABLED (default false). Si flag on
    // ET binance injecté → fetch Binance 5m sur [startTs-5min, +65min] + walkForward.
    //
    // Placement préservé AVANT Step 0 (line ~635) : crypto = 24/7, le session
    // check isInExchangeSession retournerait `false` pour BTCUSDT/ADAUSDT
    // (suffix null, ligne 118 exchange-sessions.helper.ts → false conservatif),
    // ce qui marquerait tout en OFF_SESSION 'capture'. On bypass volontairement.
    if (args.assetClass === 'crypto_major' || args.assetClass === 'crypto_alt') {
      const cryptoEnabled = process.env.CRYPTO_SIMULATOR_ENABLED === 'true';
      if (!cryptoEnabled || !this.binance) {
        // Legacy short-circuit : préservé pour rollback rapide (flag off) ET
        // pour tests qui n'injectent pas BinanceMarketService (back-compat).
        for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
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
          error: cryptoEnabled ? 'crypto_simulator_no_binance_service' : 'crypto_not_supported',
        });
        return { results, fetchDiag };
      }

      // Walk-forward crypto via Binance.
      const binanceSymbol = this.binance.toBinanceSymbol(args.symbol);
      if (!binanceSymbol) {
        for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
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
          error: 'crypto_unmappable_symbol',
        });
        return { results, fetchDiag };
      }

      const cryptoStartTs = Math.floor(new Date(args.createdAt).getTime() / 1000);
      const cryptoFromTs = cryptoStartTs - 300;
      const cryptoToTs = cryptoStartTs + 60 * 60 + 300;
      fetchDiag.startTs = cryptoStartTs;
      fetchDiag.cutoffTs60 = cryptoStartTs + 60 * 60;

      const cryptoT0 = Date.now();
      const binanceCandles = await this.binance.getKlinesRange(
        binanceSymbol,
        '5m',
        cryptoFromTs * 1000,
        cryptoToTs * 1000,
      );
      const cryptoMs = Date.now() - cryptoT0;
      const binanceRawCount = binanceCandles?.length ?? 0;
      const binanceValidClose = binanceCandles?.filter((c) => Number.isFinite(c.close) && c.close > 0).length ?? 0;

      const binanceStep: FetchDiagStep = {
        endpoint: 'binance_klines_range_5m',
        interval: '5m',
        rangeMode: true,
        fromTs: cryptoFromTs,
        toTs: cryptoToTs,
        inputSymbol: args.symbol,
        requestedSymbol: binanceSymbol,
        rawCount: binanceRawCount,
        validClose: binanceValidClose,
        nulls: binanceRawCount - binanceValidClose,
        ms: cryptoMs,
      };
      if (binanceCandles == null) {
        binanceStep.error = 'binance_api_error';
      } else if (binanceValidClose === 0) {
        binanceStep.error = 'empty_response';
      }
      fetchDiag.steps.push(binanceStep);

      if (!binanceCandles || binanceValidClose === 0) {
        for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
        fetchDiag.outcome = 'no_data';
        return { results, fetchDiag };
      }

      // BinanceCandle.openTime est en ms → normalizeAndSortCandles auto-convertit
      // (timestamp > 1e12 ⇒ /1000) ET trie ASC.
      const cryptoNormalized = normalizeAndSortCandles(
        binanceCandles.map((c) => ({
          timestamp: c.openTime,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      fetchDiag.selectedStep = 0;
      fetchDiag.applied_tz_offset_sec = 0;

      const cryptoForward = cryptoNormalized.filter((c) => c.timestamp >= cryptoStartTs);
      fetchDiag.forwardCount = cryptoForward.length;

      if (cryptoForward.length === 0) {
        // Pas de candles forward (range fetch a retourné des candles antérieures
        // au startTs, cas rare avec startTime explicite). Mark no_data ; pas
        // OFF_SESSION car crypto n'a pas de notion de session.
        for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
        fetchDiag.outcome = 'no_data';
        return { results, fetchDiag };
      }

      const cryptoPartialThreshold = (() => {
        const raw = process.env.PARTIAL_WINDOW_THRESHOLD;
        const parsed = raw != null ? Number(raw) : 0.5;
        return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.5;
      })();
      const cryptoIsPartial = cryptoForward.length < 12 * cryptoPartialThreshold;
      const cryptoSnapshots = computePriceSnapshots(cryptoForward, cryptoStartTs);

      for (const grid of getGridsForAssetClass(args.assetClass)) {
        const out = walkForward(args.entryPrice, cryptoForward, cryptoStartTs, grid);
        if (cryptoIsPartial && (out.outcome === 'TP_HIT' || out.outcome === 'SL_HIT' || out.outcome === 'TIME_LIMIT')) {
          out.partial_window = true;
        }
        results[grid.key] = out;
      }
      fetchDiag.outcome = 'ok';
      return { results, fetchDiag, priceSnapshots: cryptoSnapshots };
    }

    // PR #296 Partie A — Step 0 : skip simulator si capture genuinely off-session.
    //
    // Avant tout fetch EODHD (4 endpoints, ~1.5s round-trip cumul), check
    // si le ticker était en session active à l'heure de capture. Si non →
    // marquer OFF_SESSION avec sub-reason='capture' et économiser les API
    // calls. Sinon → continue dans le fetch chain normal.
    //
    // Volumétrie attendue (analyse 09/05/2026 sur n=978/12h) :
    //   - ~70% des captures hors session → short-circuit ici
    //   - ~30% pendant session (US RTH 14:30-21:00 UTC, KRX 0-6:30 UTC, ...)
    //     → fetch normal, EODHD stale ou Yahoo (PR #297 future) génère outcome
    //
    // Le marker OFF_SESSION existant plus bas (post-fetch) reçoit sub-reason
    // 'stale_data' pour les rows pendant session où data sources échouent.
    // Cette distinction permet de mesurer en prod la part de chaque cas.
    if (!isInExchangeSession(args.symbol, args.createdAt)) {
      const offCaptureOutcome: SimOutcome = {
        outcome: 'OFF_SESSION',
        exit_price: null,
        exit_at: null,
        pnl_pct: null,
        hit_at_min: null,
        off_session_reason: 'capture',
      };
      for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = offCaptureOutcome;
      fetchDiag.outcome = 'off_session';
      fetchDiag.steps.push({
        endpoint: 'session_check',
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
        error: 'capture_outside_session',
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

    // PR #296 Partie B — Yahoo intraday fallback en step5 quand `yahoo` injecté.
    //
    // Justification empirique (curl 09/05/2026 06:26 UTC samedi) :
    //   - EODHD US lastCandleTs = May 7 20:00 UTC (Thursday close, ~34h stale)
    //   - Yahoo US lastCandleTs = May 8 20:00 UTC (Friday close, ~10h stale)
    //   - Différentiel persistent : Yahoo +24h plus frais
    //
    // Pour les captures RTH-active (Step 0 lets through) où EODHD retourne
    // empty sur les 4 endpoints, Yahoo couvre la fenêtre [startTs, startTs+60min]
    // dans les 95%+ des cas (1m intraday native, 1d range = 391 candles RTH).
    //
    // Coût marginal : 1 call Yahoo par row OFF_SESSION_STALE_DATA (estimé
    // ~150-250/12h selon distribution prod). Yahoo public API gratuit, pas
    // d'auth, soft rate-limit ~2000 req/h sur même IP — circuit breaker
    // intégré côté YahooIntradayService gère 429/5xx avec backoff exponentiel.
    //
    // Si yahoo non injecté (back-compat tests legacy) → step skip silently.
    if (this.yahoo) {
      stepDefs.push({
        endpoint: 'yahoo_intraday_5m',
        interval: '5m',
        rangeMode: false,
        fn: async () => {
          const yc = await this.yahoo!.getCandles(eodhdTicker, '5m').catch(() => null);
          if (!yc || yc.length === 0) return null;
          // Filter Yahoo candles to the target window [fromTs, toTs] for symmetry
          // with range-mode EODHD steps. walkForward filtre quand même par startTs
          // mais on évite d'envoyer des centaines de candles inutiles.
          const ts0 = fromTs;
          const ts1 = toTs;
          const filtered = yc.filter((c) => {
            const cts = Math.floor(new Date(c.datetime).getTime() / 1000);
            return cts >= ts0 && cts <= ts1;
          });
          if (filtered.length === 0) return null;
          return {
            candles: filtered.map((c) => ({
              timestamp: Math.floor(new Date(c.datetime).getTime() / 1000),
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })),
            rawCount: filtered.length,
            requestedSymbol: eodhdTicker,
          };
        },
      });
    }

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
          // PR #291 — Freshness : age de la candle la plus récente vs NOW.
          // Auto-detect ms vs s pour cohérence avec normalizeAndSortCandles.
          const lastTsSec = stepEntry.lastCandleTs > 1e12
            ? Math.floor(stepEntry.lastCandleTs / 1000)
            : stepEntry.lastCandleTs;
          const nowSec = Math.floor(Date.now() / 1000);
          stepEntry.age_ms = (nowSec - lastTsSec) * 1000;
          stepEntry.candle_freshness_s = nowSec - lastTsSec;
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
      for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = noEntry();
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

    // PR #289 — Si OFF_SESSION détecté post-fetch, court-circuiter walkForward.
    //
    // PR #296 — Sub-reason 'stale_data' (vs 'capture' du Step 0 plus haut).
    // Ici on est arrivé après le fetch chain EODHD qui a retourné des candles
    // mais toutes vieilles vs startTs (ex : EODHD US 25h stale). La capture
    // était DURANT session active mais aucun provider n'avait de data forward.
    // Cas candidat pour PR #297 Yahoo fallback (Yahoo lag 15min vs EODHD 24h+).
    if (isOffSession) {
      const offSessionOutcome: SimOutcome = {
        outcome: 'OFF_SESSION',
        exit_price: null,
        exit_at: null,
        pnl_pct: null,
        hit_at_min: null,
        off_session_reason: 'stale_data',
      };
      for (const g of getGridsForAssetClass(args.assetClass)) results[g.key] = offSessionOutcome;
      fetchDiag.outcome = 'off_session';
      return { results, fetchDiag };
    }

    // PR #296 — Flag partial_window pour prévenir biais Kelly/regret stats.
    // Capture pendant les dernières minutes de session (ex : 19:55 UTC NYSE,
    // 5min avant close 20:00 UTC) → forward window contient ~5-12 candles
    // au lieu de 60 attendues → outcome statistiquement non-comparable aux
    // captures normales. Threshold configurable via env (default 50%).
    //
    // Calcul attendu candles 60min :
    //   - 5m interval → 12 candles
    //   - 1m interval → 60 candles
    // Estimation conservative : on prend 12 (cas 5m, le plus fréquent).
    const partialWindowThreshold = (() => {
      const raw = process.env.PARTIAL_WINDOW_THRESHOLD;
      const parsed = raw != null ? Number(raw) : 0.5;
      return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.5;
    })();
    const expectedCandles = 12;  // 60min / 5min
    const isPartialWindow = forward.length < expectedCandles * partialWindowThreshold;

    // MESURE-PR — Snapshots calculés UNE fois sur `forward`, indépendants des grilles.
    // Stockés au niveau RACINE de sim_results par simulatePending (pas duplique par
    // grille). Permet la SQL persistance directionnelle pure post-rétro-simulation.
    const priceSnapshots = computePriceSnapshots(forward, startTs);

    // SHORT-SHADOW (11/05/2026) — getGridsForAssetClass retourne 4 LONG grids + 6 SHORT
    // grids pour us_equity_small_mid uniquement, sinon 4 LONG grids seulement. La direction
    // SHORT est portée par grid.direction lue dans walkForward.
    for (const grid of getGridsForAssetClass(args.assetClass)) {
      const out = walkForward(args.entryPrice, forward, startTs, grid);
      if (isPartialWindow && (out.outcome === 'TP_HIT' || out.outcome === 'SL_HIT' || out.outcome === 'TIME_LIMIT')) {
        out.partial_window = true;
      }
      results[grid.key] = out;
    }
    fetchDiag.outcome = forward.length > 0 ? 'ok' : 'no_data';
    return { results, fetchDiag, priceSnapshots };
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
