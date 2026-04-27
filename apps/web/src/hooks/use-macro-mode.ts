'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type MacroMode = 'INVESTMENT' | 'HARVEST' | 'CUSTOM';

/** Détecte le mode macro courant pour un portfolio. */
export function useMacroMode(portfolioId: string | null) {
  return useQuery({
    queryKey: ['macro-mode', portfolioId],
    queryFn: () => apiFetch<{ mode: MacroMode }>(`/lisa/macro-mode/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
  });
}

/** Applique un preset macro mode (INVESTMENT ou HARVEST). */
export function useApplyMacroMode(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'INVESTMENT' | 'HARVEST') =>
      apiFetch<{ mode: MacroMode; appliedConfig: Record<string, unknown> }>(
        `/lisa/macro-mode/${portfolioId}`,
        { method: 'POST', body: JSON.stringify({ mode }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['macro-mode', portfolioId] });
      qc.invalidateQueries({ queryKey: ['lisa-config', portfolioId] });
      qc.invalidateQueries({ queryKey: ['daily-harvest', portfolioId] });
    },
  });
}
