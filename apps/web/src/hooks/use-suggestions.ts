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

export type LifecycleState = 'draft' | 'presented' | 'approved' | 'rejected' | 'expired' | 'executed' | 'cancelled';
export type ProposalKind = 'information' | 'simulation' | 'suggestion' | 'execution_intent' | 'execution';
export type ProposalAction = 'buy' | 'sell' | 'rebalance' | 'contribute' | 'withdraw' | 'fx' | 'other';

export interface ProposalRow {
  id: string;
  portfolio_id: string;
  user_id: string;
  kind: ProposalKind;
  delegation_mode: string;
  lifecycle_state: LifecycleState;
  action: ProposalAction;
  asset_id: string | null;
  ticker: string | null;
  quantity: string | null;
  notional: string | null;
  currency: string | null;
  rationale: string;
  assumptions: string | string[];
  estimated_broker_fee: string | null;
  estimated_spread_cost: string | null;
  estimated_slippage_cost: string | null;
  estimated_fx_markup: string | null;
  estimated_total_friction: string | null;
  friction_currency: string | null;
  presented_at: string | null;
  expires_at: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
  mandate_id: string | null;
}

export interface AuditEventRow {
  id: string;
  kind: string;
  delegation_mode: string;
  reason: string;
  action: string | null;
  ticker: string | null;
  notional: string | null;
  prev_hash: string | null;
  hash: string;
  occurred_at: string;
}

export interface ProposalFilters {
  portfolioId?: string;
  lifecycleState?: LifecycleState;
  kind?: ProposalKind;
  action?: ProposalAction;
  limit?: number;
}

function buildQuery(filters: ProposalFilters): string {
  const params = new URLSearchParams();
  if (filters.portfolioId) params.set('portfolioId', filters.portfolioId);
  if (filters.lifecycleState) params.set('lifecycleState', filters.lifecycleState);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.action) params.set('action', filters.action);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useProposals(filters: ProposalFilters = {}) {
  return useQuery({
    queryKey: ['proposals', filters],
    queryFn: () => apiFetch<ProposalRow[]>(`/action-proposals${buildQuery(filters)}`),
  });
}

export function useProposal(id: string | null) {
  return useQuery({
    queryKey: ['proposal', id],
    queryFn: () => apiFetch<ProposalRow>(`/action-proposals/${id}`),
    enabled: !!id,
  });
}

export function useProposalAudit(id: string | null) {
  return useQuery({
    queryKey: ['proposal-audit', id],
    queryFn: () => apiFetch<AuditEventRow[]>(`/action-proposals/${id}/audit`),
    enabled: !!id,
  });
}

export function usePendingCount(portfolioId?: string) {
  return useQuery({
    queryKey: ['pending-count', portfolioId],
    queryFn: () => {
      const qs = portfolioId ? `?portfolioId=${portfolioId}` : '';
      return apiFetch<{ count: number }>(`/action-proposals/pending-count${qs}`);
    },
  });
}

export function useApproveProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note, modifiedQuantity, modifiedNotional }: {
      id: string; note?: string; modifiedQuantity?: string; modifiedNotional?: string;
    }) =>
      apiFetch<ProposalRow>(`/action-proposals/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ note, modifiedQuantity, modifiedNotional }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['proposals'] });
      qc.invalidateQueries({ queryKey: ['proposal', vars.id] });
      qc.invalidateQueries({ queryKey: ['proposal-audit', vars.id] });
      qc.invalidateQueries({ queryKey: ['pending-count'] });
    },
  });
}

export function useRejectProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      apiFetch<ProposalRow>(`/action-proposals/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['proposals'] });
      qc.invalidateQueries({ queryKey: ['proposal', vars.id] });
      qc.invalidateQueries({ queryKey: ['proposal-audit', vars.id] });
      qc.invalidateQueries({ queryKey: ['pending-count'] });
    },
  });
}

export function useCancelProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<ProposalRow>(`/action-proposals/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['proposals'] });
      qc.invalidateQueries({ queryKey: ['proposal', vars.id] });
      qc.invalidateQueries({ queryKey: ['pending-count'] });
    },
  });
}
