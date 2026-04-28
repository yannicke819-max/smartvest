/**
 * P3-B — Métriques pures sur une liste de trades simulés.
 *
 * Toutes les fonctions ici sont pures : `BacktestTrade[] → number | object`.
 * Pas d'I/O, pas d'aléa.
 */

import type { BacktestTrade, ExitKind } from './engine';

export interface BacktestMetrics {
  total: number;
  hitRates: Record<ExitKind, number>;
  hitCounts: Record<ExitKind, number>;
  /** P&L moyen par trade en %. */
  avgPnlPct: number;
  /** Médiane P&L (robuste aux outliers). */
  medianPnlPct: number;
  /** Expectancy = Σ(pnl × prob), équivalent à avgPnlPct ici car
   *  chaque trade est un échantillon de la distribution réelle. */
  expectancyPct: number;
  /** Cumul P&L en % (somme de tous les trades, pas compounding). */
  totalPnlPct: number;
  /** Max drawdown sur la séquence cumulative. */
  maxDrawdownPct: number;
  /** Sharpe simplifié = avg / stddev (annualisation grossière supposée
   *  daily trades). Vraie Sharpe nécessiterait un risk-free rate. */
  sharpeSimple: number;
  /** Win-rate = % trades pnl > 0. */
  winRate: number;
  /** Distribution PnL en buckets. */
  pnlBuckets: {
    'lt_-10pct': number;
    '_-10_to_-5pct': number;
    '_-5_to_0pct': number;
    '_0_to_5pct': number;
    '_5_to_10pct': number;
    '_10_to_15pct': number;
    'gt_15pct': number;
  };
  /** Holding bars moyen. */
  avgHoldingBars: number;
}

const ALL_KINDS: ExitKind[] = ['TP1', 'TP2', 'TP3', 'SL', 'TIMEOUT'];

export function computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const total = trades.length;
  if (total === 0) {
    return {
      total: 0,
      hitRates: emptyRates(),
      hitCounts: emptyRates(),
      avgPnlPct: 0,
      medianPnlPct: 0,
      expectancyPct: 0,
      totalPnlPct: 0,
      maxDrawdownPct: 0,
      sharpeSimple: 0,
      winRate: 0,
      pnlBuckets: {
        'lt_-10pct': 0,
        '_-10_to_-5pct': 0,
        '_-5_to_0pct': 0,
        '_0_to_5pct': 0,
        '_5_to_10pct': 0,
        '_10_to_15pct': 0,
        'gt_15pct': 0,
      },
      avgHoldingBars: 0,
    };
  }

  const hitCounts = emptyRates();
  for (const t of trades) hitCounts[t.exitKind]++;
  const hitRates = {} as Record<ExitKind, number>;
  for (const k of ALL_KINDS) hitRates[k] = hitCounts[k] / total;

  const pnls = trades.map((t) => t.pnlPct);
  const totalPnlPct = pnls.reduce((s, x) => s + x, 0);
  const avgPnlPct = totalPnlPct / total;
  const medianPnlPct = median(pnls);
  const winRate = trades.filter((t) => t.pnlPct > 0).length / total;
  const stddev = stddevOf(pnls, avgPnlPct);
  const sharpeSimple = stddev > 0 ? avgPnlPct / stddev : 0;
  const maxDrawdownPct = computeMaxDrawdown(pnls);

  const pnlBuckets = {
    'lt_-10pct': 0,
    '_-10_to_-5pct': 0,
    '_-5_to_0pct': 0,
    '_0_to_5pct': 0,
    '_5_to_10pct': 0,
    '_10_to_15pct': 0,
    'gt_15pct': 0,
  };
  for (const p of pnls) {
    if (p < -10) pnlBuckets['lt_-10pct']++;
    else if (p < -5) pnlBuckets['_-10_to_-5pct']++;
    else if (p < 0) pnlBuckets['_-5_to_0pct']++;
    else if (p < 5) pnlBuckets['_0_to_5pct']++;
    else if (p < 10) pnlBuckets['_5_to_10pct']++;
    else if (p < 15) pnlBuckets['_10_to_15pct']++;
    else pnlBuckets['gt_15pct']++;
  }

  const avgHoldingBars =
    trades.reduce((s, t) => s + t.holdingBars, 0) / total;

  return {
    total,
    hitRates,
    hitCounts,
    avgPnlPct: round2(avgPnlPct),
    medianPnlPct: round2(medianPnlPct),
    expectancyPct: round2(avgPnlPct), // équivalent par échantillonnage
    totalPnlPct: round2(totalPnlPct),
    maxDrawdownPct: round2(maxDrawdownPct),
    sharpeSimple: round2(sharpeSimple),
    winRate: round2(winRate),
    pnlBuckets,
    avgHoldingBars: round2(avgHoldingBars),
  };
}

export interface Verdict {
  decision: 'GO' | 'NO_GO';
  reasons: string[];
  /** Le seuil exact testé (extrait des constantes pour traçabilité). */
  thresholds: {
    minTp1HitRate: number;
    minExpectancyPct: number;
  };
}

export const VERDICT_THRESHOLDS = {
  minTp1HitRate: 0.55,
  minExpectancyPct: 0,
};

/**
 * Décision GO/NO-GO. GO si :
 *  - hit-rate (TP1+TP2+TP3) ≥ 55% (combiné, car TP2/TP3 capturent aussi
 *    un TP1 puis poursuite ; on ne pénalise pas un trade qui finit TP3
 *    pour ne pas être TP1)
 *  - expectancy > 0
 */
export function computeVerdict(metrics: BacktestMetrics): Verdict {
  const reasons: string[] = [];
  const tp1Plus =
    metrics.hitRates.TP1 + metrics.hitRates.TP2 + metrics.hitRates.TP3;
  const passTp1 = tp1Plus >= VERDICT_THRESHOLDS.minTp1HitRate;
  const passExpectancy = metrics.expectancyPct > VERDICT_THRESHOLDS.minExpectancyPct;
  if (!passTp1) {
    reasons.push(
      `tp1+ hit-rate ${(tp1Plus * 100).toFixed(1)}% < ${(VERDICT_THRESHOLDS.minTp1HitRate * 100).toFixed(0)}%`,
    );
  }
  if (!passExpectancy) {
    reasons.push(
      `expectancy ${metrics.expectancyPct}% <= 0`,
    );
  }
  return {
    decision: passTp1 && passExpectancy ? 'GO' : 'NO_GO',
    reasons: reasons.length > 0 ? reasons : ['all_thresholds_passed'],
    thresholds: { ...VERDICT_THRESHOLDS },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────

function emptyRates(): Record<ExitKind, number> {
  return { TP1: 0, TP2: 0, TP3: 0, SL: 0, TIMEOUT: 0 };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddevOf(xs: number[], mean: number): number {
  if (xs.length === 0) return 0;
  const variance =
    xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Drawdown maximum sur la séquence cumulative des pnls (par ordre
 * d'exécution). Approxime le worst-case loss séquentiel.
 */
function computeMaxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
