'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SessionProfile =
  | 'long_term_investor'
  | 'active_trading'
  | 'sniper_mode'
  | 'hyper_active';

export interface LisaRiskConstraints {
  targetDeploymentPct?: number;
  maxPositionSizePct?: number;
  maxExposurePerAssetClassPct?: number;
  maxOpenPositions?: number;
  maxDrawdown2DaysPct?: number;
  maxDrawdown7DaysPct?: number;
  maxDrawdown30DaysPct?: number;
  maxLeverage?: number;
  /** Stop-loss par défaut quand Lisa ne spécifie pas dans la thèse (en %). */
  defaultStopLossPct?: number;
  maxPortfolioVolatilityPct?: number;
  autoLiquidateOnKill?: boolean;
}

export interface LisaSessionConfigRow {
  id: string;
  user_id: string;
  portfolio_id: string;
  profile: SessionProfile;
  capital_usd: string;
  base_currency: string;
  risk_constraints: LisaRiskConstraints;
  anti_consensus_strength: number;
  max_theses: number;
  enable_crypto: boolean;
  enable_derivatives: boolean;
  enable_leverage: boolean;
  autopilot_enabled: boolean;
  autopilot_cycle_minutes: number | null;
  autopilot_auto_approve?: boolean;
  autopilot_expires_at?: string | null;
  autopilot_aggressive?: boolean;
  autopilot_market_hours_only?: boolean;
  // Lisa v2 — objectifs & budget (tous optionnels)
  return_target_daily_pct?: number | null;
  return_target_monthly_pct?: number | null;
  return_target_annual_pct?: number | null;
  daily_cost_budget_usd?: number | null;
  performance_horizon_days?: number;
  kill_switch_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LisaProposalRow {
  id: string;
  portfolio_id: string;
  capital_usd: string;
  base_currency: string;
  detected_regime: string;
  market_momentum?: 'bullish_strong' | 'neutral' | 'bearish';
  regime_summary: string;
  favored_pockets: Array<{ assetClass: string; rationale: string }>;
  avoided_pockets: Array<{ assetClass: string; rationale: string }>;
  theses: Array<Record<string, unknown>>;
  allocations: Array<{ thesisId: string; pctCapital: number; amountUsd: string }>;
  cash_reserve_pct: number;
  warnings: string[];
  status: 'draft' | 'proposed' | 'approved' | 'rejected' | 'executed' | 'expired';
  claude_cost_usd: number | null;
  generated_at: string;
  expires_at: string | null;
  executed_at: string | null;
}

export interface LisaPosition {
  id: string;
  portfolioId: string;
  thesisId: string;
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short' | 'long_call' | 'long_put' | 'short_call' | 'short_put' | 'pair_spread';
  venue: string;
  quantity: string;
  entryPrice: string;
  entryTimestamp: string;
  entryNotionalUsd: string;
  status: 'open' | 'closed_target' | 'closed_stop' | 'closed_invalidated' | 'closed_user' | 'closed_kill' | 'closed_expired';
  exitPrice: string | null;
  exitTimestamp: string | null;
  exitReason: string | null;
  realizedPnlUsd: string | null;
  realizedPnlPct: number | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  horizonTargetDate: string | null;
  estimatedEntryCostUsd: string;
  createdAt: string;
  updatedAt: string;
}

export interface LisaSnapshot {
  id: string;
  portfolio_id: string;
  timestamp: string;
  cash_usd: string;
  open_positions_value_usd: string;
  total_value_usd: string;
  realized_pnl_cumulative_usd: string;
  unrealized_pnl_usd: string;
  return_from_inception_pct: number;
  open_positions_count: number;
  drawdown_from_peak_pct: number;
}

export interface MechanicalCycleSummary {
  cycle_at: string;
  directive_age_minutes: number | null;
  opens_count: number;
  closes_stop_count: number;
  closes_target_count: number;
  closes_invalidated_count: number;
  net_pnl_since_proposal_usd: number;
  win_rate_pct: number | null;
  avg_hold_minutes: number | null;
  largest_win_pct: number | null;
  largest_loss_pct: number | null;
  stops_cluster_flag: boolean;
  exposure_pct: number | null;
  cash_usd: number | null;
  open_positions_count: number;
  drawdown_since_directive_pct: number | null;
  vix_level: number | null;
  dxy_level: number | null;
}

export interface MechanicalDirective {
  generated_at: string;
  valid_until: string | null;
  market_momentum: string;
  trajectory_status: string;
  risk_posture: string;
  target_symbols: Array<{ symbol: string; assetClass?: string; direction?: string; convictionScore?: number; horizonDays?: number; stopLossPct?: number; takeProfitPct?: number; venue?: string }>;
  favored_asset_classes: string[];
  avoided_asset_classes: string[];
  tactical_overrides: Record<string, unknown>;
}

export interface AgentAction {
  timestamp: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface AgentWakeUp {
  timestamp: string;
  summary: string;
  payload: {
    trigger_type: string;
    tier?: 'tier_1' | 'tier_2';
    trigger_value?: number;
    threshold?: number;
    symbol?: string | null;
    wake_count_today?: number;
    daily_budget?: number;
    extra?: Record<string, unknown> | null;
  };
}

export interface LisaAgentStatus {
  directive: MechanicalDirective | null;
  cycles: MechanicalCycleSummary[];
  recentActions: AgentAction[];
  agentWakeUps?: {
    today: AgentWakeUp[];
    countToday: number;
    dailyBudget: number;
  };
}

export interface LisaDecisionLogRow {
  id: string;
  portfolio_id: string;
  kind: string;
  summary: string;
  rationale: string;
  payload: Record<string, unknown>;
  hash_chain_current: string;
  triggered_by: string;
  timestamp: string;
}

export interface LisaRiskCheckResult {
  portfolioId: string;
  timestamp: string;
  status: 'ok' | 'warning' | 'critical' | 'hard_kill';
  violations: Array<{
    code: string;
    severity: 'warning' | 'critical' | 'hard_kill';
    message: string;
    currentValue: number | string;
    threshold: number | string;
  }>;
  actionsApplied: Array<{ kind: string; details: string }>;
  snapshot: LisaSnapshot;
}

// Pas de retry sur 404 — l'API Lisa n'est pas encore déployée sur Railway.
const LISA_QUERY_OPTIONS = {
  retry: false,
  refetchOnWindowFocus: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Session config
// ─────────────────────────────────────────────────────────────────────────────

export function useLisaConfig(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'config', portfolioId],
    queryFn: () => apiFetch<LisaSessionConfigRow | null>(`/lisa/config/${portfolioId}`),
    enabled: !!portfolioId,
    ...LISA_QUERY_OPTIONS,
  });
}

export function useUpsertLisaConfig(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<LisaSessionConfigRow>) =>
      apiFetch<LisaSessionConfigRow>(`/lisa/config/${portfolioId}`, {
        method: 'POST',
        body: JSON.stringify(config),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'config', portfolioId] });
    },
  });
}

/**
 * S'abonne aux changements Supabase Realtime sur lisa_session_configs pour
 * ce portfolioId. Quand un autre device modifie la config (ou le backend
 * l'écrit), le cache React Query local est invalidé → l'UI rafraîchit
 * automatiquement sans refresh manuel.
 *
 * Pré-requis : la migration 0056 doit avoir activé Realtime sur la table.
 */
export function useLisaConfigRealtime(portfolioId: string | null): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!portfolioId) return;
    const client = createSupabaseBrowserClient();
    const channel = client
      .channel(`lisa_config_${portfolioId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lisa_session_configs',
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        () => {
          void qc.invalidateQueries({ queryKey: ['lisa', 'config', portfolioId] });
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [portfolioId, qc]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposals
// ─────────────────────────────────────────────────────────────────────────────

export function useLisaProposals(portfolioId: string | null, limit = 20) {
  return useQuery({
    queryKey: ['lisa', 'proposals', portfolioId, limit],
    queryFn: () => apiFetch<LisaProposalRow[]>(`/lisa/proposals/${portfolioId}?limit=${limit}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000, // nouvelles propositions Lisa : check toutes les 30s
    ...LISA_QUERY_OPTIONS,
  });
}

export function useGenerateProposal(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userFocus?: string) =>
      apiFetch<LisaProposalRow>(`/lisa/proposals/${portfolioId}/generate`, {
        method: 'POST',
        body: JSON.stringify({ userFocus }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'proposals', portfolioId] });
    },
  });
}

export function useApproveProposal(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      apiFetch<{ openedPositions: LisaPosition[] }>(
        `/lisa/proposals/${proposalId}/approve`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'proposals', portfolioId] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'positions', portfolioId] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'snapshot', portfolioId] });
    },
  });
}

export function useRejectProposal(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, reason }: { proposalId: string; reason: string }) =>
      apiFetch<void>(`/lisa/proposals/${proposalId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'proposals', portfolioId] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent mécanique
// ─────────────────────────────────────────────────────────────────────────────

export function useAgentStatus(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'agent', portfolioId],
    queryFn: () => apiFetch<LisaAgentStatus>(`/lisa/agent/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000, // rafraîchit toutes les 30s (cycle agent = 1 min)
    ...LISA_QUERY_OPTIONS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Positions + snapshots
// ─────────────────────────────────────────────────────────────────────────────

export function useLisaPositions(portfolioId: string | null, openOnly = false) {
  return useQuery({
    queryKey: ['lisa', 'positions', portfolioId, openOnly],
    queryFn: () => apiFetch<LisaPosition[]>(`/lisa/positions/${portfolioId}?openOnly=${openOnly}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
    ...LISA_QUERY_OPTIONS,
  });
}

export interface LisaOptionPosition {
  id: string;
  underlying: string;
  asset_class: string;
  kind: 'call' | 'put';
  strike: number;
  expiry: string;
  contracts: number;
  premium_paid_usd: number;
  entry_underlying_price: number;
  entry_iv: number;
  conviction_score: number | null;
  current_underlying: number;
  current_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  delta: number;
}

export function useLisaOptions(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'options', portfolioId],
    queryFn: () => apiFetch<LisaOptionPosition[]>(`/lisa/options/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
    ...LISA_QUERY_OPTIONS,
  });
}

export function useLisaSnapshot(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'snapshot', portfolioId],
    queryFn: () => apiFetch<LisaSnapshot>(`/lisa/snapshot/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 60_000,
    ...LISA_QUERY_OPTIONS,
  });
}

export function useLisaSnapshotHistory(portfolioId: string | null, windowDays = 30) {
  return useQuery({
    queryKey: ['lisa', 'snapshots', portfolioId, windowDays],
    queryFn: () => apiFetch<LisaSnapshot[]>(`/lisa/snapshots/${portfolioId}?window=${windowDays}`),
    enabled: !!portfolioId,
    refetchInterval: 60_000, // chart capital : rafraîchi toutes les 60s
    ...LISA_QUERY_OPTIONS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision log + risk + kill switch
// ─────────────────────────────────────────────────────────────────────────────

export function useLisaDecisionLog(portfolioId: string | null, limit = 50) {
  return useQuery({
    queryKey: ['lisa', 'decisions', portfolioId, limit],
    queryFn: () => apiFetch<LisaDecisionLogRow[]>(`/lisa/decisions/${portfolioId}?limit=${limit}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
    ...LISA_QUERY_OPTIONS,
  });
}

export function useRunRiskCheck(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<LisaRiskCheckResult>(`/lisa/risk-check/${portfolioId}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'snapshot', portfolioId] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'positions', portfolioId] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'decisions', portfolioId] });
    },
  });
}

export function useAuditChainVerify(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'audit', 'verify', portfolioId],
    queryFn: () =>
      apiFetch<{ totalEntries: number; isValid: boolean; firstCorruptedIndex: number | null }>(
        `/lisa/audit/verify/${portfolioId}`,
      ),
    enabled: !!portfolioId,
    staleTime: 60_000,
    ...LISA_QUERY_OPTIONS,
  });
}

export function useTriggerKillSwitch(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      apiFetch<{ closedPositions: number }>(`/lisa/kill-switch/${portfolioId}`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa'] });
    },
  });
}

export function useResetSimulation(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; portfolioId: string }>(
        `/lisa/portfolio/${portfolioId}/reset-simulation`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa'] });
    },
  });
}

export function usePurgeOldProposals(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (olderThanHours: number = 24) =>
      apiFetch<{ deleted: number }>(
        `/lisa/portfolio/${portfolioId}/proposals/purge`,
        {
          method: 'POST',
          body: JSON.stringify({ olderThanHours }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lisa', 'proposals', portfolioId] });
      void qc.invalidateQueries({ queryKey: ['lisa', 'decisions', portfolioId] });
    },
  });
}
