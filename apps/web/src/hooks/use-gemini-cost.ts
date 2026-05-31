// PR2 cost-cuts (H) — hooks React Query pour le kill-switch Gemini.
//
// Backend endpoints (lisa.controller) :
//   GET  /lisa/gemini-cost/status
//   POST /lisa/gemini-cost/manual-override  body { reason?: string }
//   POST /lisa/gemini-cost/clear-override
//
// L'UI panel `GeminiCostPanel` poll status toutes les 30s pour rafraîchir le
// montant quotidien + état kill-switch + bouton "Relancer" si bloqué.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface GeminiCostStatus {
  todayUsd: number;
  monthToDateUsd: number;
  hardCapUsd: number;
  killSwitchActive: boolean;
  manualOverrideActive: boolean;
  overrideAt: string | null;
  overrideReason: string | null;
  capUsedPct: number;
  nextResetUtc: string;
}

export function useGeminiCostStatus() {
  return useQuery({
    queryKey: ['lisa', 'gemini-cost', 'status'],
    queryFn: () => apiFetch<GeminiCostStatus>('/lisa/gemini-cost/status'),
    // Poll 30s — aligné avec le cache backend GeminiBudgetGuardService.CACHE_TTL_MS.
    refetchInterval: 30_000,
    // On garde le polling même quand l'onglet est en background, pour que la
    // facturation reste visible si l'utilisateur revient après une longue absence.
    // Coût Supabase faible (1 query agrégée + 1 lookup override par 30s).
    refetchIntervalInBackground: true,
    staleTime: 15_000,
  });
}

export function useGeminiManualOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiFetch<GeminiCostStatus>('/lisa/gemini-cost/manual-override', {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    onSuccess: (data) => {
      // Invalide le cache + write back direct pour update instant de l'UI.
      qc.setQueryData(['lisa', 'gemini-cost', 'status'], data);
      qc.invalidateQueries({ queryKey: ['lisa', 'gemini-cost', 'status'] });
    },
  });
}

export function useGeminiClearOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<GeminiCostStatus>('/lisa/gemini-cost/clear-override', {
        method: 'POST',
      }),
    onSuccess: (data) => {
      qc.setQueryData(['lisa', 'gemini-cost', 'status'], data);
      qc.invalidateQueries({ queryKey: ['lisa', 'gemini-cost', 'status'] });
    },
  });
}
