/**
 * Bot Profitability Lab — types du module R&D.
 *
 * Indépendant des types Lisa. Pas d'import depuis modules/lisa pour
 * éviter le couplage. Le seul lien : Phase 4 (TransferLayer) lit les
 * patterns ici et les expose à Lisa via lisa_pattern_adoptions.
 */

// ═══════════════════════════════════════════════════════════════════
// BOT DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

export type BotSourceType = 'csv_import' | 'api_external' | 'lisa_replay' | 'manual';

export interface BotDefinition {
  id: string;
  userId: string;
  portfolioId: string | null;
  name: string;
  description: string | null;
  sourceType: BotSourceType;
  sourceMetadata: Record<string, unknown> | null;
  capitalBaseUsd: string;
  startDate: string | null;          // ISO date YYYY-MM-DD
  endDate: string | null;
  isActive: boolean;
  tags: string[];
  totalTrades: number;
  totalRealizedPnlUsd: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotDefinitionDraft {
  name: string;
  description?: string;
  sourceType: BotSourceType;
  sourceMetadata?: Record<string, unknown>;
  capitalBaseUsd: number;
  startDate?: string;
  endDate?: string;
  tags?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// BOT PAPER TRADES
// ═══════════════════════════════════════════════════════════════════

export type TradeDirection = 'long' | 'short' | 'long_call' | 'long_put';

export interface BotPaperTrade {
  id: string;
  botId: string;
  externalId: string | null;
  symbol: string;
  assetClass: string;
  direction: TradeDirection;
  entryTimestamp: string;
  entryPrice: string;
  quantity: string;
  entryNotionalUsd: string;
  exitTimestamp: string | null;
  exitPrice: string | null;
  exitReason: string | null;
  entryCostUsd: string;
  exitCostUsd: string;
  grossPnlUsd: string | null;
  netPnlUsd: string | null;
  netPnlPct: number | null;
  marketRegime: string | null;
  vixAtEntry: string | null;
  dxyAtEntry: string | null;
  rawPayload: Record<string, unknown> | null;
  importedAt: string;
}

/**
 * Format de trade brut accepté par les connectors.
 * Tous les champs sont optionnels sauf symbol + entry_price + entry_timestamp +
 * direction. Le JournalNormalizer remplit les manquants si possible.
 */
export interface RawTradeImport {
  external_id?: string;
  symbol: string;
  asset_class?: string;
  direction: TradeDirection | string;
  entry_timestamp: string;
  entry_price: number | string;
  quantity?: number | string;
  entry_notional_usd?: number | string;
  exit_timestamp?: string;
  exit_price?: number | string;
  exit_reason?: string;
  // Costs/PnL si déjà calculés par la source
  entry_cost_usd?: number | string;
  exit_cost_usd?: number | string;
  net_pnl_usd?: number | string;
  // Tout autre champ → raw_payload
  [k: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// METRICS (Phase 2)
// ═══════════════════════════════════════════════════════════════════

export interface BotMetricsDaily {
  id: string;
  botId: string;
  date: string;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  realizedPnlUsd: string;
  cumulativePnlUsd: string;
  equityValueUsd: string | null;
  dailyReturnPct: number | null;
  drawdownFromPeakPct: number | null;
  isNewPeak: boolean;
  totalCostsUsd: string;
  computedAt: string;
}

export type SessionKind = 'market_regime' | 'vix_bucket' | 'asset_class' | 'symbol' | 'time_of_day' | 'global';

export interface BotMetricsSession {
  id: string;
  botId: string;
  sessionKind: SessionKind;
  sessionValue: string;
  tradesCount: number;
  winningTrades: number;
  winRatePct: number | null;
  avgWinUsd: string | null;
  avgLossUsd: string | null;
  netPnlUsd: string | null;
  expectancyPerTradeUsd: string | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  computedAt: string;
}

/** Métriques composite calculées sur tout l'historique d'un bot. */
export interface BotPerformanceSummary {
  botId: string;
  totalTrades: number;
  totalDays: number;
  netPnlUsd: number;
  netReturnPct: number;
  cagr: number | null;                // annualized
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  maxDrawdownPct: number;
  recoveryDays: number | null;
  profitFactor: number | null;
  expectancyPerTradeUsd: number;
  winRatePct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  consecutiveWinsMax: number;
  consecutiveLossesMax: number;
}

// ═══════════════════════════════════════════════════════════════════
// PATTERNS (Phase 3)
// ═══════════════════════════════════════════════════════════════════

export type PatternKind = 'entry_setup' | 'exit_rule' | 'risk_management' | 'regime_filter' | 'time_filter';

export type PatternStatus = 'candidate' | 'validated' | 'rejected' | 'deprecated';

export interface BotPattern {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  patternKind: PatternKind;
  sourceBotIds: string[];
  conditions: Record<string, unknown>;        // DSL JSON
  actionSignal: Record<string, unknown> | null;
  observationCount: number;
  winRatePct: number | null;
  expectancyUsd: string | null;
  robustnessScore: number | null;
  compositeScore: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  status: PatternStatus;
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════════
// LISA PATTERN ADOPTIONS (Phase 4)
// ═══════════════════════════════════════════════════════════════════

export type AdoptionLevel = 'observe' | 'suggest' | 'enforce';

export interface LisaPatternAdoption {
  id: string;
  userId: string;
  portfolioId: string;
  patternId: string;
  adoptionLevel: AdoptionLevel;
  adoptedAt: string;
  adoptedByUser: boolean;
  adoptionNotes: string | null;
  triggeredCount: number;
  triggeredWinningCount: number;
  triggeredTotalPnlUsd: string;
  lastTriggeredAt: string | null;
  isActive: boolean;
  deactivatedAt: string | null;
  deactivationReason: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

export const BOT_LAB_CONSTANTS = {
  /** Coûts par défaut alignés avec paper-broker.service.ts pour cohérence simulations. */
  DEFAULT_ENTRY_COST_BPS: 10,
  DEFAULT_EXIT_COST_BPS: 10,

  /** Min trades requis pour qu'un bot soit considéré comme évaluable. */
  MIN_TRADES_FOR_EVALUATION: 30,

  /** Min observations pour qu'un pattern passe en status validated. */
  MIN_OBSERVATIONS_FOR_VALIDATION: 20,

  /** Buckets VIX pour la classification (cohérent avec lisa-performance-analytics). */
  VIX_BUCKETS: [
    { label: 'vix_low', max: 15 },
    { label: 'vix_normal', max: 22 },
    { label: 'vix_high', max: 30 },
    { label: 'vix_extreme', max: Infinity },
  ],

  /** Lookback pour Sharpe (jours). 252 = standard 1 an trading. */
  SHARPE_LOOKBACK_DAYS: 252,

  /** Risk-free rate annualisé pour Sharpe. 4% = approximation Treasury 10y 2026. */
  RISK_FREE_RATE_PCT: 4.0,
} as const;
