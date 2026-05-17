'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * PR #338 — agrégation Quick Wins activity sur 24h glissantes
 * (table `qw_decision_log`, migration 0140).
 */
export interface QwStatsRow {
  qw_id: string;
  total: number;
  pass: number;
  block: number;
  modify: number;
  shadow_would_have_passed: number;
  pct_block: number;
  pct_modify: number;
}

export interface QwRecentEntry {
  id: string;
  created_at: string;
  qw_id: string;
  symbol: string;
  asset_class: string;
  decision: string;
  reason: string;
  would_have_passed_without_flag: boolean;
}

export function useQuickWinsStats() {
  return useQuery({
    queryKey: ['quick-wins-stats'],
    queryFn: () => apiFetch<QwStatsRow[]>('/lisa/quick-wins/stats'),
    refetchInterval: 60_000,
  });
}

export function useQuickWinsRecent(limit = 50) {
  return useQuery({
    queryKey: ['quick-wins-recent', limit],
    queryFn: () => apiFetch<QwRecentEntry[]>(`/lisa/quick-wins/recent?limit=${limit}`),
    refetchInterval: 30_000,
  });
}
