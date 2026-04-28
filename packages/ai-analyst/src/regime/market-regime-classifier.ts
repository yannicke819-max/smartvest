/**
 * TacticalRegimeClassifier — classification déterministe du régime macro.
 *
 * P1 (28/04/2026) — feat/market-regime.
 *
 * Pure function (no I/O) qui classifie le marché en 5 régimes mutuellement
 * exclusifs basés sur des inputs factuels (BTC 24h return, funding, VIX,
 * ATR ratio, news score). Permet à Lisa + au RiskEnforcer d'adapter le
 * sizing/SL/TP par régime sans nécessiter un appel LLM.
 *
 * **Régimes (ordre de priorité — first-match wins)** :
 *
 *  1. **NEWS_SHOCK** — choc d'information (sens du catalyseur prime sur le
 *     contexte macro normal). Trigger : news_score > 7 OU reddit spike > 5σ.
 *     Sizing/SL/TP : SL 1%, TP 3% (sens catalyst).
 *
 *  2. **VOL_SPIKE** — pic de volatilité (panique, désordre cross-asset).
 *     Trigger : VIX > 25 OU realized 1h > 3%.
 *     Sizing : skip 30 min (pas de nouvelle ouverture, fade les overshoots).
 *     SL 3% / TP 2%.
 *
 *  3. **BULL** — tendance haussière forte.
 *     Trigger : BTC 24h > +2% ET funding > 0.01% (long bias).
 *     Sizing +20%, TP étagé 1.5/2.5/4%, SL trail 2%.
 *
 *  4. **BEAR** — tendance baissière forte.
 *     Trigger : BTC 24h < -2% ET funding < -0.005% (short bias / cash bias).
 *     Sizing -30%, TP 1.5%, SL 2%.
 *
 *  5. **RANGE** — marché latéral, faible momentum, ATR comprimé.
 *     Trigger : ATR14 < 0.8 × ATR50 ET |BTC 24h| < 1%.
 *     Sizing grid-like, TP 0.8% (scalping mean-reversion), SL 1.2%.
 *
 *  6. **NEUTRAL** — défaut quand aucun régime ne match. Sizing nominal.
 *
 * Cohérence : les 5 régimes sont mutually exclusive grâce à l'ordre de
 * priorité. NEWS_SHOCK/VOL_SPIKE prennent le pas car ils sont des
 * "interrupts" qui invalident l'analyse macro normale.
 */

export type TacticalRegime =
  | 'BULL'
  | 'BEAR'
  | 'RANGE'
  | 'VOL_SPIKE'
  | 'NEWS_SHOCK'
  | 'NEUTRAL';

export interface RegimeInputs {
  /** BTC return 24h en % (ex: +2.5 pour +2.5%). Null si indisponible. */
  btc24hReturnPct: number | null;
  /** Funding rate Binance perp BTC en % (ex: 0.01 pour 1bp / 8h). Null si indispo. */
  btcFundingPct: number | null;
  /** VIX index value (ex: 22.5). Null si indisponible. */
  vix: number | null;
  /** ATR14 BTC en % du prix. Null si indisponible. */
  atr14BtcPct: number | null;
  /** ATR50 BTC en % du prix (référence "long-terme" pour ratio compression). Null si indispo. */
  atr50BtcPct: number | null;
  /** News score normalisé 0-10 du flux récent (high impact = haut). Null si indispo. */
  newsScore: number | null;
  /** Realized vol BTC sur 1h en % (mouvements intra-cycle). Null si indispo. */
  realized1hPct?: number | null;
  /** Reddit/social activity z-score (sigma). Null si indisponible. */
  redditSpikeSigma?: number | null;
}

export interface RegimeClassification {
  regime: TacticalRegime;
  /** Raisons textuelles concises pour audit (chaque condition qui a matché). */
  reasons: string[];
  /** Multiplicateur de sizing à appliquer (1.0 = nominal, 0.7 = -30%, 1.2 = +20%, 0 = skip). */
  sizingMultiplier: number;
  /** SL recommandé en % (positif). */
  stopLossPct: number;
  /** TP "principal" en % (premier palier si TP étagé). */
  takeProfitPct: number;
  /** TP étagés (BULL : 1.5/2.5/4%). Empty si pas de TP étagé. */
  takeProfitLadderPct: number[];
}

const NEWS_SCORE_THRESHOLD = 7;
const REDDIT_SPIKE_SIGMA_THRESHOLD = 5;
const VIX_SPIKE_THRESHOLD = 25;
const REALIZED_1H_VOL_SPIKE_THRESHOLD = 3;
const BULL_BTC_24H_THRESHOLD = 2;
const BULL_FUNDING_THRESHOLD = 0.01;
const BEAR_BTC_24H_THRESHOLD = -2;
const BEAR_FUNDING_THRESHOLD = -0.005;
const RANGE_ATR_RATIO_THRESHOLD = 0.8;
const RANGE_BTC_24H_ABS_THRESHOLD = 1;

/**
 * Classifie le régime de marché à partir des inputs factuels.
 * Pure function — déterministe, testable sans dépendance.
 *
 * Si plusieurs régimes pourraient matcher, NEWS_SHOCK > VOL_SPIKE > BULL >
 * BEAR > RANGE > NEUTRAL (ordre déclaré ci-dessus).
 *
 * Si tous les inputs critiques sont null → NEUTRAL avec reason
 * `inputs_unavailable`. Lisa peut décider de skipper le cycle ou de
 * fonctionner sur les inputs disponibles.
 */
export function classifyTacticalRegime(inputs: RegimeInputs): RegimeClassification {
  const reasons: string[] = [];

  // ── 1. NEWS_SHOCK ────────────────────────────────────────────────
  const newsHit = inputs.newsScore != null && inputs.newsScore > NEWS_SCORE_THRESHOLD;
  const redditHit =
    inputs.redditSpikeSigma != null && inputs.redditSpikeSigma > REDDIT_SPIKE_SIGMA_THRESHOLD;
  if (newsHit || redditHit) {
    if (newsHit) reasons.push(`news_score=${inputs.newsScore!.toFixed(1)} > ${NEWS_SCORE_THRESHOLD}`);
    if (redditHit) reasons.push(`reddit_sigma=${inputs.redditSpikeSigma!.toFixed(1)} > ${REDDIT_SPIKE_SIGMA_THRESHOLD}`);
    return {
      regime: 'NEWS_SHOCK',
      reasons,
      sizingMultiplier: 1.0, // taille nominale, on suit le catalyseur
      stopLossPct: 1.0,
      takeProfitPct: 3.0,
      takeProfitLadderPct: [],
    };
  }

  // ── 2. VOL_SPIKE ─────────────────────────────────────────────────
  const vixHit = inputs.vix != null && inputs.vix > VIX_SPIKE_THRESHOLD;
  const realizedHit =
    inputs.realized1hPct != null && inputs.realized1hPct > REALIZED_1H_VOL_SPIKE_THRESHOLD;
  if (vixHit || realizedHit) {
    if (vixHit) reasons.push(`vix=${inputs.vix!.toFixed(1)} > ${VIX_SPIKE_THRESHOLD}`);
    if (realizedHit) reasons.push(`realized_1h=${inputs.realized1hPct!.toFixed(2)}% > ${REALIZED_1H_VOL_SPIKE_THRESHOLD}%`);
    return {
      regime: 'VOL_SPIKE',
      reasons,
      sizingMultiplier: 0, // skip 30 min — fade les overshoots
      stopLossPct: 3.0,
      takeProfitPct: 2.0,
      takeProfitLadderPct: [],
    };
  }

  // ── 3. BULL ───────────────────────────────────────────────────────
  // Conditions cumulatives ET — BTC up 24h ET funding crowded long.
  const bullBtcHit =
    inputs.btc24hReturnPct != null && inputs.btc24hReturnPct > BULL_BTC_24H_THRESHOLD;
  const bullFundingHit =
    inputs.btcFundingPct != null && inputs.btcFundingPct > BULL_FUNDING_THRESHOLD;
  if (bullBtcHit && bullFundingHit) {
    reasons.push(`btc_24h=+${inputs.btc24hReturnPct!.toFixed(2)}% > +${BULL_BTC_24H_THRESHOLD}%`);
    reasons.push(`funding=${inputs.btcFundingPct!.toFixed(4)}% > ${BULL_FUNDING_THRESHOLD}%`);
    return {
      regime: 'BULL',
      reasons,
      sizingMultiplier: 1.2, // +20%
      stopLossPct: 2.0,      // trail 2%
      takeProfitPct: 1.5,    // 1er palier (TP étagé)
      takeProfitLadderPct: [1.5, 2.5, 4.0],
    };
  }

  // ── 4. BEAR ───────────────────────────────────────────────────────
  const bearBtcHit =
    inputs.btc24hReturnPct != null && inputs.btc24hReturnPct < BEAR_BTC_24H_THRESHOLD;
  const bearFundingHit =
    inputs.btcFundingPct != null && inputs.btcFundingPct < BEAR_FUNDING_THRESHOLD;
  if (bearBtcHit && bearFundingHit) {
    reasons.push(`btc_24h=${inputs.btc24hReturnPct!.toFixed(2)}% < ${BEAR_BTC_24H_THRESHOLD}%`);
    reasons.push(`funding=${inputs.btcFundingPct!.toFixed(4)}% < ${BEAR_FUNDING_THRESHOLD}%`);
    return {
      regime: 'BEAR',
      reasons,
      sizingMultiplier: 0.7, // -30%
      stopLossPct: 2.0,
      takeProfitPct: 1.5,
      takeProfitLadderPct: [],
    };
  }

  // ── 5. RANGE ─────────────────────────────────────────────────────
  const rangeAtrHit =
    inputs.atr14BtcPct != null &&
    inputs.atr50BtcPct != null &&
    inputs.atr50BtcPct > 0 &&
    inputs.atr14BtcPct < RANGE_ATR_RATIO_THRESHOLD * inputs.atr50BtcPct;
  const rangeBtc24hHit =
    inputs.btc24hReturnPct != null &&
    Math.abs(inputs.btc24hReturnPct) < RANGE_BTC_24H_ABS_THRESHOLD;
  if (rangeAtrHit && rangeBtc24hHit) {
    const ratio = (inputs.atr14BtcPct! / inputs.atr50BtcPct!).toFixed(2);
    reasons.push(`atr14/atr50=${ratio} < ${RANGE_ATR_RATIO_THRESHOLD}`);
    reasons.push(`|btc_24h|=${Math.abs(inputs.btc24hReturnPct!).toFixed(2)}% < ${RANGE_BTC_24H_ABS_THRESHOLD}%`);
    return {
      regime: 'RANGE',
      reasons,
      sizingMultiplier: 1.0,
      stopLossPct: 1.2,
      takeProfitPct: 0.8, // scalping mean-reversion
      takeProfitLadderPct: [],
    };
  }

  // ── 6. NEUTRAL (default) ─────────────────────────────────────────
  if (inputs.btc24hReturnPct == null && inputs.vix == null && inputs.btcFundingPct == null) {
    reasons.push('inputs_unavailable');
  } else {
    reasons.push('no_threshold_matched');
  }
  return {
    regime: 'NEUTRAL',
    reasons,
    sizingMultiplier: 1.0,
    stopLossPct: 2.0,    // SL nominal
    takeProfitPct: 2.5,  // TP nominal
    takeProfitLadderPct: [],
  };
}
