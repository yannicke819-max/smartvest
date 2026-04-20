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

export interface MandateRow {
  id: string;
  portfolio_id: string;
  user_id: string;
  status: 'pending_activation' | 'active' | 'suspended' | 'expired' | 'revoked';
  label: string;
  max_position_size_pct: string;
  max_single_trade_pct: string;
  max_daily_trade_pct: string;
  max_single_trade_notional: string | null;
  max_single_trade_notional_currency: string | null;
  allowed_asset_classes: string[];
  forbidden_tickers: string[];
  requires_human_above_pct: string;
  stop_loss_trigger_pct: string;
  max_open_positions: number | null;
  expires_at: string;
  kill_switch_active: boolean;
  activated_at: string | null;
  suspended_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRow {
  id: string;
  portfolio_id: string;
  mandate_id: string | null;
  kind: string;
  delegation_mode: string;
  reason: string;
  prev_hash: string | null;
  hash: string;
  occurred_at: string;
}

export interface CreateMandateInput {
  portfolioId: string;
  label: string;
  maxPositionSizePct: number;
  maxSingleTradePct: number;
  maxDailyTradePct: number;
  maxSingleTradeNotional?: number;
  maxSingleTradeNotionalCurrency?: string;
  allowedAssetClasses: string[];
  forbiddenTickers: string[];
  requiresHumanAbovePct: number;
  stopLossTriggerPct: number;
  maxOpenPositions?: number;
  expiresAt: string;
}

export function useMandates(portfolioId?: string) {
  return useQuery({
    queryKey: ['mandates', portfolioId],
    queryFn: () =>
      apiFetch<MandateRow[]>(`/mandates${portfolioId ? `?portfolioId=${portfolioId}` : ''}`),
    enabled: true,
  });
}

export function useMandate(id: string | null) {
  return useQuery({
    queryKey: ['mandate', id],
    queryFn: () => apiFetch<MandateRow>(`/mandates/${id}`),
    enabled: !!id,
  });
}

export function useAuditEvents(portfolioId: string | null, mandateId?: string) {
  return useQuery({
    queryKey: ['mandate-audit', portfolioId, mandateId],
    queryFn: () => {
      const qs = mandateId
        ? `?portfolioId=${portfolioId}&mandateId=${mandateId}`
        : `?portfolioId=${portfolioId}`;
      return apiFetch<AuditEventRow[]>(`/mandates/audit${qs}`);
    },
    enabled: !!portfolioId,
  });
}

export function useCreateMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMandateInput) =>
      apiFetch<MandateRow>('/mandates', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
}

export function useUpdateMandate(id: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CreateMandateInput>) =>
      apiFetch<MandateRow>(`/mandates/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mandates'] });
      qc.invalidateQueries({ queryKey: ['mandate', id] });
    },
  });
}

export function useActivateMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<MandateRow>(`/mandates/${id}/activate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
}

export function useSuspendMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<MandateRow>(`/mandates/${id}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
}

export function useRevokeMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<MandateRow>(`/mandates/${id}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
}

export function useKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, activate, reason }: { id: string; activate: boolean; reason?: string }) =>
      apiFetch<MandateRow>(`/mandates/${id}/kill-switch`, {
        method: 'POST',
        body: JSON.stringify({ activate, reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mandates'] }),
  });
}
