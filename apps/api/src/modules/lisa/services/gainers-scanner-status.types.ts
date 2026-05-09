/**
 * Observability — état diagnostique du scanner Gainers exposé via
 * GET /admin/gainers/scanner-status. Strictement read-only : aucun de ces
 * types n'influence le scoring, les seuils, ni la logique de trade.
 */

export type EarlyReturnReason =
  | 'scanner_paused'
  | 'configs_fetch_error'
  | 'no_active_portfolio'
  | 'no_candidates_fetched'
  | 'candidates_fetched_but_none_selected'
  | 'persist_log_failed'
  | 'upstream_provider_error'
  | 'macro_veto';  // PR Action 3 — LLM macro veto (regime risk-off)

export const EARLY_RETURN_REASONS: readonly EarlyReturnReason[] = [
  'scanner_paused',
  'configs_fetch_error',
  'no_active_portfolio',
  'no_candidates_fetched',
  'candidates_fetched_but_none_selected',
  'persist_log_failed',
  'upstream_provider_error',
  'macro_veto',
] as const;

export interface PerExchangeResult {
  count: number;
  lastError?: string;
  at: string;
}

export interface ConfigSnapshot {
  portfolio_id: string;
  gainers_cycle_minutes: number | null;
  gainers_min_persistence_score: number | null;
  gainers_min_path_efficiency: number | null;
  gainers_default_tp_pct: number | null;
  gainers_default_sl_pct: number | null;
}

export interface GainersScannerStatus {
  /** Dernier tick (succès ou skip — distingué via lastEarlyReturn). */
  lastTickAt: string | null;
  /** Début d'un cycle (avant tout early return). */
  lastCycleStartedAt: string | null;
  /** Fin d'un cycle SANS early return (pipeline complet). */
  lastCycleCompletedAt: string | null;
  /** Si != null, le dernier cycle s'est arrêté tôt avec cette raison. */
  lastEarlyReturn: { reason: EarlyReturnReason; at: string; details?: string } | null;

  /** État des kill-switches env qui peuvent figer le scanner sans deploy. */
  secrets: {
    scannerPause: boolean;
    multiTfPause: boolean;
    eodhdApiKeySet: boolean;
  };

  lastFetchAllCandidates: { count: number; fromCache: boolean; at: string } | null;
  lastTopGainersSelected: { count: number; at: string } | null;
  perExchangeLastResult: Record<string, PerExchangeResult>;
  lastPersistLogAttempt: { count: number; at: string; error?: string } | null;

  activeGainersPortfoliosCount: number;
  activeGainersPortfolioIds: string[];
  currentConfigSnapshot: ConfigSnapshot[];

  cyclesLast24h: number;
  earlyReturnsLast24hByReason: Record<EarlyReturnReason, number>;
  /** Timestamp du dernier cycle qui a atteint la fin sans early return. */
  lastSuccessfulCompleteAt: string | null;
}
