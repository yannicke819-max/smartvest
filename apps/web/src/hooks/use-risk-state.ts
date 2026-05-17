'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * PR #338 — état de risque d'un portfolio :
 *   - circuit breaker (lisa_circuit_breaker_state, migration 0142)
 *   - sanity rejections (lisa_sanity_rejections, migration 0142)
 *   - feature flags Fly (read-only ConfigService côté backend)
 */
export interface SanityRow {
  id: string;
  symbol: string;
  asset_class: string | null;
  raw_exit_price: number | null;
  raw_pnl_pct: number | null;
  raison: string;
  rejected_at: string;
}

export interface RiskStateResponse {
  circuit_breaker: {
    is_tripped: boolean;
    triggered_at: string | null;
    reason: string | null;
    pnl_at_trigger: number | null;
    positions_open_at_trigger: number | null;
    resolved_at: string | null;
    notes: string | null;
  };
  sanity_rejections: {
    count_24h: number;
    recent: SanityRow[];
  };
  feature_flags: {
    quick_wins_pipeline_enabled: boolean;
    gainers_nse_blacklist_enabled: boolean;
  };
}

export function useRiskState(portfolioId: string | null) {
  return useQuery({
    queryKey: ['risk-state', portfolioId],
    queryFn: () => apiFetch<RiskStateResponse>(`/lisa/risk-state/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
  });
}
