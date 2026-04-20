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
// Types (mirror of backend DTOs — keep in sync with modules/funding)
// ---------------------------------------------------------------------------
export type MovementType =
  | 'deposit'
  | 'withdrawal'
  | 'transfer_in'
  | 'transfer_out'
  | 'settlement_credit'
  | 'settlement_debit'
  | 'reservation'
  | 'reservation_release'
  | 'adjustment';

export type ReservationStatus = 'active' | 'released' | 'consumed';

export interface CashBalanceRow {
  id: string;
  user_id: string;
  destination_id: string;
  currency: string;
  settled: string;
  pending_in: string;
  reserved: string;
  /** Derived: settled − reserved (returned by the API). */
  available: string;
  updated_at: string;
}

export interface CashSummaryRow {
  currency: string;
  settled: string;
  pending_in: string;
  reserved: string;
  available: string;
}

export interface CashLedgerRow {
  id: string;
  user_id: string;
  destination_id: string;
  currency: string;
  movement_type: MovementType;
  amount: string;
  balance_after: string;
  transfer_id: string | null;
  reservation_id: string | null;
  description: string | null;
  occurred_at: string;
  created_at: string;
}

export interface CashReservationRow {
  id: string;
  user_id: string;
  destination_id: string;
  currency: string;
  amount: string;
  status: ReservationStatus;
  goal_id: string | null;
  proposal_id: string | null;
  plan_id: string | null;
  reason: string;
  expires_at: string | null;
  released_at: string | null;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerFilters {
  destinationId?: string;
  currency?: string;
  movementType?: MovementType;
  limit?: number;
}

export interface ReservationFilters {
  destinationId?: string;
  status?: ReservationStatus;
  goalId?: string;
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
export function useCashSummaryQuery() {
  return useQuery({
    queryKey: ['cash', 'summary'],
    queryFn: () => apiFetch<CashSummaryRow[]>('/cash/balances/summary'),
    staleTime: 30_000,
  });
}

export function useCashBalancesQuery() {
  return useQuery({
    queryKey: ['cash', 'balances'],
    queryFn: () => apiFetch<CashBalanceRow[]>('/cash/balances'),
    staleTime: 30_000,
  });
}

export function useCashLedgerQuery(filters: LedgerFilters = {}) {
  return useQuery({
    queryKey: ['cash', 'ledger', filters],
    queryFn: () =>
      apiFetch<CashLedgerRow[]>(
        `/cash/ledger${qs({
          destinationId: filters.destinationId,
          currency: filters.currency,
          movementType: filters.movementType,
          limit: filters.limit ?? 100,
        })}`,
      ),
    staleTime: 15_000,
  });
}

export function useCashReservationsQuery(filters: ReservationFilters = {}) {
  return useQuery({
    queryKey: ['cash', 'reservations', filters],
    queryFn: () =>
      apiFetch<CashReservationRow[]>(
        `/cash/reservations${qs({
          destinationId: filters.destinationId,
          status: filters.status,
          goalId: filters.goalId,
        })}`,
      ),
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export function useReleaseCashReservationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CashReservationRow>(`/cash/reservations/${id}/release`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash', 'reservations'] });
      qc.invalidateQueries({ queryKey: ['cash', 'balances'] });
      qc.invalidateQueries({ queryKey: ['cash', 'summary'] });
      qc.invalidateQueries({ queryKey: ['cash', 'ledger'] });
    },
  });
}
