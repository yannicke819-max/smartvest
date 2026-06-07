// LISA — Oversold news watch hook (panel dédié mode oversold).
// Source : GET /lisa/oversold-news-watch/:portfolioId — veille des news à
// sentiment négatif récent sur les positions tenues. VISIBILITÉ uniquement
// (le mean-reversion tient à travers le bruit ; ce n'est pas un trigger d'exit).

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OversoldNewsAlert {
  symbol: string;
  articleCount: number;
  minSentiment: number;
  latestTitle: string | null;
  latestUrl: string | null;
  latestAgeHours: number | null;
  level: 'shock' | 'watch';
}

export interface OversoldNewsWatch {
  portfolioId: string;
  openPositions: number;
  windowHours: number;
  alerts: OversoldNewsAlert[];
  asOf: string;
}

export function useOversoldNewsWatch(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-news-watch', portfolioId],
    queryFn: () => apiFetch<OversoldNewsWatch>(`/lisa/oversold-news-watch/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}
