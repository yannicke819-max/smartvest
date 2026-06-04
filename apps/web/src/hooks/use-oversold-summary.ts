// LISA — Oversold book summary hook (vue dédiée mode oversold).
// Source : GET /lisa/oversold-summary/:portfolioId (valorisation EOD, stats
// scopées source=scanner_oversold — pas de mélange avec l'historique gainers).

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OversoldBookPosition {
  symbol: string;
  entryPrice: number;
  currentPrice: number | null;
  quantity: number;
  notionalUsd: number;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  dropPctAtEntry: number | null;
  heldDays: number;
  daysRemaining: number;
  stopPrice: number | null;
  distToStopPct: number | null;
}

export interface OversoldBookSummary {
  portfolioId: string;
  capitalUsd: number;
  openCount: number;
  deployedNotionalUsd: number;
  currentBookValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  realizedPnlUsd: number;
  realizedTrades: number;
  realizedWins: number;
  realizedWinRatePct: number | null;
  holdDaysTarget: number;
  stopCatastrophePct: number;
  dropBand: { min: number; max: number };
  asOf: string;
  positions: OversoldBookPosition[];
}

export function useOversoldSummary(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-summary', portfolioId],
    queryFn: () => apiFetch<OversoldBookSummary>(`/lisa/oversold-summary/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
