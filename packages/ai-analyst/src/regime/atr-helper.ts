/**
 * P1 — ATR (Average True Range) helper pour TacticalRegime classifier.
 *
 * Pure function (no I/O). Le caller fetch les bars via le provider (Binance
 * klines) et passe le tableau ici pour calcul.
 *
 * Définition ATR (Wilder simplifié) :
 *   TR_i = max(high_i - low_i, |high_i - close_{i-1}|, |low_i - close_{i-1}|)
 *   ATR_N = moyenne arithmétique des N derniers TR
 *
 * On retourne ATR en POURCENTAGE du dernier close (réf. close pour
 * comparer entre actifs / horizons / conditions de prix). Le classifier
 * compare `atr14_pct < 0.8 × atr50_pct` pour détecter RANGE.
 */

export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

/**
 * Calcule l'ATR sur N périodes en POURCENTAGE du dernier close.
 *
 * Conditions :
 *  - bars.length >= period + 1 (besoin de close_{i-1} pour le 1er TR)
 *  - dernier close > 0 (sinon division par zéro)
 *  - tous les prix high/low/close finite et > 0
 *
 * Retourne null si les conditions ne sont pas réunies.
 */
export function computeAtrPct(bars: OhlcBar[], period: number): number | null {
  if (!Array.isArray(bars)) return null;
  if (period < 1) return null;
  if (bars.length < period + 1) return null;

  // Sanity check : tous les bars doivent avoir des nombres valides.
  for (const b of bars) {
    if (!Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close)) {
      return null;
    }
    if (b.high <= 0 || b.low <= 0 || b.close <= 0) return null;
    if (b.high < b.low) return null; // cohérence
  }

  // Calcule TR sur les `period` derniers bars (en utilisant le close du
  // bar précédent comme référence).
  const startIdx = bars.length - period;
  let sumTr = 0;
  for (let i = startIdx; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1]; // garanti existant car bars.length >= period+1
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sumTr += tr;
  }
  const atr = sumTr / period;

  const lastClose = bars[bars.length - 1].close;
  if (lastClose <= 0) return null;
  return (atr / lastClose) * 100;
}

/**
 * P1 — Calcule la volatilité réalisée sur 1h à partir de N bars 1m.
 *
 * Estimation classique :
 *   r_i = ln(close_i / close_{i-1})   (log returns 1m)
 *   variance = (1/N) × Σ(r_i^2)        (mean ≈ 0 sur fenêtre courte)
 *   stddev_1m = √variance
 *   realized_1h = stddev_1m × √N × 100  (en % par heure)
 *
 * Pour N=60 (1m × 60 = 1h), le scaling √60 ≈ 7.75 donne une mesure de
 * "combien BTC a bougé en 1h" en termes de volatilité (stddev), pas
 * en termes de high-low range.
 *
 * Conditions :
 *  - bars.length ≥ N+1 (besoin du close_{i-1} pour le 1er return)
 *  - tous les closes > 0
 *  - N ≥ 2
 *
 * Retourne null si conditions non remplies. La valeur peut être 0 si
 * aucun mouvement (closes tous identiques) — comportement correct.
 *
 * Cf. classifier `realized1hPct > 3` triggers VOL_SPIKE.
 */
export function computeRealizedVolPct(bars: OhlcBar[], periods: number = 60): number | null {
  if (!Array.isArray(bars)) return null;
  if (periods < 2) return null;
  if (bars.length < periods + 1) return null;

  // Prend les `periods+1` derniers bars (pour avoir periods returns).
  const startIdx = bars.length - periods - 1;
  const slice = bars.slice(startIdx);

  // Sanity check : closes valides.
  for (const b of slice) {
    if (!Number.isFinite(b.close) || b.close <= 0) return null;
  }

  // Compute log returns + variance.
  let sumSquares = 0;
  for (let i = 1; i < slice.length; i++) {
    const r = Math.log(slice[i].close / slice[i - 1].close);
    if (!Number.isFinite(r)) return null;
    sumSquares += r * r;
  }
  const variance = sumSquares / periods;
  const stddev1m = Math.sqrt(variance);
  return stddev1m * Math.sqrt(periods) * 100;
}
