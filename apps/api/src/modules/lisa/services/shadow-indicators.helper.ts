/**
 * PR6.4 — Indicators techniques pure functions pour shadow enrichment.
 *
 * Calcule ATR(14) + EMA(N) depuis bougies daily.
 * Reuse-friendly : pas de dépendance NestJS, testable isolément.
 */

export interface DailyCandle {
  high: number;
  low: number;
  close: number;
}

/**
 * ATR (Average True Range) sur N périodes (Wilder 1978).
 *
 * True Range_t = max(
 *   high_t - low_t,
 *   |high_t - close_{t-1}|,
 *   |low_t  - close_{t-1}|
 * )
 *
 * ATR_t = (ATR_{t-1} × (N-1) + TR_t) / N    (Wilder smoothing)
 *
 * Premier ATR = moyenne arithmétique des N premiers TR.
 *
 * @param candles bougies en ordre chronologique (la plus récente en dernier).
 * @param period N, défaut 14.
 * @returns ATR du dernier point, null si candles.length < period+1.
 */
export function computeAtr(candles: DailyCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  // Compute TR for index ≥ 1 (needs prev close)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }

  if (trs.length < period) return null;

  // Initial ATR = simple mean of first N TRs
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;

  // Wilder smoothing for remaining
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

/**
 * EMA (Exponential Moving Average) sur N périodes.
 *
 * α = 2 / (N + 1)
 * EMA_0 = SMA des N premiers prix
 * EMA_t = α × price_t + (1 - α) × EMA_{t-1}
 *
 * @param prices closes en ordre chronologique.
 * @param period N (50 ou 200 pour BLOC 1 trend filter).
 * @returns EMA du dernier point, null si prices.length < period.
 */
export function computeEma(prices: number[], period: number): number | null {
  if (prices.length < period) return null;

  const alpha = 2 / (period + 1);

  // Initial EMA = SMA des N premiers
  let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;

  // Itère sur le reste
  for (let i = period; i < prices.length; i++) {
    ema = alpha * prices[i] + (1 - alpha) * ema;
  }

  return ema;
}

/**
 * Helper combiné : depuis une liste de candles daily, extrait ATR(14) + EMA50 + EMA200.
 * Tous null si données insuffisantes.
 */
export function computeDailyIndicators(candles: DailyCandle[]): {
  atr14: number | null;
  ema50: number | null;
  ema200: number | null;
} {
  const closes = candles.map((c) => c.close);
  return {
    atr14: computeAtr(candles, 14),
    ema50: computeEma(closes, 50),
    ema200: computeEma(closes, 200),
  };
}
