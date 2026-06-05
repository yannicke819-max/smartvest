/**
 * Helpers PURS du SCANNER INTRADAY oversold ("rebond confirmé").
 *
 * Contrairement au scanner EOD 21:15 UTC qui ouvre sur un drop EOD pur,
 * l'intraday ne déclenche qu'un drop EN TRAIN DE REBONDIR — anti falling-knife
 * intra-séance.
 *
 * 5 critères ALL-MUST-PASS (cf. proposition user 05/06) :
 *   1. drop dans [-12%, -5%] vs close J-1 (réutilise le filtre existant)
 *   2. low_60min atteint mais PAS dans les N dernières bars (= bottom passé)
 *   3. reboundPct ≥ minReboundPct (% du low_60min au prix courant)
 *   4. trend_15m_pct ≥ min (slope positif sur les 3 dernières bars 5m)
 *   5. volume_last_30m / volume_first_30m ≥ min (intérêt acheteur sustained)
 *
 * Aucune dépendance NestJS / Supabase / réseau ici : 100% déterministe.
 */

export interface IntradayCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayReboundAnalysis {
  currentPrice: number;
  lowPrice: number;
  lowAtBarIdx: number; // 0 = premier bar (le plus ancien), bars.length-1 = courant
  reboundPct: number; // (current - low) / low * 100
  trend15mPct: number; // % change sur les 3 derniers bars 5m
  volumeLast30m: number;
  volumeFirst30m: number;
  volumeRatio: number; // volumeLast30m / volumeFirst30m (1.0 = stable)
  barsCount: number;
}

export interface IntradayReboundConfig {
  /** % min de rebond depuis le low_60min jusqu'au prix courant. Ex 1.5 = +1.5%. */
  minReboundPct: number;
  /** Slope min sur les 3 derniers bars 5m (= 15min). Ex 0.3 = +0.3%. */
  minTrend15mPct: number;
  /** Le low_60min doit être avant les N dernières bars. Ex 2 = pas dans les 10 dernières min. */
  bottomMustBeBeforeLastNBars: number;
  /** Ratio min volume_last_30m / volume_first_30m. Ex 0.8 = soutien acheteur. */
  minVolumeRatio: number;
  /** Min bars pour analyse fiable (sinon skip). Recommandé 10-12 bars = 50-60min. */
  minBarsRequired: number;
}

export const DEFAULT_INTRADAY_REBOUND_CONFIG: IntradayReboundConfig = {
  minReboundPct: 1.5,
  minTrend15mPct: 0.3,
  bottomMustBeBeforeLastNBars: 2,
  minVolumeRatio: 0.8,
  minBarsRequired: 10,
};

/**
 * Analyse une série de bars 5m pour détecter un "rebond confirmé".
 * Retourne null si pas assez de bars (< minBarsRequired).
 */
export function analyzeIntradayRebound(
  candles: IntradayCandle[],
  cfg: IntradayReboundConfig = DEFAULT_INTRADAY_REBOUND_CONFIG,
): IntradayReboundAnalysis | null {
  if (!candles || candles.length < cfg.minBarsRequired) return null;
  const n = candles.length;
  const currentPrice = candles[n - 1].close;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  // Low atteint sur la fenêtre (= bas réel intra-séance partiel)
  let lowPrice = candles[0].low;
  let lowAtBarIdx = 0;
  for (let i = 0; i < n; i++) {
    if (candles[i].low < lowPrice) {
      lowPrice = candles[i].low;
      lowAtBarIdx = i;
    }
  }
  if (!Number.isFinite(lowPrice) || lowPrice <= 0) return null;

  const reboundPct = ((currentPrice - lowPrice) / lowPrice) * 100;

  // Trend 15m : close[n-1] vs close[n-4] (3 bars = 15min)
  let trend15mPct = 0;
  if (n >= 4) {
    const refClose = candles[n - 4].close;
    if (refClose > 0) trend15mPct = ((currentPrice - refClose) / refClose) * 100;
  }

  // Volumes : partition en 6 premières bars vs 6 dernières (= 30min chacune)
  const half = Math.min(6, Math.floor(n / 2));
  let volFirst = 0;
  let volLast = 0;
  for (let i = 0; i < half; i++) volFirst += candles[i].volume || 0;
  for (let i = n - half; i < n; i++) volLast += candles[i].volume || 0;
  const volumeRatio = volFirst > 0 ? volLast / volFirst : 0;

  return {
    currentPrice,
    lowPrice,
    lowAtBarIdx,
    reboundPct,
    trend15mPct,
    volumeLast30m: volLast,
    volumeFirst30m: volFirst,
    volumeRatio,
    barsCount: n,
  };
}

/**
 * Applique les 4 gates "rebond confirmé" sur une analyse intraday.
 *
 * Retourne { pass: bool, reasons: string[] } — reasons liste les gates qui
 * ont failed (vide si pass=true), pour logging en cas de skip.
 */
export function passesIntradayReboundFilter(
  a: IntradayReboundAnalysis,
  cfg: IntradayReboundConfig = DEFAULT_INTRADAY_REBOUND_CONFIG,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Gate 1 : rebound minimum
  if (a.reboundPct < cfg.minReboundPct) {
    reasons.push(`rebound=${a.reboundPct.toFixed(2)}% < ${cfg.minReboundPct}%`);
  }

  // Gate 2 : trend récent positif
  if (a.trend15mPct < cfg.minTrend15mPct) {
    reasons.push(`trend15m=${a.trend15mPct.toFixed(2)}% < ${cfg.minTrend15mPct}%`);
  }

  // Gate 3 : low pas dans les N dernières bars (bottom doit être passé)
  const lastNStart = a.barsCount - cfg.bottomMustBeBeforeLastNBars;
  if (a.lowAtBarIdx >= lastNStart) {
    reasons.push(`bottom in last ${cfg.bottomMustBeBeforeLastNBars} bars (idx=${a.lowAtBarIdx}/${a.barsCount}) — falling knife risk`);
  }

  // Gate 4 : volume ratio (intérêt acheteur sustained)
  if (a.volumeRatio < cfg.minVolumeRatio) {
    reasons.push(`volRatio=${a.volumeRatio.toFixed(2)} < ${cfg.minVolumeRatio}`);
  }

  return { pass: reasons.length === 0, reasons };
}
