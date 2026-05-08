/**
 * PR #292 — Pure helper pour analyser le price action 30min post-SL.
 *
 * Inputs :
 *   - exitPrice : prix au moment du SL trigger
 *   - exitTimestamp : timestamp du SL (unix seconds)
 *   - direction : 'long' | 'short' (gainers ouvre toujours long mais
 *     futur-proof la signature)
 *   - candlesPostSl : candles 1m sur [exitTs, exitTs + 30min] (sorted ASC)
 *   - candlesPriorAtr : candles 5m AVANT exitTs (au moins 14 pour ATR(14))
 *
 * Outputs JSONB-ready :
 *   - max_drawdown_post_sl_pct : % de baisse max après le SL (vs exitPrice)
 *   - max_recovery_post_sl_pct : % de hausse max post-SL (vs exitPrice)
 *   - rebound_to_50pct_within_30min : bool (high atteint exitPrice + |drawdown|/2 ?)
 *   - rebound_to_100pct_within_30min : bool (high atteint exitPrice ?)
 *   - atr_14_at_exit_pct : ATR(14) en % calculé sur les 14 dernières 5m candles
 *   - drawdown_in_atr_units : |drawdown_pct| / atr_pct (>1 = vrai mouvement, <1 = wick)
 *
 * Source ATR formula : average True Range = AVG(max(high-low, |high-close_prev|, |low-close_prev|))
 * sur 14 périodes. Référence : Wilder 1978 "New Concepts in Technical Trading Systems".
 */

export interface OhlcCandle {
  timestamp: number;       // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PostSlAnalysis {
  max_drawdown_post_sl_pct: number;       // négatif (baisse continuée after SL)
  max_recovery_post_sl_pct: number;       // positif (rebond)
  rebound_to_50pct_within_30min: boolean;
  rebound_to_100pct_within_30min: boolean;
  atr_14_at_exit_pct: number | null;
  drawdown_in_atr_units: number | null;   // |drawdown_pct| / atr_pct
  candle_count: number;
}

/**
 * Compute Average True Range (ATR) sur N périodes.
 * Inputs : candles ASC, retourne la valeur en valeur absolue (pas en %).
 * Si moins de N+1 candles, retourne null (pas assez de data).
 */
export function computeAtr(candles: readonly OhlcCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trList: number[] = [];
  // True Range nécessite la close précédente. On itère depuis index 1.
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trList.push(tr);
  }
  // ATR = simple average sur les `period` derniers TR
  const lastN = trList.slice(-period);
  if (lastN.length < period) return null;
  const sum = lastN.reduce((acc, x) => acc + x, 0);
  return sum / period;
}

/**
 * Analyse complète post-SL : drawdown, recovery, rebound thresholds, ATR comparison.
 * Pure function, testable isolation.
 */
export function computePostSlAnalysis(input: {
  exitPrice: number;
  exitTimestamp: number;
  direction: 'long' | 'short';
  candlesPostSl: readonly OhlcCandle[];      // sorted ASC, [exitTs, exitTs+30min]
  candlesPriorAtr: readonly OhlcCandle[];    // sorted ASC, candles AVANT exitTs (5m TF)
}): PostSlAnalysis {
  const { exitPrice, candlesPostSl, candlesPriorAtr, direction } = input;

  // Pour direction='long' : drawdown = baisse vs exitPrice, recovery = hausse
  // Pour direction='short' : inverse (mais on garde la convention positif=movement adverse)
  const isLong = direction === 'long';

  let maxDrawdownPct = 0;   // toujours <= 0 (négatif si baisse pour long)
  let maxRecoveryPct = 0;   // toujours >= 0 (positif si hausse pour long)

  for (const c of candlesPostSl) {
    if (isLong) {
      // Drawdown = low le plus bas
      const dropPct = (c.low - exitPrice) / exitPrice;  // négatif si low < exit
      if (dropPct < maxDrawdownPct) maxDrawdownPct = dropPct;
      // Recovery = high le plus haut
      const recoveryPct = (c.high - exitPrice) / exitPrice;  // positif si high > exit
      if (recoveryPct > maxRecoveryPct) maxRecoveryPct = recoveryPct;
    } else {
      // Short : drawdown = high (perte si prix monte), recovery = low
      const dropPct = (exitPrice - c.high) / exitPrice;  // négatif si high > exit
      if (dropPct < maxDrawdownPct) maxDrawdownPct = dropPct;
      const recoveryPct = (exitPrice - c.low) / exitPrice;  // positif si low < exit
      if (recoveryPct > maxRecoveryPct) maxRecoveryPct = recoveryPct;
    }
  }

  // Rebound to 50% : recovery atteint au moins |drawdown|/2 vs exitPrice ?
  // Rebound to 100% : recovery atteint exitPrice (= price came back to entry) ?
  // Note : si maxDrawdownPct = 0 (pas de baisse), rebound_50 trivialement true.
  const halfDrawdown = Math.abs(maxDrawdownPct) / 2;
  const rebound50 = maxRecoveryPct >= halfDrawdown;
  const rebound100 = maxRecoveryPct >= Math.abs(maxDrawdownPct);

  // ATR(14) en % de exitPrice (rapporté à exitPrice pour comparaison drawdown)
  const atrAbs = computeAtr(candlesPriorAtr, 14);
  const atrPct = atrAbs != null ? atrAbs / exitPrice : null;
  const drawdownInAtrUnits = atrPct != null && atrPct > 0
    ? Math.abs(maxDrawdownPct) / atrPct
    : null;

  return {
    max_drawdown_post_sl_pct: roundTo(maxDrawdownPct, 5),
    max_recovery_post_sl_pct: roundTo(maxRecoveryPct, 5),
    rebound_to_50pct_within_30min: rebound50,
    rebound_to_100pct_within_30min: rebound100,
    atr_14_at_exit_pct: atrPct != null ? roundTo(atrPct, 5) : null,
    drawdown_in_atr_units: drawdownInAtrUnits != null ? roundTo(drawdownInAtrUnits, 3) : null,
    candle_count: candlesPostSl.length,
  };
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
