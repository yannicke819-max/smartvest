'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * P7-MODE-GAINERS-BADGE — Hooks pour le toggle 3-modes opératoires.
 *
 * GET /lisa/mode/:portfolioId        → { mode: 'investment'|'harvest'|'gainers' }
 * POST /lisa/mode/:portfolioId       → applique + audit
 * GET /lisa/gainers-status/:portfolioId → mini-tile poll 30s
 */

export type OperatingMode = 'investment' | 'harvest' | 'gainers';

export function useOperatingMode(portfolioId: string | null) {
  return useQuery({
    queryKey: ['operating-mode', portfolioId],
    queryFn: () => apiFetch<{ mode: OperatingMode }>(`/lisa/mode/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
  });
}

export function useApplyOperatingMode(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: OperatingMode) =>
      apiFetch<{ mode: OperatingMode; previousMode: OperatingMode }>(
        `/lisa/mode/${portfolioId}`,
        { method: 'POST', body: JSON.stringify({ mode }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['operating-mode', portfolioId] });
      qc.invalidateQueries({ queryKey: ['macro-mode', portfolioId] });
      qc.invalidateQueries({ queryKey: ['lisa-config', portfolioId] });
      qc.invalidateQueries({ queryKey: ['daily-harvest', portfolioId] });
      qc.invalidateQueries({ queryKey: ['gainers-status', portfolioId] });
    },
  });
}

export interface GainersStatus {
  nextTickInSeconds: number;
  intervalMinutes: number;
  openPositions: number;
  maxPositions: number;
  sessionPnlUsd: number;
  lastCandidates: Array<{ symbol: string; changePct: number; score: number }>;
}

export function useGainersStatus(portfolioId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['gainers-status', portfolioId],
    queryFn: () => apiFetch<GainersStatus>(`/lisa/gainers-status/${portfolioId}`),
    enabled: !!portfolioId && enabled,
    refetchInterval: 30_000,
  });
}
