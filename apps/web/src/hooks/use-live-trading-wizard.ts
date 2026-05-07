'use client';

/**
 * PR Wizard.3 — Hooks React Query pour le LIVE Trading Wizard.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface WizardState {
  id: string;
  user_id: string;
  portfolio_id: string;
  current_step: number;
  status:
    | 'draft'
    | 'sandbox_running'
    | 'sandbox_passed'
    | 'sandbox_failed'
    | 'live_active'
    | 'live_paused'
    | 'reverted';
  step1_brokers: { use_ibkr?: boolean; use_binance_us?: boolean };
  step2_credentials_status: Record<string, string>;
  step3_mandate_config: Record<string, unknown>;
  step4_sandbox_results: Record<string, unknown>;
  step5_activation_at: string | null;
  step5_activated_by: string | null;
  autonomy_mandate_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlagState {
  flag_key: string;
  enabled_db: boolean | null;
  enabled_env: boolean;
  effective: boolean;
  last_set_at: string | null;
  set_via: string | null;
}

export function useWizardState(portfolioId: string | null) {
  return useQuery({
    queryKey: ['live-wizard', portfolioId],
    queryFn: () => apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
  });
}

export function useFlagsStates() {
  return useQuery({
    queryKey: ['live-flags-states'],
    queryFn: () => apiFetch<{ flags: FlagState[] }>('/live-trading-wizard/flags/states'),
    refetchInterval: 30_000,
  });
}

export function useStep1(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { use_ibkr: boolean; use_binance_us: boolean }) =>
      apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}/step1`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-wizard', portfolioId] }),
  });
}

export function useStep2(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ibkr_connection_id?: string; binance_connection_id?: string }) =>
      apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}/step2`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-wizard', portfolioId] }),
  });
}

export function useStep3(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      max_position_size_pct: number;
      max_single_trade_pct: number;
      max_daily_trade_pct: number;
      allowed_asset_classes: string[];
      forbidden_tickers: string[];
      stop_loss_trigger_pct: number;
      expires_in_days: number;
      max_open_positions: number;
    }) =>
      apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}/step3`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-wizard', portfolioId] }),
  });
}

export function useActivateLive(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (acknowledged: boolean) =>
      apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}/activate`, {
        method: 'POST',
        body: JSON.stringify({ acknowledged }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-wizard', portfolioId] });
      qc.invalidateQueries({ queryKey: ['live-flags-states'] });
    },
  });
}

export function useRevertToPaper(portfolioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      apiFetch<WizardState>(`/live-trading-wizard/${portfolioId}/revert`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['live-wizard', portfolioId] });
      qc.invalidateQueries({ queryKey: ['live-flags-states'] });
    },
  });
}
