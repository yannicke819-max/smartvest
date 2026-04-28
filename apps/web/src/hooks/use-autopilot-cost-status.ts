'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * P8-BR — État budget + pause autopilot.
 * GET /autopilot/cost-status?portfolioId=...
 *
 * Polling 30s côté UI : refresh fréquent pour refléter rapidement la
 * reprise auto au minuit UTC ou après bump de budget.
 */
export interface AutopilotCostStatus {
  daily_used_usd: number;
  daily_budget_usd: number | null;
  pct: number | null;
  paused_reason: 'BUDGET_EXCEEDED' | 'MANUAL' | 'PROVIDER_OUTAGE' | null;
  autopilot_enabled: boolean;
  kill_switch_active: boolean;
  next_reset_utc: string;
}

export function useAutopilotCostStatus(portfolioId: string | null) {
  return useQuery({
    queryKey: ['autopilot-cost-status', portfolioId],
    queryFn: () =>
      apiFetch<AutopilotCostStatus>(
        `/autopilot/cost-status?portfolioId=${encodeURIComponent(portfolioId ?? '')}`,
      ),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
  });
}
