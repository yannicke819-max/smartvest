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
// Types (mirror of backend DTOs)
// ---------------------------------------------------------------------------
export type FundingTransferStatus =
  | 'draft'
  | 'initiated'
  | 'pending_settlement'
  | 'settled'
  | 'partially_settled'
  | 'cancelled'
  | 'failed'
  | 'reversed';

export interface FundingSourceRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  currency: string;
  iban: string | null;
  bic: string | null;
  bank_name: string | null;
  account_number: string | null;
  is_active: boolean;
  created_at: string;
}

export interface FundingDestinationRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  currency: string;
  broker_account_id: string | null;
  is_active: boolean;
  created_at: string;
}

export interface FundingTransferRow {
  id: string;
  user_id: string;
  source_id: string | null;
  destination_id: string;
  amount: string;
  currency: string;
  status: FundingTransferStatus;
  initiated_at: string | null;
  expected_settlement_date: string | null;
  settled_amount: string | null;
  settlement_date: string | null;
  notes: string | null;
  reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface FundingAuditRow {
  id: string;
  transfer_id: string;
  event_kind: string;
  from_status: string | null;
  to_status: string | null;
  amount: string | null;
  actor_id: string | null;
  reason: string | null;
  hash: string;
  prev_hash: string | null;
  occurred_at: string;
  created_at: string;
}

export interface TransferFilters {
  status?: FundingTransferStatus;
  destinationId?: string;
  limit?: number;
}

export interface CreateTransferPayload {
  destination_id: string;
  amount: string;
  currency: string;
  source_id?: string;
  expected_settlement_date?: string;
  notes?: string;
  reference?: string;
}

export interface SettleTransferPayload {
  settled_amount: string;
  settlement_date?: string;
  notes?: string;
}

function qs(filters: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------
export function useFundingTransfers(filters: TransferFilters = {}) {
  return useQuery({
    queryKey: ['funding', 'transfers', filters],
    queryFn: () =>
      apiFetch<FundingTransferRow[]>(
        `/funding/transfers${qs({
          status: filters.status,
          destinationId: filters.destinationId,
          limit: filters.limit ?? 50,
        })}`,
      ),
    staleTime: 15_000,
  });
}

export function useFundingTransfer(id: string | null) {
  return useQuery({
    queryKey: ['funding', 'transfers', id],
    queryFn: () => apiFetch<FundingTransferRow>(`/funding/transfers/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useFundingTransferAudit(id: string | null) {
  return useQuery({
    queryKey: ['funding', 'audit', id],
    queryFn: () => apiFetch<FundingAuditRow[]>(`/funding/transfers/${id}/audit`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useFundingSources() {
  return useQuery({
    queryKey: ['funding', 'sources'],
    queryFn: () => apiFetch<FundingSourceRow[]>('/funding/sources'),
    staleTime: 60_000,
  });
}

export function useFundingDestinations() {
  return useQuery({
    queryKey: ['funding', 'destinations'],
    queryFn: () => apiFetch<FundingDestinationRow[]>('/funding/destinations'),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export function useCreateFundingTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTransferPayload) =>
      apiFetch<FundingTransferRow>('/funding/transfers', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['funding', 'transfers'] });
    },
  });
}

export function useInitiateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<FundingTransferRow>(`/funding/transfers/${id}/initiate`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['funding', 'transfers'] });
      qc.invalidateQueries({ queryKey: ['funding', 'transfers', id] });
      qc.invalidateQueries({ queryKey: ['funding', 'audit', id] });
      qc.invalidateQueries({ queryKey: ['cash', 'summary'] });
      qc.invalidateQueries({ queryKey: ['cash', 'balances'] });
    },
  });
}

export function useSettleTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SettleTransferPayload }) =>
      apiFetch<FundingTransferRow>(`/funding/transfers/${id}/settle`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['funding', 'transfers'] });
      qc.invalidateQueries({ queryKey: ['funding', 'transfers', id] });
      qc.invalidateQueries({ queryKey: ['funding', 'audit', id] });
      qc.invalidateQueries({ queryKey: ['cash', 'summary'] });
      qc.invalidateQueries({ queryKey: ['cash', 'balances'] });
      qc.invalidateQueries({ queryKey: ['cash', 'ledger'] });
    },
  });
}

export function useCancelTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<FundingTransferRow>(`/funding/transfers/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['funding', 'transfers'] });
      qc.invalidateQueries({ queryKey: ['funding', 'transfers', id] });
      qc.invalidateQueries({ queryKey: ['funding', 'audit', id] });
      qc.invalidateQueries({ queryKey: ['cash', 'summary'] });
      qc.invalidateQueries({ queryKey: ['cash', 'balances'] });
    },
  });
}
