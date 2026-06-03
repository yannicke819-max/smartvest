/**
 * Helpers purs de calcul d'indicateurs techniques sur séries de candles.
 *
 * Utilisé par PositionIndicatorsTrackerService (Étape 3 tracker). Toutes les
 * fonctions sont pures + idempotentes pour testabilité. Conventions :
 *   - Input = tableau de candles ordonné ASC (plus ancien → plus récent)
 *   - Retour null si pas assez d'historique (caller stocke NULL en DB)
 *
 * Les seuils théoriques (WebSearch 03/06) + empiriques (backtest Phase B
 * n=2494) sont documentés dans out/indicator-calibration-*.json. Ici on ne
 * fait QUE le calcul brut — les seuils/gates sont la responsabilité du caller.
 */

export interface IndicatorCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorSnapshot {
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  atr14: number | null;
  atr14_pct: number | null;
  bb_upper: number | null;
  bb_middle: number | null;
  bb_lower: number | null;
  bb_pct_b: number | null;
  stoch_rsi_k: number | null;
  stoch_rsi_d: number | null;
  adx14: number | null;
  cci20: number | null;
  obv: number | null;
  obv_trend_pct: number | null;
  vwap: number | null;
  ema9: number | null;
  ema21: number | null;
  mfi14: number | null;
  roc5: number | null;
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function emaLast(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Série RSI complète (pour StochRSI). */
function rsiSeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const out: number[] = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export function macd(closes: number[]): { macd: number; signal: number; hist: number } | null {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (!e12.length || !e26.length) return null;
  const offset = e12.length - e26.length;
  const line: number[] = [];
  for (let i = 0; i < e26.length; i++) line.push(e12[i + offset] - e26[i]);
  const sig = emaSeries(line, 9);
  if (!sig.length) return null;
  const m = line[line.length - 1], s = sig[sig.length - 1];
  return { macd: m, signal: s, hist: m - s };
}

export function bollinger(closes: number[], period = 20, mult = 2): { upper: number; mid: number; lower: number; pctB: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  const pctB = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
  return { upper, mid, lower, pctB };
}

export function atr(candles: IndicatorCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let v = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) v = (v * (period - 1) + trs[i]) / period;
  return v;
}

export function adx(candles: IndicatorCandle[], period = 14): number | null {
  if (candles.length < 2 * period + 1) return null;
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const smooth = (arr: number[], n: number): number[] => {
    const out: number[] = [];
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); }
    return out;
  };
  const sT = smooth(trs, period), sP = smooth(pDM, period), sM = smooth(mDM, period);
  const dx: number[] = [];
  for (let i = 0; i < sT.length; i++) {
    const pDI = 100 * (sP[i] / (sT[i] || 1)), mDI = 100 * (sM[i] / (sT[i] || 1));
    dx.push(100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1));
  }
  if (dx.length < period) return null;
  let v = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) v = (v * (period - 1) + dx[i]) / period;
  return v;
}

export function cci(candles: IndicatorCandle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const tps = slice.map((c) => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
  if (meanDev === 0) return 0;
  const lastTp = tps[tps.length - 1];
  return (lastTp - sma) / (0.015 * meanDev);
}

export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } | null {
  const rs = rsiSeries(closes, rsiPeriod);
  if (rs.length < stochPeriod + kSmooth + dSmooth) return null;
  const stochVals: number[] = [];
  for (let i = stochPeriod - 1; i < rs.length; i++) {
    const window = rs.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window);
    stochVals.push(hi - lo === 0 ? 0 : ((rs[i] - lo) / (hi - lo)) * 100);
  }
  // %K = SMA(stoch, kSmooth), %D = SMA(%K, dSmooth)
  const sma = (arr: number[], n: number): number[] => {
    const out: number[] = [];
    for (let i = n - 1; i < arr.length; i++) out.push(arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
    return out;
  };
  const kSeries = sma(stochVals, kSmooth);
  const dSeries = sma(kSeries, dSmooth);
  if (!kSeries.length || !dSeries.length) return null;
  return { k: kSeries[kSeries.length - 1] / 100, d: dSeries[dSeries.length - 1] / 100 };
}

export function obv(candles: IndicatorCandle[]): { obv: number; trendPct: number | null } | null {
  if (candles.length < 2) return null;
  let v = 0;
  const series: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) v += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) v -= candles[i].volume;
    series.push(v);
  }
  // trend = variation OBV sur les 10 dernières candles (%)
  let trendPct: number | null = null;
  if (series.length >= 10) {
    const past = series[series.length - 10];
    if (past !== 0) trendPct = ((v - past) / Math.abs(past)) * 100;
  }
  return { obv: v, trendPct };
}

/** VWAP cumulé sur la série (intraday, reset implicite = série fournie). */
export function vwap(candles: IndicatorCandle[]): number | null {
  if (candles.length === 0) return null;
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

export function mfi(candles: IndicatorCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  let pos = 0, neg = 0;
  const start = candles.length - period - 1;
  for (let i = start + 1; i < candles.length; i++) {
    const rmf = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) pos += rmf;
    else if (tp[i] < tp[i - 1]) neg += rmf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

export function roc(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const prev = closes[closes.length - 1 - n];
  if (prev <= 0) return null;
  return ((closes[closes.length - 1] - prev) / prev) * 100;
}

/**
 * Construit un snapshot complet d'indicateurs depuis une série de candles.
 * Tous les champs sont null-safe (NULL si pas assez d'historique).
 */
export function computeIndicatorSnapshot(candles: IndicatorCandle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const lastClose = closes.length ? closes[closes.length - 1] : 0;
  const m = macd(closes);
  const b = bollinger(closes);
  const a = atr(candles);
  const sr = stochRsi(closes);
  const o = obv(candles);
  return {
    rsi14: rsi(closes),
    macd: m?.macd ?? null,
    macd_signal: m?.signal ?? null,
    macd_hist: m?.hist ?? null,
    atr14: a,
    atr14_pct: a !== null && lastClose > 0 ? (a / lastClose) * 100 : null,
    bb_upper: b?.upper ?? null,
    bb_middle: b?.mid ?? null,
    bb_lower: b?.lower ?? null,
    bb_pct_b: b?.pctB ?? null,
    stoch_rsi_k: sr?.k ?? null,
    stoch_rsi_d: sr?.d ?? null,
    adx14: adx(candles),
    cci20: cci(candles),
    obv: o?.obv ?? null,
    obv_trend_pct: o?.trendPct ?? null,
    vwap: vwap(candles),
    ema9: emaLast(closes, 9),
    ema21: emaLast(closes, 21),
    mfi14: mfi(candles),
    roc5: roc(closes, 5),
  };
}
