/**
 * P3-B — Backtest engine pour la stratégie rebound-tp.
 *
 * Pure function. Prend une série OHLCV par ticker + une config, simule
 * la même logique que la prod (scanRebound + ReboundMonitor) sur chaque
 * jour t :
 *
 *   1. Si pas de position OPEN sur ce ticker → scanRebound(history[..t])
 *   2. Si BUY → ouvre position virtuelle entry=close[t], niveaux figés
 *   3. Bougies suivantes → cascade SL → TP3 → TP2 → TP1 → timeout
 *
 * Aucun I/O. Le caller (CLI runner) fournit les bougies, l'engine
 * retourne la liste de trades simulés. Les métriques sont calculées
 * séparément (cf. metrics.ts) pour pouvoir les recombiner par régime,
 * par ticker, par variant cfg.
 */

import { scanRebound, type Candle, type ReboundCfg } from '../strategies/rebound-tp';

export type ExitKind = 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TIMEOUT';

export interface BacktestTrade {
  ticker: string;
  entryDate: string | number;
  entryPrice: number;
  exitDate: string | number;
  exitPrice: number;
  exitKind: ExitKind;
  /** Durée en bougies (jours pour daily). */
  holdingBars: number;
  /** P&L en pourcentage du capital alloué (signed). Pondéré par
   *  filledQtyPct quand la sortie est partielle (TP1/TP2). */
  pnlPct: number;
  /** Confidence du signal au moment de l'entrée (0-1). */
  confidence: number;
  /** Niveau bb / drawdown / RSI au moment de l'entrée — pour analyse. */
  indicators: {
    rsi14: number;
    drawdown20Pct: number;
    volSpikeRatio: number;
  };
}

export interface TickerBars {
  ticker: string;
  bars: Candle[];
}

export interface BacktestRunCfg {
  /** Nombre minimum de bougies historiques avant qu'on commence à scanner.
   *  Match la contrainte de scanRebound (>=20). */
  warmupBars: number;
  /** Configuration scanRebound (TP/SL/timeStop/seuils). */
  scannerCfg: ReboundCfg;
}

/**
 * Backtest une seule série de bougies pour un ticker.
 * Retourne les trades simulés (peut être vide si jamais de signal).
 *
 * Note : on n'autorise qu'UNE position OPEN par ticker à la fois (même
 * règle que prod). Les signaux pendant que la position est OPEN sont ignorés.
 */
export function backtestTicker(
  bars: Candle[],
  ticker: string,
  cfg: BacktestRunCfg,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (!Array.isArray(bars) || bars.length < cfg.warmupBars) return trades;

  const timeStopBars = cfg.scannerCfg.timeStopDays ?? 10;

  // Pondérations qty exit par palier (match ReboundMonitor)
  const QTY_TP1 = 0.5;
  const QTY_TP2 = 0.3;

  let i = cfg.warmupBars - 1;
  while (i < bars.length) {
    const slice = bars.slice(0, i + 1);
    const sig = scanRebound(slice, cfg.scannerCfg);
    if (sig.type !== 'BUY') {
      i++;
      continue;
    }

    // Position ouverte à close[i].
    const entryBar = bars[i];
    const entryPrice = sig.entry;
    const tp1 = sig.tp1;
    const tp2 = sig.tp2;
    const tp3 = sig.tp3;
    const sl = sig.sl;

    let pnlPct = 0;
    let exitKind: ExitKind | null = null;
    let exitPrice = entryPrice;
    let exitBarIdx = i;
    let qtyRemaining = 1.0;
    let tp1Hit = false;
    let tp2Hit = false;

    // Avance les bougies depuis i+1.
    for (let j = i + 1; j < bars.length; j++) {
      const bar = bars[j];

      // Cascade : on teste SL d'abord (gestion du risque prioritaire),
      // puis TP3 → TP2 → TP1. Si le low a touché SL ET le high a touché
      // un TP, on considère que le SL prime (plus pessimiste, conservateur).
      if (bar.low <= sl) {
        // SL touché — close totalité au prix SL (assumption : stop limit).
        const slPnlPct = (sl - entryPrice) / entryPrice * 100 * qtyRemaining;
        pnlPct += slPnlPct;
        exitKind = 'SL';
        exitPrice = sl;
        exitBarIdx = j;
        break;
      }

      if (bar.high >= tp3) {
        const tp3PnlPct = (tp3 - entryPrice) / entryPrice * 100 * qtyRemaining;
        pnlPct += tp3PnlPct;
        exitKind = 'TP3';
        exitPrice = tp3;
        exitBarIdx = j;
        break;
      }

      if (bar.high >= tp2 && !tp2Hit) {
        const tp2PnlPct = (tp2 - entryPrice) / entryPrice * 100 * QTY_TP2;
        pnlPct += tp2PnlPct;
        qtyRemaining -= QTY_TP2;
        tp2Hit = true;
        // On continue à courir sur la qty restante.
      }

      if (bar.high >= tp1 && !tp1Hit) {
        const tp1PnlPct = (tp1 - entryPrice) / entryPrice * 100 * QTY_TP1;
        pnlPct += tp1PnlPct;
        qtyRemaining -= QTY_TP1;
        tp1Hit = true;
      }

      // Time stop : close au close[j] de cette bougie.
      if (j - i >= timeStopBars) {
        const timeoutPnlPct = (bar.close - entryPrice) / entryPrice * 100 * qtyRemaining;
        pnlPct += timeoutPnlPct;
        exitKind = 'TIMEOUT';
        exitPrice = bar.close;
        exitBarIdx = j;
        break;
      }
    }

    // Cas où on arrive à la fin de la série sans trigger : marquer TIMEOUT
    // au dernier close.
    if (!exitKind) {
      const last = bars[bars.length - 1];
      const finalPnlPct = (last.close - entryPrice) / entryPrice * 100 * qtyRemaining;
      pnlPct += finalPnlPct;
      exitKind = 'TIMEOUT';
      exitPrice = last.close;
      exitBarIdx = bars.length - 1;
    }

    // Si TP1 atteint mais pas TP2/TP3 → exit final = TP1 (palier le plus haut atteint).
    // Sinon (SL hit avant TP1) → SL.
    let finalExitKind: ExitKind = exitKind;
    if (exitKind === 'TIMEOUT' && tp1Hit && !tp2Hit) finalExitKind = 'TP1';
    else if (exitKind === 'TIMEOUT' && tp2Hit) finalExitKind = 'TP2';

    trades.push({
      ticker,
      entryDate: entryBar.timestamp,
      entryPrice,
      exitDate: bars[exitBarIdx].timestamp,
      exitPrice,
      exitKind: finalExitKind,
      holdingBars: exitBarIdx - i,
      pnlPct,
      confidence: sig.confidence,
      indicators: {
        rsi14: sig.indicators.rsi14,
        drawdown20Pct: sig.indicators.drawdown20Pct,
        volSpikeRatio: sig.indicators.volSpikeRatio,
      },
    });

    // Avance le curseur après la sortie pour pouvoir ré-ouvrir.
    i = exitBarIdx + 1;
  }

  return trades;
}

/**
 * Backtest l'univers complet (multi-tickers). Itère ticker par ticker
 * et concatène les trades. Pas d'allocation/sizing — chaque trade est
 * mesuré indépendamment (capital allocation laissée au caller).
 *
 * Useful pour le verdict GO/NO-GO car on agrège les hit-rates sur
 * tous les signaux indépendamment du capital.
 */
export function backtestUniverse(
  universe: TickerBars[],
  cfg: BacktestRunCfg,
): BacktestTrade[] {
  const all: BacktestTrade[] = [];
  for (const t of universe) {
    const ticker = t.ticker;
    const tickerTrades = backtestTicker(t.bars, ticker, cfg);
    all.push(...tickerTrades);
  }
  return all;
}
