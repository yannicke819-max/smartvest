// LISA — Sizing dynamique oversold (carte UI de configuration).
// GET/POST /lisa/oversold-sizing/:portfolioId — paramètres par portfolio.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OversoldSizing {
  enabled: boolean;
  baseNotionalUsd: number;
  capitalUsd: number;
  bandMultDeep: number;
  bandMultShallow: number;
  vixDampElevated: number;
  vixDampStress: number;
  floorUsd: number;
  ceilingPctCapital: number;
}

export function useOversoldSizing(portfolioId: string | null) {
  return useQuery({
    queryKey: ['lisa', 'oversold-sizing', portfolioId],
    queryFn: () => apiFetch<OversoldSizing>(`/lisa/oversold-sizing/${portfolioId}`),
    enabled: !!portfolioId,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateOversoldSizing(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<OversoldSizing>) =>
      apiFetch<OversoldSizing>(`/lisa/oversold-sizing/${portfolioId}`, {
        method: 'POST',
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['lisa', 'oversold-sizing', portfolioId], data);
    },
  });
}
