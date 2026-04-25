/**
 * Types publics du Monte Carlo simulator.
 *
 * Différence avec le backtest :
 *  - Backtest = rejeu déterministe sur des données passées qui se sont produites.
 *  - Monte Carlo = N trajectoires SYNTHÉTIQUES tirées de la distribution des
 *    rendements historiques. On ne sait pas ce qui se passera demain, mais on
 *    peut estimer la distribution des résultats possibles.
 *
 * Méthode utilisée : BOOTSTRAP des rendements journaliers historiques.
 *  - Pour chaque jour de l'horizon, on tire au hasard (avec remplacement) un
 *    jour des N derniers mois.
 *  - On applique les rendements de CE jour à TOUS les tickers — préserve
 *    naturellement les corrélations cross-asset (ex. quand SPY baisse, VXX
 *    monte ; on ne casse pas ce lien en tirant indépendamment par ticker).
 *  - Pas de fitting paramétrique (gaussienne, etc.) — on assume que le passé
 *    récent est représentatif des distributions possibles.
 *
 * Limites honnêtes (à signaler dans l'UI) :
 *  - Pas de régime change : si le futur est dans un régime jamais vu (covid,
 *    tarif shock), la simulation sous-estime le risque.
 *  - Bootstrap conserve la stationnarité — ne fait pas apparaître de drift
 *    de tendance long terme nouvelle.
 */

import { z } from 'zod';

export const MonteCarloConfigSchema = z.object({
  /** Date de référence pour les rendements historiques (par défaut aujourd'hui). */
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Combien de jours d'historique utiliser pour le bootstrap. Plus = plus
   *  de diversité de régimes mais inclut potentiellement des conditions
   *  obsolètes. */
  lookbackDays: z.number().int().min(30).max(720).default(180),
  /** Horizon de projection en jours de trading. */
  horizonDays: z.number().int().min(5).max(365).default(30),
  /** Nombre de trajectoires à simuler. */
  numPaths: z.number().int().min(100).max(10_000).default(1000),
  /** Capital initial en USD. */
  initialCapitalUsd: z.number().positive().default(10_000),
  /** Univers de tickers (vide = défaut). */
  universe: z.array(z.string()).default([]),
  /** Filtre anti-consensus pour la mock-Lisa. */
  antiConsensusStrength: z.number().int().min(0).max(10).default(5),
  maxPositionSizePct: z.number().min(1).max(50).default(8),
  maxAssetClassExposurePct: z.number().min(1).max(100).default(20),
  maxOpenPositions: z.number().int().min(1).max(50).default(12),
  /** Si true, le sizing peut dépasser le cash dispo jusqu'à cash × maxLeverage. */
  enableLeverage: z.boolean().default(false),
  /** Multiple max d'exposition vs equity. 1.0 = pas de levier, 2.0 = ×2, 3.0 = aggressif. */
  maxLeverage: z.number().min(1).max(5).default(1.5),
  slippageBps: z.number().min(0).max(100).default(10),
  feeBps: z.number().min(0).max(100).default(10),
  stopLossPct: z.number().min(0.5).max(20).default(2),
  takeProfitPct: z.number().min(0.5).max(50).default(4),
  maxHorizonDays: z.number().int().min(1).max(60).default(5),
  /** Seuil cible pour calculer P(equity_final > target). */
  targetEquityUsd: z.number().positive().optional(),
  /** Seed RNG pour reproductibilité (optionnel). */
  randomSeed: z.number().int().optional(),
});

export type MonteCarloConfig = z.infer<typeof MonteCarloConfigSchema>;

/** Résultat d'une trajectoire individuelle. */
export interface PathResult {
  /** Equity finale (USD). */
  finalEquity: number;
  /** Return total %. */
  returnPct: number;
  /** Max drawdown %. */
  maxDrawdownPct: number;
  /** Nombre de trades fermés. */
  totalTrades: number;
}

/** Statistiques agrégées sur l'ensemble des trajectoires. */
export interface MonteCarloStatistics {
  numPaths: number;
  /** Equity finale : percentiles. */
  finalEquity: {
    mean: number;
    median: number;
    p5: number;
    p25: number;
    p75: number;
    p95: number;
    min: number;
    max: number;
  };
  /** Return total : mêmes percentiles. */
  returnPct: {
    mean: number;
    median: number;
    p5: number;
    p25: number;
    p75: number;
    p95: number;
  };
  /** Drawdown distribution. */
  maxDrawdownPct: {
    mean: number;
    median: number;
    p95: number; // worst case 5%
    max: number;
  };
  /** P(equity finale > target). Null si pas de target défini. */
  probAboveTarget: number | null;
  /** P(perte > 5% / 10% / 15%). */
  probLossAbove: { lossPct5: number; lossPct10: number; lossPct15: number };
  /** Value at Risk 95% (perte en USD que 5% des chemins dépassent). */
  var95Usd: number;
  /** Conditional Value at Risk 95% (perte moyenne dans les 5% pires). */
  cvar95Usd: number;
}

export interface MonteCarloResult {
  config: MonteCarloConfig;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  statistics: MonteCarloStatistics;
  /** Trajectoires en quantiles (P5/P25/P50/P75/P95) pour fan chart. */
  fanChart: Array<{
    dayIndex: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  }>;
  /** Distribution des equities finales (histogramme bucketé). */
  histogram: Array<{
    binStart: number;
    binEnd: number;
    count: number;
    pct: number;
  }>;
  warnings: string[];
}
