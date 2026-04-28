/**
 * P3-A — Rebound-TP scanner.
 *
 * Pure function. Scanne une série OHLCV et identifie une **capitulation
 * confirmée + amorce de rebond** sur la dernière bougie close. Cible :
 * mean-reversion intraday/short-term sur tickers liquides survendus.
 *
 * Conditions BUY (TOUTES requises sur la dernière bougie close) :
 *   1. RSI(14) < rsiOversold (default 30)
 *   2. close < BollingerLower(20, 2)
 *   3. drawdown20 ≤ -minDrawdownPct (default 15) — peak du window 20 bougies
 *   4. volume_jour > volSpikeMult × SMA(volume, 20) (default 1.5×)
 *   5. Bougie de retournement :
 *        close[t] > open[t]      (chandelle haussière)
 *        ET  RSI[t] > RSI[t-1]   (RSI improving)
 *        ET  RSI[t-1] < 30       (la bougie précédente était survendue)
 *
 * Niveaux pct sur entry (cfg surchargeable, defaults ENV) :
 *   TP1 +5%   (sortie 50% qty)
 *   TP2 +10%  (sortie 30% qty)
 *   TP3 +15%  (sortie 20% qty)
 *   SL  -4%   OU close < low du jour d'entrée trigger immédiat
 *   time stop : 10 jours
 *
 * Returns un signal HOLD avec `reason` détaillé si une condition manque,
 * BUY si toutes valides. Aucun I/O, aucun side-effect.
 */

export interface Candle {
  /** ISO timestamp ou millis epoch — uniquement informatif, le scanner
   *  utilise l'index, pas la date. */
  timestamp: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReboundCfg {
  rsiPeriod?: number; // default 14
  rsiOversold?: number; // default 30
  bbPeriod?: number; // default 20
  bbStdDev?: number; // default 2
  minDrawdownPct?: number; // default 15 (positif, comparé au drawdown négatif)
  volPeriod?: number; // default 20
  volSpikeMult?: number; // default 1.5
  tp1Pct?: number; // default 5
  tp2Pct?: number; // default 10
  tp3Pct?: number; // default 15
  slPct?: number; // default 4
  timeStopDays?: number; // default 10
}

export type ReboundSignal =
  | {
      type: 'BUY';
      entry: number;
      tp1: number;
      tp2: number;
      tp3: number;
      sl: number;
      timeStopDays: number;
      /** Confidence ∈ [0, 1] — combinaison normalisée des marges de
       *  dépassement des seuils (RSI, BB, drawdown, volume). */
      confidence: number;
      indicators: {
        rsi14: number;
        rsi14Prev: number;
        bbLower: number;
        bbUpper: number;
        ma20: number;
        drawdown20Pct: number;
        volSma20: number;
        volSpikeRatio: number;
      };
    }
  | {
      type: 'HOLD';
      reason: string;
    };

const DEFAULTS: Required<ReboundCfg> = {
  rsiPeriod: 14,
  rsiOversold: 30,
  bbPeriod: 20,
  bbStdDev: 2,
  minDrawdownPct: 15,
  volPeriod: 20,
  volSpikeMult: 1.5,
  tp1Pct: 5,
  tp2Pct: 10,
  tp3Pct: 15,
  slPct: 4,
  timeStopDays: 10,
};

export function scanRebound(history: Candle[], cfg: ReboundCfg = {}): ReboundSignal {
  const c = { ...DEFAULTS, ...cfg };

  // ── Sanity checks ─────────────────────────────────────────────────
  if (!Array.isArray(history)) {
    return { type: 'HOLD', reason: 'invalid_history_not_array' };
  }
  // Besoin de RSI[t] et RSI[t-1] (chacun nécessite rsiPeriod+1 closes).
  // Le `t-1` recule encore d'1 → minBars = max(rsiPeriod+2, bbPeriod, volPeriod, 20).
  const minBars = Math.max(c.rsiPeriod + 2, c.bbPeriod, c.volPeriod, 20);
  if (history.length < minBars) {
    return { type: 'HOLD', reason: `insufficient_bars_${history.length}<${minBars}` };
  }
  for (const bar of history) {
    if (
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close) ||
      !Number.isFinite(bar.volume) ||
      bar.open <= 0 ||
      bar.high <= 0 ||
      bar.low <= 0 ||
      bar.close <= 0 ||
      bar.volume < 0 ||
      bar.high < bar.low
    ) {
      return { type: 'HOLD', reason: 'invalid_bar_values' };
    }
  }

  const lastIdx = history.length - 1;
  const t = history[lastIdx];

  // ── RSI[t] and RSI[t-1] ───────────────────────────────────────────
  const rsi14 = computeRsi(
    history.slice(lastIdx - c.rsiPeriod, lastIdx + 1).map((b) => b.close),
    c.rsiPeriod,
  );
  const rsi14Prev = computeRsi(
    history.slice(lastIdx - 1 - c.rsiPeriod, lastIdx).map((b) => b.close),
    c.rsiPeriod,
  );
  if (rsi14 === null || rsi14Prev === null) {
    return { type: 'HOLD', reason: 'rsi_compute_failed' };
  }

  // ── Bollinger Bands(20, 2) sur close ──────────────────────────────
  const bbCloses = history.slice(lastIdx - c.bbPeriod + 1, lastIdx + 1).map((b) => b.close);
  const ma20 = mean(bbCloses);
  const stdev20 = stddev(bbCloses, ma20);
  const bbLower = ma20 - c.bbStdDev * stdev20;
  const bbUpper = ma20 + c.bbStdDev * stdev20;

  // ── Drawdown 20 ─────────────────────────────────────────────────
  // = (close[t] - max(high) sur les 20 dernières bougies) / max × 100
  const window20 = history.slice(lastIdx - 19, lastIdx + 1);
  const peak20 = window20.reduce((m, b) => Math.max(m, b.high), -Infinity);
  if (!Number.isFinite(peak20) || peak20 <= 0) {
    return { type: 'HOLD', reason: 'invalid_peak20' };
  }
  const drawdown20Pct = ((t.close - peak20) / peak20) * 100;

  // ── Volume SMA(20) + spike ratio ─────────────────────────────────
  const volWindow = history.slice(lastIdx - c.volPeriod + 1, lastIdx + 1).map((b) => b.volume);
  const volSma = mean(volWindow);
  const volSpikeRatio = volSma > 0 ? t.volume / volSma : 0;

  // ── Conditions BUY ───────────────────────────────────────────────
  const conds = {
    rsiOversold: rsi14 < c.rsiOversold,
    bbBreak: t.close < bbLower,
    drawdown: drawdown20Pct <= -c.minDrawdownPct,
    volSpike: volSpikeRatio > c.volSpikeMult,
    reversalCandle:
      t.close > t.open && rsi14 > rsi14Prev && rsi14Prev < c.rsiOversold,
  };

  // Diagnostic HOLD if any cond fails
  const failed: string[] = [];
  if (!conds.rsiOversold) failed.push(`rsi=${rsi14.toFixed(1)}>=${c.rsiOversold}`);
  if (!conds.bbBreak) failed.push(`close=${t.close.toFixed(2)}>=bbLower=${bbLower.toFixed(2)}`);
  if (!conds.drawdown) failed.push(`dd=${drawdown20Pct.toFixed(1)}%>-${c.minDrawdownPct}%`);
  if (!conds.volSpike) failed.push(`volRatio=${volSpikeRatio.toFixed(2)}<=${c.volSpikeMult}`);
  if (!conds.reversalCandle) {
    if (t.close <= t.open) failed.push('candle_not_bullish');
    else if (rsi14 <= rsi14Prev) failed.push('rsi_not_improving');
    else if (rsi14Prev >= c.rsiOversold) failed.push('rsi_prev_not_oversold');
  }
  if (failed.length > 0) {
    return { type: 'HOLD', reason: failed.join('; ') };
  }

  // ── BUY signal ────────────────────────────────────────────────────
  const entry = t.close;
  const tp1 = round2(entry * (1 + c.tp1Pct / 100));
  const tp2 = round2(entry * (1 + c.tp2Pct / 100));
  const tp3 = round2(entry * (1 + c.tp3Pct / 100));
  const sl = round2(entry * (1 - c.slPct / 100));

  // Confidence = moyenne normalisée des marges :
  //  - rsiMargin    = (oversold − rsi14) / oversold  → plus rsi est bas, plus margin est grand
  //  - ddMargin     = (|dd| − minDd) / minDd, capped à 1
  //  - volMargin    = (volSpikeRatio − volSpikeMult) / volSpikeMult, capped à 1
  //  - bbMargin     = (bbLower − close) / bbLower, capped à 1
  const rsiMargin = clamp01((c.rsiOversold - rsi14) / c.rsiOversold);
  const ddMargin = clamp01((Math.abs(drawdown20Pct) - c.minDrawdownPct) / c.minDrawdownPct);
  const volMargin = clamp01((volSpikeRatio - c.volSpikeMult) / c.volSpikeMult);
  const bbMargin = clamp01((bbLower - t.close) / bbLower);
  const confidence = round2((rsiMargin + ddMargin + volMargin + bbMargin) / 4);

  return {
    type: 'BUY',
    entry: round2(entry),
    tp1,
    tp2,
    tp3,
    sl,
    timeStopDays: c.timeStopDays,
    confidence,
    indicators: {
      rsi14: round2(rsi14),
      rsi14Prev: round2(rsi14Prev),
      bbLower: round2(bbLower),
      bbUpper: round2(bbUpper),
      ma20: round2(ma20),
      drawdown20Pct: round2(drawdown20Pct),
      volSma20: Math.round(volSma),
      volSpikeRatio: round2(volSpikeRatio),
    },
  };
}

// ── Internes : indicateurs purs ──────────────────────────────────────

/**
 * RSI Wilder simplifié (moyenne arithmétique des gains/pertes au lieu
 * de la moving avg de Wilder).
 * Retourne null si données insuffisantes ou avgLoss=0 (cas pathologique
 * extrême d'une série toujours haussière, géré upstream).
 */
function computeRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) {
    // Pas de pertes → RSI = 100 (overbought maximum). On retourne 100
    // explicitement plutôt que null pour ne pas bloquer le scanner.
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: number[], avg: number): number {
  if (xs.length === 0) return 0;
  const variance = xs.reduce((s, x) => s + (x - avg) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
