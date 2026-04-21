'use client';

import { useQuery } from '@tanstack/react-query';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function authHeaders(): Promise<Record<string, string>> {
  const s = createSupabaseBrowserClient();
  const { data: { session } } = await s.auth.getSession();
  return session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {};
}

export interface HistoryPoint {
  date: string;
  marketValue: string;
  costBasis: string;
  pnlAbsolute: string;
  pnlPercent: string;
}

export interface PerformanceMetrics {
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  totalReturnPct: string;
  annualizedReturnPct: string | null;
  volatility: string | null;
  maxDrawdownPct: string;
  currentDrawdownPct: string;
  dayCount: number;
  positiveDays: number;
  negativeDays: number;
}

export interface BenchmarkComparison {
  benchmarkId: string | null;
  benchmarkTicker: string | null;
  benchmarkName: string | null;
  portfolioReturnPct: string;
  benchmarkReturnPct: string | null;
  excessReturnPct: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  series: Array<{ date: string; portfolio: string; benchmark: string | null }>;
}

export function useHistory(portfolioId: string | null) {
  return useQuery<HistoryPoint[]>({
    queryKey: ['history', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/history`, { headers });
      const json = await res.json();
      return json.data as HistoryPoint[];
    },
  });
}

export function usePerformanceMetrics(portfolioId: string | null) {
  return useQuery<PerformanceMetrics>({
    queryKey: ['performance-metrics', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/performance-metrics`, { headers });
      const json = await res.json();
      return json.data as PerformanceMetrics;
    },
  });
}

export function useBenchmark(portfolioId: string | null) {
  return useQuery<BenchmarkComparison>({
    queryKey: ['benchmark', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      const headers = await authHeaders();
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/benchmark`, { headers });
      const json = await res.json();
      return json.data as BenchmarkComparison;
    },
  });
}
