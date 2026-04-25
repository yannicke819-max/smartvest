/**
 * Types publics du backtest harness.
 *
 * Le backtest est un outil de validation a posteriori : il rejoue des données
 * historiques (OHLCV EODHD) à travers un mock déterministe de la logique
 * Lisa, et calcule les métriques classiques (Sharpe, drawdown, win rate).
 *
 * Il NE remplace PAS la sim live. Il sert à comparer des configs entre elles
 * et à détecter les régimes catastrophiques avant de les vivre en réel.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration d'un run de backtest
// ─────────────────────────────────────────────────────────────────────────────

export const BacktestConfigSchema = z.object({
  /** Date de début (ISO YYYY-MM-DD), incluse. */
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Date de fin (ISO YYYY-MM-DD), incluse. */
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Capital initial en USD. */
  initialCapitalUsd: z.number().positive().default(10_000),
  /** Univers de tickers tradables. Si vide, défaut = panier ETF/crypto liquides. */
  universe: z.array(z.string()).default([]),
  /** Filtre anti-consensus (0 suit consensus, 10 maximum contrarian). */
  antiConsensusStrength: z.number().int().min(0).max(10).default(5),
  /** Profil de horizon. */
  profile: z.enum(['long_term_investor', 'active_trading', 'sniper_mode']).default('sniper_mode'),
  /** Cap par position (% du capital). */
  maxPositionSizePct: z.number().min(1).max(50).default(8),
  /** Cap par classe d'actif (% du capital). */
  maxAssetClassExposurePct: z.number().min(1).max(100).default(20),
  /** Nombre maximum de positions ouvertes simultanément. */
  maxOpenPositions: z.number().int().min(1).max(50).default(12),
  /** Slippage simulé (en bps, en plus des fees). */
  slippageBps: z.number().min(0).max(100).default(10),
  /** Fees broker simulé (en bps par trade). */
  feeBps: z.number().min(0).max(100).default(10),
  /** Stop-loss par position (% sous l'entrée pour long, au-dessus pour short). */
  stopLossPct: z.number().min(0.1).max(20).default(2),
  /** Take-profit par position (% au-dessus pour long). */
  takeProfitPct: z.number().min(0.1).max(50).default(4),
  /** Horizon max en jours (au-delà, fermeture forcée). */
  maxHorizonDays: z.number().int().min(1).max(60).default(5),
  /** Activer les options : Lisa peut proposer long calls / puts. */
  enableOptions: z.boolean().default(false),
  /** Volatilité implicite par défaut (utilisée à défaut de surface réelle). */
  defaultIv: z.number().min(0.05).max(2).default(0.30),
  /** Days-to-expiry pour les options proposées (DTE). */
  optionsDte: z.number().int().min(1).max(120).default(14),
  /** Strike OTM percentage : 0 = ATM, 5 = +5% OTM (call) / -5% (put). */
  strikeOtmPct: z.number().min(0).max(50).default(2),
});

export type BacktestConfig = z.infer<typeof BacktestConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Données historiques
// ─────────────────────────────────────────────────────────────────────────────

/** Bougie OHLCV journalière. */
export interface Candle {
  date: string;     // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Série historique pour un ticker. */
export interface TickerHistory {
  symbol: string;
  assetClass: string;
  candles: Candle[];
}

// ─────────────────────────────────────────────────────────────────────────────
// État interne du backtest (positions, trades)
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestPosition {
  id: string;
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  notionalUsd: number;
  convictionScore: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  horizonDate: string;
}

export interface BacktestTrade {
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notionalUsd: number;
  /** P&L net après fees + slippage. */
  pnlUsd: number;
  pnlPct: number;
  /** Raison de fermeture. */
  exitReason: 'stop_loss' | 'take_profit' | 'horizon_expired' | 'cap_violation' | 'forced_eob' | 'option_expired' | 'option_target_hit';
  convictionScore: number;
  /** Si la position était une option. */
  optionInfo?: {
    kind: 'call' | 'put';
    strike: number;
    expiry: string;
    contracts: number;
    premiumPaid: number;
  };
}

export interface EquityPoint {
  date: string;
  equityUsd: number;
  cashUsd: number;
  positionsUsd: number;
  openPositions: number;
  drawdownPct: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Résultat d'un run
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  /** Sharpe ratio annualisé (rf=0). */
  sharpeRatio: number;
  /** Max drawdown peak-to-trough en %. */
  maxDrawdownPct: number;
  /** Win rate sur trades fermés. */
  winRatePct: number;
  /** Profit factor : gross_wins / gross_losses (>1 = profitable). */
  profitFactor: number;
  /** Calmar ratio : annualized_return / max_drawdown. */
  calmarRatio: number;
  /** Avg P&L net par trade en USD. */
  avgPnlPerTradeUsd: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Coûts cumulés (fees + slippage) en USD. */
  totalCostsUsd: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  /** Diagnostics utiles : ticker introuvable, jours sans data, etc. */
  warnings: string[];
}
