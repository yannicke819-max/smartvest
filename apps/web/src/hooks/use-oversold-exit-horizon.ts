// LISA — « Meilleur jour de sortie » v2 POPULATION COMPLÈTE (mode oversold).
// Source : GET /lisa/oversold-exit-horizon/:portfolioId — pour TOUTES les entrées
// (perdantes incluses, biais de survie éliminé) : lock = P&L réalisé des fermées,
// J+N = fwd_return_{1,3,6,10}d stampés par le labeler. MESURE SEULE.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ExitHorizonKey = 'lock' | 'j1' | 'j3' | 'j6' | 'j10';

export interface ExitHorizonDay {
  label: string;
  key: ExitHorizonKey;
  avgPct: number | null;
  medPct: number | null;
  winPct: number | null;
  n: number;
}

export interface OversoldExitHorizon {
  portfolioId: string;
  n: number;
  basis: 'full_population';
  days: ExitHorizonDay[];
  bestDayByMean: string | null;
  bestDayByMedian: string | null;
  lockAvgPct: number | null;
  bestHoldLabel: string | null;
  bestHoldAvgPct: number | null;
  upliftBestHoldVsLockPct: number | null;
  minSampleForBest: number;
  asOf: string;
}

export function useOversoldExitHorizon(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-exit-horizon', portfolioId],
    queryFn: () => apiFetch<OversoldExitHorizon>(`/lisa/oversold-exit-horizon/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 300_000,
    staleTime: 120_000,
  });
}
