/**
 * Bootstrap des rendements historiques + RNG seedable.
 *
 * 1. Calcule les rendements journaliers (close-to-close) sur la fenêtre lookback.
 * 2. Indexe par DATE pour préserver la corrélation cross-asset (chaque "jour
 *    bootstrap" pioche les rendements de TOUS les tickers du même jour réel).
 * 3. RNG : Mulberry32 — algo simple, seedable, périodicité 2^32, suffisant
 *    pour simuler 10k chemins × 365 jours.
 */

import type { TickerHistory } from '@smartvest/backtest';

export interface DailyReturns {
  /** Date du jour (YYYY-MM-DD). */
  date: string;
  /** ticker → return en fraction (0.01 = +1%). */
  returnsBySymbol: Map<string, number>;
}

/**
 * Construit la liste des rendements journaliers sur lookbackDays jours
 * jusqu'à asOfDate. Chaque entrée contient les rendements de TOUS les
 * tickers pour ce jour (avec fallback à 0 si data manquante).
 */
export function buildDailyReturnsTable(
  histories: TickerHistory[],
  asOfDate: string,
  lookbackDays: number,
): DailyReturns[] {
  // Collecter toutes les dates uniques dans la fenêtre
  const lookbackStart = new Date(asOfDate);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - lookbackDays);
  const startStr = lookbackStart.toISOString().slice(0, 10);

  const dateSet = new Set<string>();
  for (const h of histories) {
    for (const c of h.candles) {
      if (c.date >= startStr && c.date <= asOfDate) dateSet.add(c.date);
    }
  }
  const sortedDates = [...dateSet].sort();

  // Pour chaque ticker, indexe sa close-to-close return par date
  const returnsByTicker = new Map<string, Map<string, number>>();
  for (const h of histories) {
    const m = new Map<string, number>();
    for (let i = 1; i < h.candles.length; i++) {
      const prev = h.candles[i - 1];
      const cur = h.candles[i];
      if (prev.close > 0 && cur.date >= startStr && cur.date <= asOfDate) {
        m.set(cur.date, (cur.close - prev.close) / prev.close);
      }
    }
    returnsByTicker.set(h.symbol, m);
  }

  // Assemble par date
  const out: DailyReturns[] = [];
  for (const d of sortedDates) {
    const rmap = new Map<string, number>();
    for (const [sym, m] of returnsByTicker) {
      rmap.set(sym, m.get(d) ?? 0);
    }
    out.push({ date: d, returnsBySymbol: rmap });
  }
  return out;
}

/**
 * RNG Mulberry32 — seedable, déterministe.
 * Source : https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Échantillonne avec remplacement N indices dans [0, table.length-1].
 * Si la table est vide, retourne []. Si seed est fourni, déterministe.
 */
export function sampleIndices(
  tableSize: number,
  numSamples: number,
  rng: () => number,
): number[] {
  if (tableSize === 0) return [];
  const out: number[] = new Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = Math.floor(rng() * tableSize);
  }
  return out;
}
