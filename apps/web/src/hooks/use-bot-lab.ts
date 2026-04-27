'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type BotSourceType = 'csv_import' | 'api_external' | 'lisa_replay' | 'manual';

export interface BotDefinition {
  id: string;
  userId: string;
  portfolioId: string | null;
  name: string;
  description: string | null;
  sourceType: BotSourceType;
  capitalBaseUsd: string;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  tags: string[];
  totalTrades: number;
  totalRealizedPnlUsd: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotPaperTrade {
  id: string;
  botId: string;
  symbol: string;
  assetClass: string;
  direction: string;
  entryTimestamp: string;
  entryPrice: string;
  exitTimestamp: string | null;
  exitPrice: string | null;
  netPnlUsd: string | null;
  netPnlPct: number | null;
  marketRegime: string | null;
}

export interface BotDefinitionDraft {
  name: string;
  description?: string;
  sourceType: BotSourceType;
  capitalBaseUsd: number;
  startDate?: string;
  endDate?: string;
  tags?: string[];
}

/** Liste les bots de l'utilisateur. */
export function useBots(activeOnly = false) {
  return useQuery({
    queryKey: ['bot-lab', 'bots', activeOnly],
    queryFn: () => apiFetch<{ bots: BotDefinition[] }>(`/bot-lab/bots${activeOnly ? '?active_only=true' : ''}`),
  });
}

/** Récupère un bot. */
export function useBot(botId: string | null) {
  return useQuery({
    queryKey: ['bot-lab', 'bot', botId],
    queryFn: () => apiFetch<{ bot: BotDefinition }>(`/bot-lab/bots/${botId}`),
    enabled: !!botId,
  });
}

/** Liste les trades d'un bot. */
export function useBotTrades(botId: string | null, limit = 100) {
  return useQuery({
    queryKey: ['bot-lab', 'trades', botId, limit],
    queryFn: () => apiFetch<{ trades: BotPaperTrade[] }>(`/bot-lab/bots/${botId}/trades?limit=${limit}`),
    enabled: !!botId,
  });
}

/** Crée un bot. */
export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: BotDefinitionDraft) =>
      apiFetch<{ bot: BotDefinition }>('/bot-lab/bots', {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}

/** Supprime un bot. */
export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (botId: string) =>
      apiFetch<{ ok: true }>(`/bot-lab/bots/${botId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 2 — METRICS / EQUITY / COMPARE
// ═══════════════════════════════════════════════════════════════════

export interface BotPerformanceSummary {
  botId: string;
  totalTrades: number;
  totalDays: number;
  netPnlUsd: number;
  netReturnPct: number;
  cagr: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  maxDrawdownPct: number;
  recoveryDays: number | null;
  profitFactor: number | null;
  expectancyPerTradeUsd: number;
  winRatePct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  consecutiveWinsMax: number;
  consecutiveLossesMax: number;
}

export interface EquityCurvePoint {
  date: string;
  cumulativePnlUsd: number;
  equityValueUsd: number;
  dailyReturnPct: number | null;
  drawdownFromPeakPct: number;
  isNewPeak: boolean;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  totalCostsUsd: number;
}

export interface SessionMetrics {
  sessionKind: 'market_regime' | 'vix_bucket' | 'asset_class' | 'symbol' | 'time_of_day' | 'global';
  sessionValue: string;
  tradesCount: number;
  winRatePct: number;
  netPnlUsd: number;
  expectancyUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

export interface ComparatorEntry {
  botId: string;
  botName: string;
  summary: BotPerformanceSummary | null;
  byRegime: SessionMetrics[];
  byVixBucket: SessionMetrics[];
  byAssetClass: SessionMetrics[];
}

export function useBotMetrics(botId: string | null) {
  return useQuery({
    queryKey: ['bot-lab', 'metrics', botId],
    queryFn: () => apiFetch<{ summary: BotPerformanceSummary | null }>(`/bot-lab/bots/${botId}/metrics`),
    enabled: !!botId,
  });
}

export function useBotEquityCurve(botId: string | null) {
  return useQuery({
    queryKey: ['bot-lab', 'equity', botId],
    queryFn: () => apiFetch<{ curve: EquityCurvePoint[] }>(`/bot-lab/bots/${botId}/equity-curve`),
    enabled: !!botId,
  });
}

export function useBotSessionMetrics(botId: string | null) {
  return useQuery({
    queryKey: ['bot-lab', 'sessions', botId],
    queryFn: () => apiFetch<{ sessions: SessionMetrics[] }>(`/bot-lab/bots/${botId}/sessions`),
    enabled: !!botId,
  });
}

export function useRecomputeBot(botId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ tagged: number; totalTrades: number; daysGenerated: number; finalEquity: number; finalCumulPnl: number }>(
        `/bot-lab/bots/${botId}/recompute`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'metrics', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'equity', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'sessions', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}

export function useCompareBots(botIds: string[]) {
  return useQuery({
    queryKey: ['bot-lab', 'compare', botIds],
    queryFn: () => apiFetch<{ entries: ComparatorEntry[] }>(`/bot-lab/compare?botIds=${botIds.join(',')}`),
    enabled: botIds.length > 0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3 — PATTERNS
// ═══════════════════════════════════════════════════════════════════

export type PatternKind = 'entry_setup' | 'exit_rule' | 'risk_management' | 'regime_filter' | 'time_filter';
export type PatternStatus = 'candidate' | 'validated' | 'rejected' | 'deprecated';

export interface BotPattern {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  pattern_kind: PatternKind;
  source_bot_ids: string[];
  conditions: Record<string, unknown>;
  action_signal: Record<string, unknown> | null;
  observation_count: number;
  win_rate_pct: number | null;
  expectancy_usd: string | null;
  robustness_score: number | null;
  composite_score: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  status: PatternStatus;
  created_at: string;
  updated_at: string;
}

export function usePatterns(status?: PatternStatus) {
  return useQuery({
    queryKey: ['bot-lab', 'patterns', status ?? 'all'],
    queryFn: () => apiFetch<{ patterns: BotPattern[] }>(`/bot-lab/patterns${status ? `?status=${status}` : ''}`),
  });
}

export function useMinePatterns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ minedCount: number; createdCount: number; updatedCount: number }>(
        '/bot-lab/patterns/mine',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'patterns'] });
    },
  });
}

/** Importe un CSV de trades. */
export function useImportCsv(botId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) =>
      apiFetch<{ inserted: number; skipped: number; errors: number; totalParsed: number }>(
        `/bot-lab/bots/${botId}/import-csv`,
        { method: 'POST', body: JSON.stringify({ csv }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bot', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'trades', botId] });
      qc.invalidateQueries({ queryKey: ['bot-lab', 'bots'] });
    },
  });
}
