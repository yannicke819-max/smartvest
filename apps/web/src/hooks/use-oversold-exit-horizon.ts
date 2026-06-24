// LISA — Oversold "meilleur jour de sortie" shadow hook (mode oversold).
// Source : GET /lisa/oversold-exit-horizon/:portfolioId — pour les closes labellisés
// (trajectoire J+1..J+10), P&L moyen/médian qu'un exit à chaque horizon aurait donné
// vs le lock réalisé. MESURE SEULE, ne change rien au trading.

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
  days: ExitHorizonDay[];
  bestDayByMean: string | null;
  bestDayByMedian: string | null;
  lockAvgPct: number | null;
  j6AvgPct: number | null;
  upliftJ6VsLockPct: number | null;
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
