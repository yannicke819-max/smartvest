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

export type BrokerProvider =
  | 'INTERACTIVE_BROKERS' | 'SAXO' | 'DEGIRO' | 'TRADING212'
  | 'BOURSE_DIRECT' | 'FORTUNEO' | 'MANUAL';

export type ConnectionStatus = 'pending' | 'active' | 'error' | 'revoked' | 'expired';

export interface BrokerConnectionRow {
  id: string;
  user_id: string;
  provider: BrokerProvider;
  label: string;
  status: ConnectionStatus;
  supports_read: boolean;
  supports_execution: boolean;
  supports_streaming: boolean;
  supports_options: boolean;
  supports_crypto: boolean;
  supports_csv_import: boolean;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BrokerAccountRow {
  id: string;
  connection_id: string;
  account_id_external: string;
  account_type: string;
  base_currency: string;
  display_name: string | null;
  is_active: boolean;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface SyncJobRow {
  id: string;
  connection_id: string;
  status: 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled';
  started_at: string;
  finished_at: string | null;
  positions_count: number;
  cash_count: number;
  transactions_count: number;
  errors: Array<{ code: string; message: string }>;
  cancel_reason: string | null;
}

// Credentials payload — discriminated union mirroring server schema.
export type CreateConnectionPayload =
  | { provider: 'MANUAL'; label: string; credentials: { provider: 'MANUAL'; note: 'no-credentials' } }
  | { provider: 'INTERACTIVE_BROKERS'; label: string; credentials: { provider: 'INTERACTIVE_BROKERS'; accountId: string; sessionToken: string } }
  | { provider: 'SAXO'; label: string; credentials: { provider: 'SAXO'; oauthAccessToken: string; oauthRefreshToken: string; expiresAt: string; accountId?: string } }
  | { provider: 'TRADING212'; label: string; credentials: { provider: 'TRADING212'; apiKey: string; accountId?: string } }
  | { provider: 'DEGIRO'; label: string; credentials: { provider: 'DEGIRO'; note: 'use-csv-import' } }
  | { provider: 'BOURSE_DIRECT'; label: string; credentials: { provider: 'BOURSE_DIRECT'; note: 'use-csv-import' } }
  | { provider: 'FORTUNEO'; label: string; credentials: { provider: 'FORTUNEO'; note: 'use-csv-import' } };

export function useBrokerConnections() {
  return useQuery({
    queryKey: ['brokers', 'connections'],
    queryFn: () => apiFetch<BrokerConnectionRow[]>('/brokers/connections'),
    staleTime: 30_000,
  });
}

export function useBrokerConnection(id: string | null) {
  return useQuery({
    queryKey: ['brokers', 'connections', id],
    queryFn: () => apiFetch<BrokerConnectionRow>(`/brokers/connections/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useBrokerAccounts(id: string | null) {
  return useQuery({
    queryKey: ['brokers', 'accounts', id],
    queryFn: () => apiFetch<BrokerAccountRow[]>(`/brokers/connections/${id}/accounts`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useBrokerJobs(id: string | null) {
  return useQuery({
    queryKey: ['brokers', 'jobs', id],
    queryFn: () => apiFetch<SyncJobRow[]>(`/brokers/connections/${id}/jobs`),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data as SyncJobRow[] | undefined;
      return data?.[0]?.status === 'running' ? 2000 : 20_000;
    },
  });
}

export function useCreateBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateConnectionPayload) =>
      apiFetch<BrokerConnectionRow>('/brokers/connections', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brokers'] }),
  });
}

export function useTestBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; latencyMs: number | null; message: string }>(
        `/brokers/connections/${id}/test`,
        { method: 'POST' },
      ),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['brokers', 'connections', id] });
      qc.invalidateQueries({ queryKey: ['brokers', 'connections'] });
    },
  });
}

export function useSyncBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ jobId: string; status: string }>(
        `/brokers/connections/${id}/sync`,
        { method: 'POST' },
      ),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['brokers', 'connections', id] });
      qc.invalidateQueries({ queryKey: ['brokers', 'jobs', id] });
    },
  });
}

export function useRevokeBrokerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<BrokerConnectionRow>(`/brokers/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brokers'] }),
  });
}
