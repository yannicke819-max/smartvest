'use client';

import { useQuery, useMutation } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function token(): Promise<string | null> {
  const s = createSupabaseBrowserClient();
  const { data: { session } } = await s.auth.getSession();
  return session?.access_token ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { authorization: `Bearer ${t}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
}

export interface ImportFormat { format: string; label: string }

export interface ImportRow {
  rowNumber: number;
  tradeDate: string | null;
  action: string | null;
  ticker: string | null;
  isin: string | null;
  quantity: string | null;
  unitPrice: string | null;
  currency: string | null;
  brokerFee: string | null;
  assetId: string | null;
  matchedAssetConfidence: number | null;
  status: 'pending' | 'valid' | 'invalid' | 'duplicate' | 'committed' | 'skipped';
  validationErrors: string[];
}

export interface ImportPreview {
  jobId: string;
  brokerFormat: string;
  filename: string | null;
  rowsDetected: number;
  rowsValid: number;
  rowsInvalid: number;
  rowsDuplicate: number;
  rows: ImportRow[];
}

export interface ImportHistoryEntry {
  id: string;
  broker_format: string;
  filename: string | null;
  status: string;
  rows_detected: number;
  rows_valid: number;
  rows_committed: number;
  created_at: string;
  committed_at: string | null;
}

export function useImportFormats() {
  return useQuery<ImportFormat[]>({
    queryKey: ['import-formats'],
    staleTime: 300_000,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/imports/formats`);
      if (!res.ok) throw new Error('Failed');
      const json = await res.json();
      return json.data as ImportFormat[];
    },
  });
}

export function useImportPreview() {
  return useMutation<ImportPreview, Error, { portfolioId: string; accountId?: string; csvContent: string; filename?: string; brokerFormat?: string }>({
    mutationFn: async (body) => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/imports/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Erreur de prévisualisation');
      return json.data as ImportPreview;
    },
  });
}

export function useImportCommit() {
  return useMutation<{ rowsCommitted: number; transactionsCreated: number; rowsSkipped: number }, Error, { jobId: string; rowsToSkip?: number[] }>({
    mutationFn: async ({ jobId, rowsToSkip }) => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/imports/${jobId}/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ rowsToSkip: rowsToSkip ?? [] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Erreur de commit');
      return json.data;
    },
  });
}

export function useImportHistory(portfolioId: string | null) {
  return useQuery<ImportHistoryEntry[]>({
    queryKey: ['import-history', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/imports/history?portfolioId=${portfolioId}`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Erreur');
      return json.data as ImportHistoryEntry[];
    },
  });
}
