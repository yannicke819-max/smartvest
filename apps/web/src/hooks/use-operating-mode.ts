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

export interface GainersAssetClassBreakdown {
  us: number;
  eu: number;
  asia: number;
  crypto: number;
  other: number;
}

export interface GainersStatus {
  nextTickInSeconds: number;
  intervalMinutes: number;
  openPositions: number;
  maxPositions: number;
  /** TP/SL effectifs lus depuis lisa_session_configs (DB), fallback 1.5/1.0 si absent. */
  tpPct: number;
  slPct: number;
  rrRatio: number;
  sessionPnlUsd: number;
  lastCandidates: Array<{ symbol: string; changePct: number; score: number }>;
  // PR Counters jour (Option B)
  scannedToday: number;
  openedToday: number;
  closedToday: number;
  closedTodayPnlUsd: number;
  scannedByAssetClass: GainersAssetClassBreakdown;
  openedByAssetClass: GainersAssetClassBreakdown;
  closedByAssetClass: GainersAssetClassBreakdown;
  scanned7d: Array<{ date: string; count: number }>;
  // PR #243 Adaptive Selectivity
  adaptiveEnabled: boolean;
  adaptiveActive: boolean;
  trajectoryStatus: 'EN_AVANCE' | 'DANS_LE_PLAN' | 'EN_RETARD' | 'HORS_TRAJECTOIRE' | null;
  trajectoryStatusAt: string | null;
  realised7dPct: number | null;
  target7dPct: number | null;
  // PR #246 — Cartes Gains du jour / Gains du mois (mode-agnostique).
  mtdPnlUsd: number;
  mtdTradesCount: number;
  mtdSessionsCount: number;
  mtdWinningDays: number;
  mtdLosingDays: number;
  mtdBestDay: { date: string; pnl: number } | null;
  mtdWorstDay: { date: string; pnl: number } | null;
  // PR #258 — Carte Gains annuels (YTD).
  ytdPnlUsd: number;
  ytdTradesCount: number;
  ytdMonthsCount: number;
  ytdWinningMonths: number;
  ytdLosingMonths: number;
  ytdBestMonth: { month: string; pnl: number } | null;
  ytdWorstMonth: { month: string; pnl: number } | null;
}

/**
 * PR #258 — EODHD quota status pour UI badge.
 */
export interface EodhdQuotaStatus {
  authoritative: {
    apiRequests: number;
    dailyRateLimit: number;
    extraLimit: number;
    asOf: string | null;
  };
  local: {
    totalProjected: number;
    perEndpoint: Record<string, number>;
    burnRatePerMin: number;
  };
  throttle: {
    scannerPaused: boolean;
    multitfPaused: boolean;
    essentialsOnly: boolean;
    hardBlocked: boolean;
    pauseReason: string | null;
  };
  etaExhaustionMinutes: number | null;
}

export function useEodhdQuota() {
  return useQuery({
    queryKey: ['eodhd-quota'],
    queryFn: () => apiFetch<EodhdQuotaStatus>('/lisa/eodhd-quota'),
    refetchInterval: 30_000,
  });
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
  smoothnessLabel: 'smooth' | 'mixed' | 'choppy' | 'idle';
  n: number;
}

export interface PathQualityByTf {
  overallEfficiency: number | null;
  overallSmoothness: 'smooth' | 'mixed' | 'choppy' | 'idle' | null;
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

/**
 * P19x.2 fix — Lecture config gainers (TP/SL/persistence) depuis
 * GET /lisa/config/:portfolioId. Utilisé pour pré-remplir le formulaire
 * de configuration du scanner Gainers.
 */
export interface GainersConfigFields {
  gainers_default_tp_pct: number | null;
  gainers_default_sl_pct: number | null;
  gainers_min_persistence_score: number | null;
  gainers_min_path_efficiency: number | null;
  gainers_cycle_minutes: number | null;
  // PR #3 — full config (migration 0115)
  gainers_max_open_positions: number | null;
  gainers_max_per_cycle: number | null;
  gainers_position_pct: number | null;
  gainers_cash_reserve_pct: number | null;
  gainers_cooldown_minutes: number | null;
  gainers_universe_us: boolean | null;
  gainers_universe_eu: boolean | null;
  gainers_universe_asia: boolean | null;
  gainers_universe_crypto: boolean | null;
  gainers_fees_aware_buffer: number | null;
  gainers_min_net_profit_usd: number | null;
  // PR #4 — pWin ML gate (migration 0116)
  gainers_p_win_gate_enabled: boolean | null;
  gainers_min_p_win: number | null;
  // PR Autopilot toggle — état du cron scanner pour ce portfolio
  autopilot_enabled: boolean | null;
  // PR #243 Adaptive Selectivity toggle (opt-in, default false)
  gainers_adaptive_enabled: boolean | null;
  // Capital simulé (lu/écrit via la même config session)
  capital_simulation: number | null;
}

const numOrNull = (v: unknown): number | null =>
  v != null && v !== '' ? Number(v) : null;
const boolOrNull = (v: unknown): boolean | null =>
  typeof v === 'boolean' ? v : null;

export function useGainersConfig(portfolioId: string | null) {
  return useQuery({
    queryKey: ['gainers-config', portfolioId],
    queryFn: async () => {
      const raw = await apiFetch<Record<string, unknown>>(`/lisa/config/${portfolioId}`);
      return {
        gainers_default_tp_pct: numOrNull(raw?.gainers_default_tp_pct),
        gainers_default_sl_pct: numOrNull(raw?.gainers_default_sl_pct),
        gainers_min_persistence_score: numOrNull(raw?.gainers_min_persistence_score),
        gainers_min_path_efficiency: numOrNull(raw?.gainers_min_path_efficiency),
        gainers_cycle_minutes: numOrNull(raw?.gainers_cycle_minutes),
        gainers_max_open_positions: numOrNull(raw?.gainers_max_open_positions),
        gainers_max_per_cycle: numOrNull(raw?.gainers_max_per_cycle),
        gainers_position_pct: numOrNull(raw?.gainers_position_pct),
        gainers_cash_reserve_pct: numOrNull(raw?.gainers_cash_reserve_pct),
        gainers_cooldown_minutes: numOrNull(raw?.gainers_cooldown_minutes),
        gainers_universe_us: boolOrNull(raw?.gainers_universe_us),
        gainers_universe_eu: boolOrNull(raw?.gainers_universe_eu),
        gainers_universe_asia: boolOrNull(raw?.gainers_universe_asia),
        gainers_universe_crypto: boolOrNull(raw?.gainers_universe_crypto),
        gainers_fees_aware_buffer: numOrNull(raw?.gainers_fees_aware_buffer),
        gainers_min_net_profit_usd: numOrNull(raw?.gainers_min_net_profit_usd),
        gainers_p_win_gate_enabled: boolOrNull(raw?.gainers_p_win_gate_enabled),
        gainers_min_p_win: numOrNull(raw?.gainers_min_p_win),
        autopilot_enabled: boolOrNull(raw?.autopilot_enabled),
        gainers_adaptive_enabled: boolOrNull(raw?.gainers_adaptive_enabled),
        capital_simulation: numOrNull(raw?.capital_simulation ?? raw?.capital_usd),
      } satisfies GainersConfigFields;
    },
    enabled: !!portfolioId,
  });
}

export function useUpdateGainersConfig(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: Partial<GainersConfigFields>) =>
      apiFetch<unknown>(`/lisa/config/${portfolioId}`, {
        method: 'POST',
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gainers-status', portfolioId] });
      qc.invalidateQueries({ queryKey: ['gainers-config', portfolioId] });
      qc.invalidateQueries({ queryKey: ['lisa-config', portfolioId] });
    },
  });
}

// PR #6 — Hooks pour le dashboard auto-learning
export interface GainersInsightRow {
  id: string;
  created_at: string;
  insight_type: string;
  source: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  payload: Record<string, unknown>;
  status: 'open' | 'investigating' | 'actioned' | 'dismissed';
}

export function useGainersInsights(opts: { sinceDays?: number; limit?: number; type?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.sinceDays != null) params.set('since_days', String(opts.sinceDays));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.type) params.set('type', opts.type);
  return useQuery({
    queryKey: ['gainers-insights', opts.sinceDays, opts.limit, opts.type],
    queryFn: () => apiFetch<{ count: number; insights: GainersInsightRow[] }>(
      `/lisa/gainers/insights-recent?${params.toString()}`,
    ),
    refetchInterval: 60_000,
  });
}

export interface AutoTunerHistoryRow {
  id: string;
  portfolio_id: string;
  threshold_name: string;
  old_value: string;
  new_value: string;
  reason: string;
  fp_rate_observed: string | null;
  failure_rate_observed: string | null;
  sample_size: number;
  applied_to_env: 'shadow' | 'canary' | 'prod';
  auto_or_manual: 'auto' | 'manual';
  applied_at: string;
}

export function useAutoTunerHistory(portfolioId: string | null, limit = 50) {
  return useQuery({
    queryKey: ['auto-tuner-history', portfolioId, limit],
    queryFn: () => apiFetch<{ count: number; history: AutoTunerHistoryRow[] }>(
      `/lisa/gainers/auto-tuner-history/${portfolioId}?limit=${limit}`,
    ),
    enabled: !!portfolioId,
    refetchInterval: 60_000,
  });
}

export interface EmpiricalLawResponse {
  trainedOn: number;
  empiricalLaw: Array<{
    persistenceCount: string;
    n: number;
    pWinObserved: number | null;
    avgPnlPct: number | null;
    ciLow: number | null;
    ciHigh: number | null;
  }>;
  fittedCurve: string;
  coefficients: Record<string, number> | null;
  aucRoc: number | null;
  accuracy: number | null;
  modelVersion: string | null;
  fallback: boolean;
}

export function usePersistenceEmpiricalLaw(opts: { lookbackDays?: number; minSample?: number } = {}) {
  const params = new URLSearchParams();
  params.set('lookback_days', String(opts.lookbackDays ?? 30));
  params.set('min_sample', String(opts.minSample ?? 20));
  return useQuery({
    queryKey: ['persistence-empirical-law', opts.lookbackDays, opts.minSample],
    queryFn: () => apiFetch<EmpiricalLawResponse>(`/lisa/persistence-empirical-law?${params.toString()}`),
    refetchInterval: 5 * 60_000,
  });
}
