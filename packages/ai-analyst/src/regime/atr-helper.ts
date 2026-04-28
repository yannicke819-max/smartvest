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
