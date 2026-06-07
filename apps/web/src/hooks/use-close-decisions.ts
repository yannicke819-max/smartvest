// LISA — Décisions de close labellisées (imitation learning).
// Source : GET /lisa/close-decisions/:portfolioId — chaque close avec son verdict
// +60min (GOOD/EARLY/OK) et son verdict à l'échéance J+10 (CLOSE_BETTER/HELD_BETTER
// /NEUTRAL) + contexte + news. Observation : "as-tu bien fait de fermer ici ?".

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CloseDecisionRow {
  id: string;
  symbol: string;
  context: string | null;
  closerType: string | null;
  closedAt: string;
  pnlPct: number | null;
  pnlUsd: number | null;
  ageMinutes: number | null;
  mfePct: number | null;
  giveBackFromMfe: number | null;
  verdict60m: string | null;
  deadlineVerdict: string | null;
  pnlIfHeldToDeadlinePct: number | null;
  hoursToDeadline: number | null;
  hasDeadline: boolean;
  newsCount: number | null;
  newsMinSentiment: number | null;
}

export interface CloseDecisionsResponse {
  rows: CloseDecisionRow[];
  summary: { total: number; early60m: number; good60m: number; heldBetter: number; closeBetter: number };
}

export function useCloseDecisions(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'close-decisions', portfolioId],
    queryFn: () => apiFetch<CloseDecisionsResponse>(`/lisa/close-decisions/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}
