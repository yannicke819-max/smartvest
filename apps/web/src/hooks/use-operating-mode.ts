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

/**
 * P19y (29/04/2026) — Coverage source : permet l'UI d'afficher des badges
 * différenciés selon la cause de l'indisponibilité 1m/5m :
 *   - eodhd_1m   : 1m natif (best — green)
 *   - eodhd      : 5m only (tf1m=null par design — yellow tooltip "5m only")
 *   - eodhd_ticks: aggregated from ticks (orange — degraded)
 *   - yahoo      : Yahoo fallback (yellow — IP rate-limited)
 *   - binance    : crypto klines natifs
 *   - cache_stale: last-known < 15min (orange + age)
 *   - none       : aucune source — badge cause inferred (market_closed,
 *                  illiquid, unsupported) en frontend selon le ticker
 */
export type CoverageSource =
  | 'eodhd_1m'
  | 'eodhd'
  | 'eodhd_ticks'
  | 'yahoo'
  | 'binance'
  | 'cache_stale'
  | 'none';

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
  /** P19y — Coverage source pour badge UI. Default 'none' si backend pré-P19y. */
  coverage?: CoverageSource;
  /** P19y — âge cache (ms) si coverage='cache_stale'. */
  cacheAgeMs?: number | null;
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
