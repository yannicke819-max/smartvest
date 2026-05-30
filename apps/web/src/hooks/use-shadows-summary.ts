// LISA — Shadows Summary hook (compare TRADER vs HIGH/MIDDLE/SMALL).

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ShadowSummaryRow {
  id: string;
  name: string;
  label: 'HIGH' | 'MIDDLE' | 'SMALL';
  base_capital_usd: number;
  current_capital_usd: number;
  cumulative_pnl_usd: number;
  return_from_inception_pct: number;
  open_positions: number;
  deployed_usd: number;
  today: {
    pnl_usd: number;
    trades: number;
    wins: number;
    losses: number;
    win_rate_pct: number | null;
  };
  all_time: {
    trades: number;
    wins: number;
    losses: number;
    win_rate_pct: number | null;
  };
  kill_switch_active: boolean;
  open_symbols: string[];
}

export interface ShadowsSummaryResponse {
  generated_at: string;
  shadows: ShadowSummaryRow[];
}

export function useShadowsSummary() {
  return useQuery({
    queryKey: ['lisa', 'shadows-summary'],
    queryFn: () => apiFetch<ShadowsSummaryResponse>('/lisa/shadows-summary'),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
