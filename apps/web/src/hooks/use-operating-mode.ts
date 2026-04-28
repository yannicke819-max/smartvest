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

/**
 * P8 — Snapshot multi-TF persistance pour le top N candidats.
 * Sources : EODHD multi-exchange + Binance crypto, fetch parallèle, cache 30s.
 * Réponse littérale à la question user : « 20 valeurs en hausse 1min →
 * combien sont aussi en hausse 5/10/15/30/60min ? ».
 */
export interface PathQualityMetric {
  pathEfficiency: number;
  pullbackDepth: number;
  monotonicity: number;
  smoothnessLabel: 'smooth' | 'mixed' | 'choppy';
  n: number;
}

export interface PathQualityByTf {
  overallEfficiency: number | null;
  overallSmoothness: 'smooth' | 'mixed' | 'choppy' | null;
  tf5m: PathQualityMetric | null;
  tf10m: PathQualityMetric | null;
  tf15m: PathQualityMetric | null;
  tf30m: PathQualityMetric | null;
  tf1h: PathQualityMetric | null;
}

export interface PersistenceCandidate {
  symbol: string;
  market: string;
  tf1m: number | null;
  tf5m: number | null;
  tf10m: number | null;
  tf15m: number | null;
  tf30m: number | null;
  tf1h: number | null;
  persistenceScore: number | null;
  persistenceCount: string | null;
  /** P9-UX ADDENDUM — null si pas dispo. */
  pathQuality?: PathQualityByTf | null;
}

export interface PersistenceSnapshot {
  capturedAt: string;
  topN: number;
  marketsScanned: string[];
  candidates: PersistenceCandidate[];
  summary: {
    oneMinute: number;
    fiveMinutes: number;
    tenMinutes: number;
    fifteenMinutes: number;
    thirtyMinutes: number;
    oneHour: number;
  };
}

export function usePersistenceSnapshot(
  portfolioId: string | null,
  topN: number,
  enabled: boolean,
  markets?: string,
) {
  const qs = new URLSearchParams();
  qs.set('topN', String(topN));
  if (markets) qs.set('markets', markets);
  return useQuery({
    queryKey: ['persistence-snapshot', portfolioId, topN, markets ?? ''],
    queryFn: () =>
      apiFetch<PersistenceSnapshot>(
        `/lisa/gainers-persistence-snapshot/${portfolioId}?${qs.toString()}`,
      ),
    enabled: !!portfolioId && enabled,
    refetchInterval: 60_000,
  });
}

/**
 * P9-UX — Update gainers_cycle_minutes via POST /lisa/config/:portfolioId.
 * L'endpoint upsertSessionConfig accepte un body partiel. On poste juste
 * le champ qu'on veut modifier.
 */
export function useUpdateGainersCycle(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gainersCycleMinutes: number) =>
      apiFetch<unknown>(`/lisa/config/${portfolioId}`, {
        method: 'POST',
        body: JSON.stringify({ gainers_cycle_minutes: gainersCycleMinutes }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gainers-status', portfolioId] });
      qc.invalidateQueries({ queryKey: ['lisa-config', portfolioId] });
    },
  });
}
