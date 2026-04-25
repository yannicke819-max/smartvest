/**
 * Mock déterministe de la logique Lisa pour le backtest.
 *
 * On NE remplace PAS le jugement de Claude — on reproduit le FRAMEWORK
 * de filtrage / scoring / sizing qui entoure ses décisions :
 *   - filtre anti-consensus (pénalise les tickers qui ralleyent fort)
 *   - profil sniper (cherche les anomalies intraday : vol spike, RSI extrême)
 *   - scoring conviction basé sur signaux techniques
 *   - sizing capital × cap classe × cap position
 *
 * Cela permet de tester si la STRUCTURE de la stratégie (caps, stops,
 * sizing) a un edge positif sur données historiques. Si elle ne l'a pas,
 * Claude ne pourra pas non plus produire un edge — le mock est donc
 * un test nécessaire mais pas suffisant.
 */

import type { Candle, TickerHistory } from './types';

export interface MockProposal {
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  /** Score de conviction 0-10. */
  convictionScore: number;
  /** Justification courte. */
  rationale: string;
  /** Stop suggéré en % depuis le prix d'entrée. */
  stopLossPct: number;
  /** Take-profit suggéré en %. */
  takeProfitPct: number;
  /** Si proposé comme option : type + strike OTM. */
  optionStructure?: {
    kind: 'call' | 'put';
    /** Décalage par rapport au spot pour le strike (en %). */
    strikeOtmPct: number;
    dteDays: number;
  };
}

export interface MockSignals {
  /** Variation 7 jours en % (momentum). */
  return7dPct: number | null;
  /** Z-score du volume du jour vs moyenne 20j. */
  volumeZ20d: number | null;
  /** RSI 14j (0-100). */
  rsi14: number | null;
  /** Position dans la bande de Bollinger 20-2 (-1 = bottom band, 1 = top band). */
  bbPosition: number | null;
}

/**
 * Calcule les signaux techniques à une date donnée pour un ticker.
 * Retourne null si pas assez d'historique avant.
 */
export function computeSignals(history: TickerHistory, asOfDate: string): MockSignals {
  const idx = history.candles.findIndex((c) => c.date === asOfDate);
  if (idx < 20) {
    return { return7dPct: null, volumeZ20d: null, rsi14: null, bbPosition: null };
  }

  const window20 = history.candles.slice(idx - 19, idx + 1);
  const closes20 = window20.map((c) => c.close);
  const volumes20 = window20.map((c) => c.volume);

  // Return 7j
  const return7dPct =
    idx >= 7
      ? ((history.candles[idx].close - history.candles[idx - 7].close) /
          history.candles[idx - 7].close) *
        100
      : null;

  // Volume Z-score 20j
  const meanVol = volumes20.reduce((s, v) => s + v, 0) / volumes20.length;
  const stdVol = Math.sqrt(
    volumes20.reduce((s, v) => s + (v - meanVol) ** 2, 0) / volumes20.length,
  );
  const volumeZ20d = stdVol > 0 ? (history.candles[idx].volume - meanVol) / stdVol : 0;

  // RSI 14j
  let gains = 0;
  let losses = 0;
  for (let i = idx - 13; i <= idx; i++) {
    if (i < 1) continue;
    const diff = history.candles[i].close - history.candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  const rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);

  // Bollinger 20-2 position
  const meanClose = closes20.reduce((s, v) => s + v, 0) / closes20.length;
  const stdClose = Math.sqrt(
    closes20.reduce((s, v) => s + (v - meanClose) ** 2, 0) / closes20.length,
  );
  const bbPosition = stdClose > 0 ? (history.candles[idx].close - meanClose) / (2 * stdClose) : 0;

  return { return7dPct, volumeZ20d, rsi14, bbPosition };
}

/**
 * Score un setup pour un ticker à une date. Retourne null si pas de setup,
 * sinon une proposition avec conviction.
 *
 * Heuristique sniper anti-consensus :
 *  - Anti-consensus pénalise les tickers en momentum fort (return 7d > X%
 *    proportionnel à anti_consensus_strength).
 *  - Setups acceptés : RSI extrême (< 30 oversold long, > 70 overbought short)
 *    OU volume anomaly (z > 2) OU position BB extrême.
 *  - Conviction basée sur la combinaison des signaux et la cohérence avec
 *    le contexte macro mock (régime fragmenté = baisse conviction global).
 */
export function scoreSetup(
  history: TickerHistory,
  asOfDate: string,
  antiConsensusStrength: number,
): MockProposal | null {
  const sig = computeSignals(history, asOfDate);
  if (sig.rsi14 == null || sig.return7dPct == null || sig.bbPosition == null) {
    return null;
  }

  // Anti-consensus filter : si return 7d > seuil, on évite (mainstream).
  // Seuil : 10 % à anti-consensus 0, descend à 2 % à anti-consensus 9.
  const consensusThresholdPct = Math.max(2, 10 - antiConsensusStrength);
  if (Math.abs(sig.return7dPct) > consensusThresholdPct && antiConsensusStrength > 3) {
    return null;
  }

  // Détection du setup
  let direction: 'long' | 'short' | null = null;
  let baseConviction = 0;
  let rationale = '';

  if (sig.rsi14 < 30 && sig.bbPosition < -0.7) {
    direction = 'long';
    baseConviction = 7;
    rationale = `Mean-reversion long : RSI ${sig.rsi14.toFixed(0)} oversold, BB pos ${sig.bbPosition.toFixed(2)} sous bande basse.`;
  } else if (sig.rsi14 > 70 && sig.bbPosition > 0.7) {
    direction = 'short';
    baseConviction = 7;
    rationale = `Mean-reversion short : RSI ${sig.rsi14.toFixed(0)} overbought, BB pos ${sig.bbPosition.toFixed(2)} au-dessus bande haute.`;
  } else if (sig.volumeZ20d != null && sig.volumeZ20d > 2.5) {
    // Anomalie volume sans RSI extrême = signal plus faible, suit la direction du mouvement
    direction = sig.return7dPct > 0 ? 'long' : 'short';
    baseConviction = 6;
    rationale = `Volume anomaly z=${sig.volumeZ20d.toFixed(1)} sans RSI extrême — momentum ${direction}.`;
  } else {
    return null;
  }

  // Bonus conviction si plusieurs signaux convergent
  let conviction = baseConviction;
  if (sig.volumeZ20d != null && sig.volumeZ20d > 1.5) conviction += 1;
  if (Math.abs(sig.bbPosition) > 1.0) conviction += 1;
  conviction = Math.min(10, conviction);

  return {
    symbol: history.symbol,
    assetClass: history.assetClass,
    direction,
    convictionScore: conviction,
    rationale,
    stopLossPct: 2,
    takeProfitPct: 4,
  };
}

/**
 * Génère les propositions du jour pour tout l'univers.
 * Trie par conviction décroissante.
 *
 * Si `optionsConfig.enableOptions` est true, les propositions de TRÈS haute
 * conviction (≥ 8/10) sont rebascuLées en options (long calls pour direction
 * long, long puts pour direction short). Asymétrie : max upside, downside
 * borné au premium.
 */
export function generateProposals(
  histories: TickerHistory[],
  asOfDate: string,
  antiConsensusStrength: number,
  minConviction: number = 6,
  optionsConfig?: {
    enableOptions: boolean;
    optionsDte: number;
    strikeOtmPct: number;
  },
): MockProposal[] {
  const proposals: MockProposal[] = [];
  for (const h of histories) {
    const p = scoreSetup(h, asOfDate, antiConsensusStrength);
    if (!p || p.convictionScore < minConviction) continue;

    if (optionsConfig?.enableOptions && p.convictionScore >= 8) {
      // Conviction très haute → bascule en options (asymétrie)
      p.optionStructure = {
        kind: p.direction === 'long' ? 'call' : 'put',
        strikeOtmPct: optionsConfig.strikeOtmPct,
        dteDays: optionsConfig.optionsDte,
      };
      p.rationale = `[OPTION] ${p.rationale}`;
    }
    proposals.push(p);
  }
  proposals.sort((a, b) => b.convictionScore - a.convictionScore);
  return proposals;
}

/** Helper : récupère le prix de close à une date (recherche dichotomique). */
export function closeAt(history: TickerHistory, date: string): number | null {
  let lo = 0;
  let hi = history.candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = history.candles[mid];
    if (c.date === date) return c.close;
    if (c.date < date) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** Helper : récupère la bougie à une date. */
export function candleAt(history: TickerHistory, date: string): Candle | null {
  let lo = 0;
  let hi = history.candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = history.candles[mid];
    if (c.date === date) return c;
    if (c.date < date) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
