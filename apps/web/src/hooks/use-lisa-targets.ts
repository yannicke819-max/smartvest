// LISA refonte Phase A.3 — Targets + reset markers + stats par scope
//
// Hook utilitaire pour la section Gains : lit les cibles depuis lisa_session_configs
// (colonnes lisa_target_*_usd et lisa_target_*_pct, migration 0173), calcule
// la cible effective Mode C = MAX(usd plancher, pct × current_capital), et
// expose les stats P&L filtrées par scope + reset marker (migration 0174).

import { useMemo } from 'react';
import { useLisaConfig, useUpsertLisaConfig, useLisaPositions, type LisaPosition } from './use-lisa';

export type LisaScope = 'daily' | 'weekly' | 'monthly' | 'annual';

export interface LisaTargets {
  daily: { usd: number; pct: number; effective: number };
  monthly: { usd: number; pct: number; effective: number };
  annual: { usd: number; pct: number; effective: number };
}

export interface LisaScopeStats {
  realized_pnl_usd: number;
  trades_count: number;
  wins: number;
  losses: number;
  win_rate_pct: number | null;
  target_effective_usd: number;
  pct_of_target: number;
  reset_marker_at: string | null;
}

/**
 * Calcule le capital actuel : initial + Σ realized_pnl (si compound activé).
 */
export function computeCurrentCapital(
  initialUsd: number,
  positions: LisaPosition[],
  compoundEnabled: boolean,
): number {
  if (!compoundEnabled) return initialUsd;
  const realized = positions.reduce(
    (sum, p) => sum + (parseFloat(p.realizedPnlUsd ?? '0') || 0),
    0,
  );
  return initialUsd + realized;
}

/**
 * Calcule la cible effective Mode C pour un scope donné = MAX(usd, pct × capital).
 */
export function computeEffectiveTarget(
  usdFloor: number,
  pct: number,
  currentCapital: number,
): number {
  return Math.max(usdFloor, (pct / 100) * currentCapital);
}

/**
 * Retourne le timestamp ISO de début pour un scope donné (UTC).
 *  - daily   : 00:00 UTC du jour courant
 *  - weekly  : lundi 00:00 UTC de la semaine courante
 *  - monthly : 1er du mois 00:00 UTC
 *  - annual  : 1er janvier 00:00 UTC
 *
 * Si un reset_marker est défini, retourne le marker (= override le début de période).
 */
export function scopeStartIso(scope: LisaScope, resetMarker: string | null): string {
  if (resetMarker) return resetMarker;
  const now = new Date();
  switch (scope) {
    case 'daily': {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return d.toISOString();
    }
    case 'weekly': {
      const d = new Date(now);
      const day = d.getUTCDay(); // 0 = sunday
      const diff = day === 0 ? 6 : day - 1; // lundi = 0
      d.setUTCDate(d.getUTCDate() - diff);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case 'monthly': {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return d.toISOString();
    }
    case 'annual': {
      const d = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return d.toISOString();
    }
  }
}

/**
 * Hook principal — retourne les cibles effectives + stats par scope pour TRADER.
 */
export function useLisaTargetsAndStats(portfolioId: string | null) {
  const configQuery = useLisaConfig(portfolioId);
  const positionsQuery = useLisaPositions(portfolioId, false); // all positions, not just open

  const result = useMemo(() => {
    const config = configQuery.data as Record<string, unknown> | null;
    const positions = (positionsQuery.data ?? []) as LisaPosition[];

    if (!config) {
      return {
        targets: null, stats: null, currentCapital: null,
        initialCapital: null, drawdownFromInitialPct: null, killSwitchActive: false,
        isLoading: true,
      };
    }

    const initialCapital = Number(config.lisa_initial_capital_usd ?? 10000);
    const compoundEnabled = Boolean(config.lisa_compound_pnl_enabled ?? true);
    const killSwitchActive = Boolean(config.kill_switch_active ?? false);

    // Compute current capital from closed positions
    const closedPositions = positions.filter((p) => p.status !== 'open');
    const currentCapital = computeCurrentCapital(initialCapital, closedPositions, compoundEnabled);
    const drawdownFromInitialPct =
      initialCapital > 0 ? ((currentCapital - initialCapital) / initialCapital) * 100 : 0;

    // Build targets Mode C (MAX usd, pct × capital)
    const targets: LisaTargets = {
      daily: {
        usd: Number(config.lisa_target_daily_usd ?? 200),
        pct: Number(config.lisa_target_daily_pct ?? 2),
        effective: computeEffectiveTarget(
          Number(config.lisa_target_daily_usd ?? 200),
          Number(config.lisa_target_daily_pct ?? 2),
          currentCapital,
        ),
      },
      monthly: {
        usd: Number(config.lisa_target_monthly_usd ?? 4000),
        pct: Number(config.lisa_target_monthly_pct ?? 20),
        effective: computeEffectiveTarget(
          Number(config.lisa_target_monthly_usd ?? 4000),
          Number(config.lisa_target_monthly_pct ?? 20),
          currentCapital,
        ),
      },
      annual: {
        usd: Number(config.lisa_target_annual_usd ?? 50000),
        pct: Number(config.lisa_target_annual_pct ?? 100),
        effective: computeEffectiveTarget(
          Number(config.lisa_target_annual_usd ?? 50000),
          Number(config.lisa_target_annual_pct ?? 100),
          currentCapital,
        ),
      },
    };

    // Stats par scope avec reset markers
    const buildStats = (scope: LisaScope, target: number): LisaScopeStats => {
      const resetMarker = (config[`lisa_reset_marker_${scope === 'weekly' ? 'daily' : scope}`] as string | null) ?? null;
      const startIso = scopeStartIso(scope, resetMarker);
      const inScope = closedPositions.filter(
        (p) => p.exitTimestamp != null && p.exitTimestamp >= startIso,
      );
      const realized = inScope.reduce(
        (s, p) => s + (parseFloat(p.realizedPnlUsd ?? '0') || 0),
        0,
      );
      const wins = inScope.filter((p) => parseFloat(p.realizedPnlUsd ?? '0') > 0).length;
      const losses = inScope.filter((p) => parseFloat(p.realizedPnlUsd ?? '0') < 0).length;
      const total = inScope.length;
      return {
        realized_pnl_usd: realized,
        trades_count: total,
        wins,
        losses,
        win_rate_pct: total > 0 ? (wins / total) * 100 : null,
        target_effective_usd: target,
        pct_of_target: target > 0 ? (realized / target) * 100 : 0,
        reset_marker_at: resetMarker,
      };
    };

    const stats = {
      daily: buildStats('daily', targets.daily.effective),
      weekly: buildStats('weekly', targets.daily.effective * 5),
      monthly: buildStats('monthly', targets.monthly.effective),
      annual: buildStats('annual', targets.annual.effective),
    };

    return {
      targets, stats, currentCapital,
      initialCapital, drawdownFromInitialPct, killSwitchActive,
      isLoading: false,
    };
  }, [configQuery.data, positionsQuery.data]);

  return {
    ...result,
    isLoading: configQuery.isLoading || positionsQuery.isLoading || result.isLoading,
    isError: configQuery.isError || positionsQuery.isError,
  };
}

/**
 * Mutation pour reset l'affichage d'un scope (set marker = NOW).
 */
export function useResetScopeMarker(portfolioId: string) {
  const upsert = useUpsertLisaConfig(portfolioId);
  return {
    resetDaily: () =>
      upsert.mutateAsync({ lisa_reset_marker_daily: new Date().toISOString() } as Record<string, unknown>),
    resetMonthly: () =>
      upsert.mutateAsync({
        lisa_reset_marker_monthly: new Date().toISOString(),
        lisa_reset_marker_daily: new Date().toISOString(), // cascade
      } as Record<string, unknown>),
    resetAnnual: () =>
      upsert.mutateAsync({
        lisa_reset_marker_annual: new Date().toISOString(),
        lisa_reset_marker_monthly: new Date().toISOString(),
        lisa_reset_marker_daily: new Date().toISOString(),
      } as Record<string, unknown>),
    cancelReset: (scope: 'daily' | 'monthly' | 'annual') =>
      upsert.mutateAsync({ [`lisa_reset_marker_${scope}`]: null } as Record<string, unknown>),
    isLoading: upsert.isPending,
  };
}

/**
 * Mutation pour update les cibles user (Mode C : usd + pct).
 */
export function useUpdateLisaTargets(portfolioId: string) {
  const upsert = useUpsertLisaConfig(portfolioId);
  return {
    updateTargets: (partial: Partial<LisaTargets>) => {
      const payload: Record<string, unknown> = {};
      if (partial.daily?.usd !== undefined) payload.lisa_target_daily_usd = partial.daily.usd;
      if (partial.daily?.pct !== undefined) payload.lisa_target_daily_pct = partial.daily.pct;
      if (partial.monthly?.usd !== undefined) payload.lisa_target_monthly_usd = partial.monthly.usd;
      if (partial.monthly?.pct !== undefined) payload.lisa_target_monthly_pct = partial.monthly.pct;
      if (partial.annual?.usd !== undefined) payload.lisa_target_annual_usd = partial.annual.usd;
      if (partial.annual?.pct !== undefined) payload.lisa_target_annual_pct = partial.annual.pct;
      return upsert.mutateAsync(payload);
    },
    isLoading: upsert.isPending,
  };
}
