/**
 * AXEES T2-A — Volatility Cartographer.
 *
 * Vision AXEES :
 *
 *   "VIX seul ne suffit pas — tu peux avoir VIX 18 mais un secteur tech en
 *    panic-mode interne. On cartographie la vol par secteur/région/asset
 *    class et on émet des MARKET_UNSAFE ciblés (par cellule), pas globalement."
 *
 * Aujourd'hui SmartVest a un kill-switch global ou rien. Demain : "close 100%
 * tech US mais garde EU value qui est paisible". Granularité par cellule
 * (sector × region) au lieu d'un VIX unique.
 *
 * Cette couche définit :
 *   - CartographyCell : une cellule (sector, region) avec realized vol + z-score
 *   - VolatilityMap : agrégat de cellules avec verdict par cellule
 *   - buildVolatilityMap(cells, thresholds?) : pure fn
 *   - cellVerdict(cell, thresholds) : MARKET_UNSAFE | CHASE_THE_TOP | REDUCE_SIZE | HOLD
 *
 * Inputs déterministes : realized vol = stddev des returns intraday (annualisé)
 * sur fenêtre 5j et 20j. Z-score = (vol5d - baseline60d_mean) / baseline60d_std.
 * Le caller fournit ces stats pré-calculées — on ne fait pas le data-fetch.
 *
 * Back-compat : ADDITIVE. Pas de wiring avec scanner / mechanical dans cette PR.
 * Reuses #444 verdict semantic + #446 vetoes scoped per-cell.
 */

import type { TradingDecision } from './trading-decision';

/**
 * Une cellule de carto vol — pré-calculée par le caller.
 */
export interface CartographyCell {
  /** Identifiant secteur. ex: 'Technology', 'Healthcare', 'Energy'. */
  sector: string;
  /** Identifiant région. ex: 'US', 'EU', 'ASIA', 'CRYPTO'. */
  region: string;
  /** Realized vol 5j annualisée en %. ex: 25.0 = 25% vol annualisée. */
  realizedVol5dPct: number;
  /** Realized vol 20j annualisée en %. */
  realizedVol20dPct: number;
  /** Z-score de vol5d vs baseline 60j (moyenne 0, stddev 1). */
  volZScore60d: number;
  /** Nombre de symboles dans la cellule (audit + qualité). */
  symbolCount: number;
  /** Optionnel : flag de stress observé (ex: ≥3 gap downs simultanés). */
  stressFlag?: boolean;
}

/**
 * Seuils de classification par cellule.
 */
export interface VolatilityCartographyThresholds {
  /** Z-score au-delà duquel cellule = PANIC (MARKET_UNSAFE). */
  panicZScore: number;
  /** Z-score au-delà duquel cellule = stress (REDUCE_SIZE). */
  stressZScore: number;
  /** Z-score en-dessous duquel cellule = compression suspecte (CHASE_THE_TOP risk). */
  compressionZScore: number;
  /** Vol 5j absolue (en %) au-delà de laquelle MARKET_UNSAFE peu importe le z-score. */
  absoluteVolPanicPct: number;
  /** Sample minimum (symbolCount) pour considérer la cellule fiable. */
  minSymbolCount: number;
}

export const DEFAULT_VOLATILITY_THRESHOLDS: VolatilityCartographyThresholds = {
  panicZScore: 2.5,
  stressZScore: 1.5,
  compressionZScore: -1.5,
  absoluteVolPanicPct: 50,
  minSymbolCount: 3,
};

export interface CellVerdict {
  cell: CartographyCell;
  decision: TradingDecision;
  /** Confidence 0..1 du verdict (proportional to |zScore| / panicZScore). */
  confidence: number;
  rationale: string;
  /** Sample insuffisant -> verdict moins fiable. */
  lowConfidenceData: boolean;
}

export interface VolatilityMap {
  /** Verdicts par cellule (1:1 avec cells input). */
  verdicts: ReadonlyArray<CellVerdict>;
  /** Compteurs agrégés pour observability. */
  summary: {
    totalCells: number;
    panicCells: number;
    stressedCells: number;
    compressedCells: number;
    healthyCells: number;
    lowDataCells: number;
  };
  /** Cellules à exclure totalement (PANIC) — utile pour scanner filter direct. */
  excludedCells: ReadonlyArray<{ sector: string; region: string }>;
}

/**
 * Évalue le verdict d'une cellule isolée.
 *
 * Priorité :
 *   1. Sample insuffisant -> REGIME_UNKNOWN + lowConfidenceData=true
 *   2. stressFlag explicite -> MARKET_UNSAFE
 *   3. vol absolue > seuil OR z-score > panicZScore -> MARKET_UNSAFE
 *   4. z-score > stressZScore -> REDUCE_SIZE
 *   5. z-score < compressionZScore -> CHASE_THE_TOP (compression suspecte,
 *      anti-FOMO : une cellule trop calme avant explosion)
 *   6. sinon -> HOLD
 */
export function cellVerdict(
  cell: CartographyCell,
  thresholds: VolatilityCartographyThresholds = DEFAULT_VOLATILITY_THRESHOLDS,
): CellVerdict {
  if (cell.symbolCount < thresholds.minSymbolCount) {
    return {
      cell,
      decision: 'REGIME_UNKNOWN',
      confidence: 0,
      rationale: `Sample ${cell.symbolCount} < ${thresholds.minSymbolCount} : cellule peu fiable.`,
      lowConfidenceData: true,
    };
  }

  if (cell.stressFlag === true) {
    return {
      cell,
      decision: 'MARKET_UNSAFE',
      confidence: 0.9,
      rationale: 'StressFlag explicite : cellule en stress (gap downs simultanés).',
      lowConfidenceData: false,
    };
  }

  if (cell.realizedVol5dPct >= thresholds.absoluteVolPanicPct) {
    return {
      cell,
      decision: 'MARKET_UNSAFE',
      confidence: Math.min(1, cell.realizedVol5dPct / thresholds.absoluteVolPanicPct),
      rationale: `Vol absolue ${cell.realizedVol5dPct.toFixed(1)}% >= seuil ${thresholds.absoluteVolPanicPct}% : PANIC.`,
      lowConfidenceData: false,
    };
  }

  if (cell.volZScore60d >= thresholds.panicZScore) {
    return {
      cell,
      decision: 'MARKET_UNSAFE',
      confidence: Math.min(1, cell.volZScore60d / thresholds.panicZScore),
      rationale: `Z-score ${cell.volZScore60d.toFixed(2)} >= seuil panic ${thresholds.panicZScore} : PANIC.`,
      lowConfidenceData: false,
    };
  }

  if (cell.volZScore60d >= thresholds.stressZScore) {
    return {
      cell,
      decision: 'REDUCE_SIZE',
      confidence: cell.volZScore60d / thresholds.panicZScore,
      rationale: `Z-score ${cell.volZScore60d.toFixed(2)} >= seuil stress ${thresholds.stressZScore} : sizing réduit.`,
      lowConfidenceData: false,
    };
  }

  if (cell.volZScore60d <= thresholds.compressionZScore) {
    return {
      cell,
      decision: 'CHASE_THE_TOP',
      confidence: Math.abs(cell.volZScore60d) / Math.abs(thresholds.compressionZScore),
      rationale: `Z-score ${cell.volZScore60d.toFixed(2)} <= seuil compression ${thresholds.compressionZScore} : trop calme, risque retournement (anti-FOMO).`,
      lowConfidenceData: false,
    };
  }

  return {
    cell,
    decision: 'HOLD',
    confidence: 0.6,
    rationale: `Z-score ${cell.volZScore60d.toFixed(2)} en zone normale : HOLD.`,
    lowConfidenceData: false,
  };
}

/**
 * Construit la carto complète à partir d'une liste de cellules pré-calculées.
 * Pure fn déterministe — testable sans I/O.
 */
export function buildVolatilityMap(
  cells: ReadonlyArray<CartographyCell>,
  thresholds: VolatilityCartographyThresholds = DEFAULT_VOLATILITY_THRESHOLDS,
): VolatilityMap {
  const verdicts = cells.map((c) => cellVerdict(c, thresholds));

  const summary = {
    totalCells: cells.length,
    panicCells: verdicts.filter((v) => v.decision === 'MARKET_UNSAFE').length,
    stressedCells: verdicts.filter((v) => v.decision === 'REDUCE_SIZE').length,
    compressedCells: verdicts.filter((v) => v.decision === 'CHASE_THE_TOP').length,
    healthyCells: verdicts.filter((v) => v.decision === 'HOLD').length,
    lowDataCells: verdicts.filter((v) => v.lowConfidenceData).length,
  };

  const excludedCells = verdicts
    .filter((v) => v.decision === 'MARKET_UNSAFE')
    .map((v) => ({ sector: v.cell.sector, region: v.cell.region }));

  return { verdicts, summary, excludedCells };
}

/**
 * Helper : récupère le verdict d'une cellule (sector, region) dans la carto.
 * Retourne undefined si la cellule n'est pas mappée — caller doit alors
 * décider du fallback (HOLD conservatif, ou REGIME_UNKNOWN strict).
 */
export function findCellVerdict(
  map: VolatilityMap,
  sector: string,
  region: string,
): CellVerdict | undefined {
  return map.verdicts.find((v) => v.cell.sector === sector && v.cell.region === region);
}

/**
 * Helper : true si la cellule est explicitement exclue (PANIC).
 * Le scanner peut court-circuiter tout candidat dans cette cellule.
 */
export function isCellExcluded(
  map: VolatilityMap,
  sector: string,
  region: string,
): boolean {
  return map.excludedCells.some((c) => c.sector === sector && c.region === region);
}
