'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type CapitalDisciplineMode = 'NONE' | 'DAILY_HARVEST';

export type HarvestState =
  | 'IDLE'
  | 'ACTIVE'
  | 'TARGET_NEAR'
  | 'TARGET_HIT'
  | 'PROFIT_SWEEP_PENDING'
  | 'PROFIT_SWEPT'
  | 'DAILY_LOCKED'
  | 'LOSS_LIMIT_HIT'
  | 'SESSION_CLOSED';

export type ProfitSweepMode = 'PER_TRADE' | 'END_OF_DAY';

export interface DailyHarvestConfig {
  dailyTargetAmountUsd?: number | null;
  dailyTargetPercent?: number | null;
  workingCapitalBaseUsd: number;
  maxCapitalAllocationUsd?: number;
  profitSweepMode: ProfitSweepMode;
  stopTradingWhenTargetHit: boolean;
  allowReentryAfterTargetHit: boolean;
  maxLossPerDayUsd?: number;
  maxTradesPerDay?: number;
  allowedInstruments?: string[];
  sessionStartTime: string;
  sessionEndTime: string;
  timezone: string;
  requiresHumanApprovalAboveUsd?: number;
  cooldownMinutesAfterClose: number;
  /** Take-profit absolu modifiable par user (défaut 2.5% en HARVEST).
   *  Si > 0, écrase la valeur hardcoded de mechanical-trading. */
  takeProfitAbsolutePct?: number;
}

export interface DailyTradingSession {
  id: string;
  portfolioId: string;
  sessionDate: string;
  sessionTimezone: string;
  state: HarvestState;
  workingCapitalStartUsd: string;
  realizedPnlTodayUsd: string;
  securedPnlTodayUsd: string;
  tradesCount: number;
  winningTradesCount: number;
  losingTradesCount: number;
  lastStateTransitionAt: string;
  lastStateTransitionReason: string | null;
}

export interface SecuredProfitBalance {
  portfolioId: string;
  totalSecuredUsd: string;
  sweepCount: number;
  firstSweepAt: string | null;
  lastSweepAt: string | null;
  largestSingleSweepUsd: string | null;
}

export interface DailyHarvestProgress {
  state: HarvestState;
  targetAmountUsd: number;
  realizedToday: number;
  securedToday: number;
  remainingToTarget: number;
  progressPct: number;
  tradesCount: number;
  tradesRemainingBeforeCap: number | null;
  lossRemainingBeforeLock: number | null;
  isLocked: boolean;
}

export interface CumulativeStats {
  daily: {
    realized: number;
    secured: number;
    tradesCount: number;
    winRate: number;
  };
  mtd: {
    realized: number;
    secured: number;
    tradesCount: number;
    sessionsCount: number;
    winningDays: number;
    losingDays: number;
  };
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
}

export interface DailyHarvestState {
  mode: CapitalDisciplineMode;
  config: DailyHarvestConfig | null;
  session: DailyTradingSession | null;
  vault: SecuredProfitBalance | null;
  progress: DailyHarvestProgress | null;
  cumulativeStats: CumulativeStats | null;
}

/** Lit l'état complet DAILY_HARVEST d'un portfolio. Refresh toutes les 30s. */
export function useDailyHarvest(portfolioId: string | null) {
  return useQuery({
    queryKey: ['daily-harvest', portfolioId],
    queryFn: () => apiFetch<DailyHarvestState>(`/lisa/daily-harvest/${portfolioId}`),
    enabled: !!portfolioId,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
}

/** Update la config DAILY_HARVEST. Mode='NONE' désactive. */
export function useUpdateDailyHarvestConfig(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { mode: CapitalDisciplineMode; config?: DailyHarvestConfig }) =>
      apiFetch<{ ok: true; mode: CapitalDisciplineMode }>(
        `/lisa/daily-harvest/${portfolioId}/config`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['daily-harvest', portfolioId] });
      qc.invalidateQueries({ queryKey: ['lisa-config', portfolioId] });
    },
  });
}

/** Sweep manuel — transfert d'un montant du capital vers le vault. */
export function useManualSweep(portfolioId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { amountUsd: number; reason?: string }) =>
      apiFetch<{ swept: number; remaining: number }>(
        `/lisa/daily-harvest/${portfolioId}/manual-sweep`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['daily-harvest', portfolioId] });
    },
  });
}
