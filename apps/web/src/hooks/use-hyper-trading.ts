'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — keep in sync with apps/api modules/hyper-trading
// ---------------------------------------------------------------------------
export type OperatingTempo = 'LONG_HORIZON' | 'ACTIVE' | 'HYPER_ACTIVE';
export type RiskIntensityLevel = 'low' | 'moderate' | 'high' | 'very_high';
export type DelegationMode = 'MANUAL_EXPLICIT' | 'HYBRID_SUGGESTIVE' | 'AUTONOMOUS_GUARDED';
export type ProfileStatus = 'draft' | 'active' | 'paused' | 'killed' | 'archived';

export interface StrategyModeOption {
  tempo: OperatingTempo;
  reviewIntervalMinutes: number;
  riskLevel: RiskIntensityLevel;
}

export interface HyperTradingProfileRow {
  id: string;
  user_id: string;
  portfolio_id: string | null;
  mandate_id: string | null;
  status: ProfileStatus;
  tempo: OperatingTempo;
  risk_level: RiskIntensityLevel;
  delegation_mode: DelegationMode;
  window_timezone: string;
  activated_at: string | null;
  paused_at: string | null;
  killed_at: string | null;
  archived_at: string | null;
  expires_at: string;
  kill_switch_active: boolean;
  total_sessions_opened: number;
  total_suggestions_emitted: number;
  total_intents_approved: number;
  parameters: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HyperTradingGuardrailRow {
  profile_id: string;
  user_id: string;
  max_trades_per_day: number;
  cooldown_minutes_between_trades: number;
  review_every_n_minutes: number;
  max_notional_per_trade_pct: string;
  max_daily_notional_pct: string;
  max_exposure_per_instrument_pct: string;
  max_exposure_per_asset_class_pct: string;
  max_exposure_per_sector_pct: string;
  max_notional_per_trade_abs: string | null;
  max_daily_notional_abs: string | null;
  notional_currency: string;
  max_open_positions: number;
  max_daily_loss_pct: string;
  max_intraday_drawdown_pct: string;
  mandatory_stop_loss_pct: string;
  optional_take_profit_pct: string | null;
  maximum_allowed_spread_bps: string;
  maximum_allowed_slippage_bps: string;
  minimum_expected_liquidity_abs: string;
  max_acceptable_volatility_pct: string;
  allowed_asset_classes: string[];
  denied_tickers: string[];
  required_human_approval_above_abs: string | null;
  kill_switch_on_abnormal_loss: boolean;
  kill_switch_on_data_provider_failure: boolean;
  kill_switch_on_broker_sync_mismatch: boolean;
  kill_switch_on_volatility_shock: boolean;
}

export interface HyperTradingAuditRow {
  id: string;
  profile_id: string;
  session_id: string | null;
  user_id: string;
  kind: string;
  reason: string;
  payload: Record<string, unknown> | null;
  hash: string;
  prev_hash: string | null;
  occurred_at: string;
}

export interface ConfigurePayload {
  tempo?: OperatingTempo;
  riskLevel?: RiskIntensityLevel;
  delegationMode?: DelegationMode;
  windowTimezone?: string;
  expiresAt: string;
  portfolioId?: string | null;
  mandateId?: string | null;
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------
export function useStrategyModes() {
  return useQuery({
    queryKey: ['strategy-modes'],
    queryFn: () => apiFetch<StrategyModeOption[]>('/strategy-modes'),
    staleTime: 5 * 60_000,
  });
}

export function useCurrentStrategyMode() {
  return useQuery({
    queryKey: ['strategy-modes', 'current'],
    queryFn: () => apiFetch<{ tempo: OperatingTempo; profile: HyperTradingProfileRow | null }>('/strategy-modes/current'),
    staleTime: 30_000,
  });
}

export function useHyperTradingConfig() {
  return useQuery({
    queryKey: ['hyper-trading', 'config'],
    queryFn: () =>
      apiFetch<{ profile: HyperTradingProfileRow | null; guardrail: HyperTradingGuardrailRow | null }>(
        '/hyper-trading/config',
      ),
    staleTime: 15_000,
  });
}

export function useHyperTradingAudit(profileId: string | null) {
  return useQuery({
    queryKey: ['hyper-trading', 'audit', profileId],
    queryFn: () => apiFetch<HyperTradingAuditRow[]>(`/hyper-trading/${profileId}/audit?limit=50`),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export function useConfigureHyperTrading() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ConfigurePayload) =>
      apiFetch<HyperTradingProfileRow>('/hyper-trading/configure', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hyper-trading'] });
      qc.invalidateQueries({ queryKey: ['strategy-modes'] });
    },
  });
}

export function useUpdateGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, payload }: { profileId: string; payload: Partial<HyperTradingGuardrailRow> }) =>
      apiFetch<HyperTradingGuardrailRow>(`/hyper-trading/guardrails/${profileId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hyper-trading'] });
    },
  });
}

export function useActivateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      apiFetch<HyperTradingProfileRow>(`/hyper-trading/${profileId}/activate`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hyper-trading'] });
      qc.invalidateQueries({ queryKey: ['strategy-modes'] });
    },
  });
}

export function usePauseProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, reason }: { profileId: string; reason?: string }) =>
      apiFetch<HyperTradingProfileRow>(`/hyper-trading/${profileId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hyper-trading'] }),
  });
}

export function useResumeProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, reason }: { profileId: string; reason?: string }) =>
      apiFetch<HyperTradingProfileRow>(`/hyper-trading/${profileId}/resume`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hyper-trading'] }),
  });
}

export function useKillProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, reason }: { profileId: string; reason: string }) =>
      apiFetch<HyperTradingProfileRow>(`/hyper-trading/${profileId}/kill`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hyper-trading'] }),
  });
}
