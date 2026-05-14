/**
 * Simulation Types — Paper trading virtuel (aucun ordre réel)
 *
 * Une position est liée à une thèse Lisa. Son P&L se calcule en fonction
 * des prix live (EODHD) et le comparatif vs prix d'entrée.
 */

import { z } from 'zod';

export const PaperPositionStatus = z.enum([
  'open',            // position active, P&L non-réalisé mis à jour
  'closed_target',   // target atteint, P&L matérialisé
  'closed_stop',     // stop-loss atteint, P&L matérialisé
  'closed_invalidated', // thèse invalidée (condition quantifiée déclenchée)
  'closed_user',     // fermeture manuelle user
  'closed_kill',     // kill-switch global ou drawdown limit breached
  'closed_expired',  // horizon dépassé sans mouvement
]);
export type PaperPositionStatus = z.infer<typeof PaperPositionStatus>;

export const PaperPosition = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  // PR #250 — nullable (migration 0120) pour support scanner Gainers
  // déterministe qui ouvre des positions sans proposal LLM.
  proposalId: z.string().uuid().nullable(),
  thesisId: z.string().uuid().nullable(),

  /** Expression concrète choisie (symbol, direction, venue) */
  symbol: z.string(),
  assetClass: z.string(),
  direction: z.enum(['long', 'short', 'long_call', 'long_put', 'short_call', 'short_put', 'pair_spread']),
  venue: z.string(),

  /** Quantité (shares, contracts, tokens) */
  quantity: z.string(),  // decimal
  /** Prix d'entrée */
  entryPrice: z.string(),  // decimal
  entryTimestamp: z.string().datetime(),
  /** Montant investi en devise de base (€ ou $) */
  entryNotionalUsd: z.string(),

  /** Status actuel */
  status: PaperPositionStatus,

  /** Si closed : détails */
  exitPrice: z.string().nullable(),
  exitTimestamp: z.string().datetime().nullable(),
  exitReason: z.string().nullable(),
  realizedPnlUsd: z.string().nullable(),
  realizedPnlPct: z.number().nullable(),

  /** Niveaux Lisa-defined */
  stopLossPrice: z.string().nullable(),
  takeProfitPrice: z.string().nullable(),
  horizonTargetDate: z.string().datetime().nullable(),

  /** Coûts d'exécution simulés (frais, slippage estimé, fx markup) */
  estimatedEntryCostUsd: z.string(),

  /** Métadata */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PaperPosition = z.infer<typeof PaperPosition>;

/**
 * Snapshot du portefeuille à un instant T.
 * Utilisé pour les charts 1d/1w/1m/1y.
 */
export const PortfolioSnapshot = z.object({
  id: z.string().uuid(),
  portfolioId: z.string().uuid(),
  timestamp: z.string().datetime(),

  /** Cash disponible (non investi) en devise base */
  cashUsd: z.string(),
  /** Valeur marchée des positions ouvertes */
  openPositionsValueUsd: z.string(),
  /** Valeur totale (cash + positions) */
  totalValueUsd: z.string(),

  /** P&L cumulé réalisé depuis inception */
  realizedPnlCumulativeUsd: z.string(),
  /** P&L non-réalisé instantané (open positions) */
  unrealizedPnlUsd: z.string(),
  /** Return % depuis capital initial */
  returnFromInceptionPct: z.number(),

  /** Nombre de positions ouvertes */
  openPositionsCount: z.number().int().min(0),

  /** Drawdown instantané depuis le peak de la période */
  drawdownFromPeakPct: z.number(),

  /** Méta-contexte au moment du snapshot */
  marketContextSummary: z.string().nullable(),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshot>;

/**
 * Commande : ouvrir une position à partir d'une thèse approuvée.
 */
export const OpenPositionCommand = z.object({
  portfolioId: z.string().uuid(),
  proposalId: z.string().uuid(),
  thesisId: z.string().uuid(),
  expressionIndex: z.number().int().min(0),
  capitalAllocationUsd: z.string(),
  /** Prix live au moment de l'exécution */
  livePrice: z.string(),
  /** Niveaux Lisa */
  stopLossPrice: z.string().nullable(),
  takeProfitPrice: z.string().nullable(),
  horizonDays: z.number().int().positive(),
});
export type OpenPositionCommand = z.infer<typeof OpenPositionCommand>;

/**
 * PR #250 — Commande directe : ouvrir une position SANS dépendre de
 * lisa_proposals (pipeline LLM). Utilisée par le scanner Gainers déterministe.
 * Toutes les données nécessaires arrivent inline, pas de SELECT proposal.
 *
 * Les NULLs proposalId/thesisId sont permis depuis migration 0120.
 */
export const OpenPositionDirectCommand = z.object({
  portfolioId: z.string().uuid(),
  symbol: z.string(),
  assetClass: z.string(),
  direction: z.enum(['long', 'short', 'long_call', 'long_put']),
  venue: z.string(),
  capitalAllocationUsd: z.string(),
  /** Prix live au moment de l'exécution */
  livePrice: z.string(),
  /** Niveaux stops/TPs */
  stopLossPrice: z.string().nullable(),
  takeProfitPrice: z.string().nullable(),
  horizonDays: z.number().int().positive(),
  /** Source identifiable pour audit (ex: "scanner_top_gainers") */
  source: z.string().optional(),
  /**
   * Bug #314 #M3 — Si fourni, l'INSERT passe par la fonction atomique
   * `try_open_position` (check cap + insert sous verrou advisory scopé
   * portfolio) au lieu d'un INSERT direct. Protège contre la race
   * scanner/autopilot qui pouvait dépasser le cap de positions ouvertes.
   * Absent → INSERT direct, comportement legacy inchangé.
   */
  maxOpenPositions: z.number().int().positive().optional(),
});
export type OpenPositionDirectCommand = z.infer<typeof OpenPositionDirectCommand>;

export const ClosePositionCommand = z.object({
  positionId: z.string().uuid(),
  reason: PaperPositionStatus,
  livePrice: z.string(),
  /** Narrative pour le decision log */
  rationale: z.string(),
});
export type ClosePositionCommand = z.infer<typeof ClosePositionCommand>;
