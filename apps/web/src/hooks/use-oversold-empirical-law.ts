// LISA — Oversold empirical law hook (panel dédié mode oversold).
// Source : GET /lisa/oversold-empirical-law/:portfolioId — winRate / PnL moyen
// par bande de drop 1j à l'entrée. Deux lois : realized (clôturés, dispo) et
// forwardJ10 (qualité d'entrée isolée, se peuple ~18/06).

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OversoldLawBucket {
  label: string;
  n: number;
  wins: number;
  winRatePct: number | null;
  avgPct: number | null;
  ciLowPct: number | null;
  ciHighPct: number | null;
}

export interface OversoldLawTable {
  sampleSize: number;
  overallWinRatePct: number | null;
  overallAvgPct: number | null;
  byDropBand: OversoldLawBucket[];
}

export interface OversoldEmpiricalLaw {
  portfolioId: string;
  realized: OversoldLawTable;
  forwardJ10: OversoldLawTable & { horizonDays: number };
  asOf: string;
}

export function useOversoldEmpiricalLaw(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-empirical-law', portfolioId],
    queryFn: () => apiFetch<OversoldEmpiricalLaw>(`/lisa/oversold-empirical-law/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 300_000,
    staleTime: 120_000,
  });
}
