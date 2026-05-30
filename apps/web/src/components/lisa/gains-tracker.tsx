'use client';

/**
 * GainsTracker — Section "Gains" cœur de la refonte page /lisa.
 *
 * 4 cards (JOUR / SEMAINE / MOIS / ANNÉE) avec :
 *   - PnL réalisé sur le scope (filtré par reset_marker éventuel)
 *   - Cible effective Mode C (= MAX(usd plancher, pct × capital))
 *   - Barre progressive % de la cible atteinte
 *   - Stats W/L/WR
 *   - Bouton Reset display-only (modal "tape RESET" pour confirmer)
 *
 * Desktop : grid 4 col horizontal · Mobile : 1 card swipeable.
 *
 * Reset = stocke timestamp dans lisa_session_configs.lisa_reset_marker_*.
 * Jamais d'effacement DB — uniquement filtre d'affichage côté UI.
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  useLisaTargetsAndStats,
  useResetScopeMarker,
  type LisaScopeStats,
  type LisaScope,
} from '@/hooks/use-lisa-targets';
import { GainsTargetEditor } from './gains-target-editor';
import { GainsResetConfirmModal } from './gains-reset-confirm-modal';

interface Props {
  portfolioId: string;
}

const SCOPE_LABELS: Record<LisaScope, { short: string; long: string; period: string }> = {
  daily: { short: 'JOUR', long: 'Jour', period: 'aujourd\'hui' },
  weekly: { short: 'SEMAINE', long: 'Semaine', period: 'cette semaine' },
  monthly: { short: 'MOIS', long: 'Mois', period: 'ce mois' },
  annual: { short: 'ANNÉE', long: 'Année', period: 'cette année' },
};

function formatPnl(v: number): { display: string; sign: '+' | '-' | '0' } {
  if (v === 0) return { display: '$0.00', sign: '0' };
  const sign = v > 0 ? '+' : '-';
  return { display: `${sign}$${Math.abs(v).toFixed(2)}`, sign: v > 0 ? '+' : '-' };
}

function ScopeCard({
  scope,
  stats,
  onReset,
  resetting,
}: {
  scope: LisaScope;
  stats: LisaScopeStats;
  onReset: () => void;
  resetting: boolean;
}) {
  const labels = SCOPE_LABELS[scope];
  const { display, sign } = formatPnl(stats.realized_pnl_usd);
  const colorClass =
    sign === '+'
      ? 'text-emerald-600 dark:text-emerald-400'
      : sign === '-'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-muted-foreground';
  const pct = Math.max(0, Math.min(100, stats.pct_of_target));
  const showReset = scope !== 'weekly';
  const canReset = stats.realized_pnl_usd !== 0 || stats.trades_count > 0 || stats.reset_marker_at !== null;

  return (
    <Card className="p-4 flex flex-col gap-2 min-h-[180px]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground">
          {labels.short}
        </span>
        {stats.reset_marker_at && (
          <span
            className="text-[10px] text-amber-600 dark:text-amber-400"
            title={`Reset le ${new Date(stats.reset_marker_at).toLocaleString('fr-FR')}`}
          >
            ↺ reset
          </span>
        )}
      </div>

      <div className={`text-2xl font-semibold tabular-nums ${colorClass}`}>
        {display}
      </div>

      <div className="text-[10px] text-muted-foreground">
        Cible {labels.period} : ${stats.target_effective_usd.toFixed(0)}
      </div>

      {/* Progress bar */}
      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-full transition-all ${
            sign === '+' ? 'bg-emerald-500' : 'bg-rose-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        {pct.toFixed(0)}% atteint
      </div>

      {stats.trades_count > 0 && (
        <div className="text-[10px] text-muted-foreground mt-auto">
          {stats.wins}W / {stats.losses}L · WR{' '}
          {stats.win_rate_pct !== null ? `${stats.win_rate_pct.toFixed(0)}%` : '—'}
        </div>
      )}

      {showReset && canReset && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={resetting}
          className="text-[11px] h-7 mt-1"
        >
          🔄 Reset {labels.long.toLowerCase()}
        </Button>
      )}
    </Card>
  );
}

export function GainsTracker({ portfolioId }: Props) {
  const { targets, stats, currentCapital, isLoading } = useLisaTargetsAndStats(portfolioId);
  const reset = useResetScopeMarker(portfolioId);

  const [editingTargets, setEditingTargets] = useState(false);
  const [resetScope, setResetScope] = useState<'daily' | 'monthly' | 'annual' | null>(null);
  const [mobileScopeIdx, setMobileScopeIdx] = useState(0);

  if (isLoading || !stats || !targets) {
    return (
      <Card className="p-4">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-muted rounded w-1/3" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-muted rounded" />
            ))}
          </div>
        </div>
      </Card>
    );
  }

  const mobileScope = (['daily', 'weekly', 'monthly', 'annual'] as LisaScope[])[mobileScopeIdx];

  const handleReset = async (scope: 'daily' | 'monthly' | 'annual') => {
    if (scope === 'daily') await reset.resetDaily();
    else if (scope === 'monthly') await reset.resetMonthly();
    else if (scope === 'annual') await reset.resetAnnual();
    setResetScope(null);
  };

  return (
    <Card className="p-4 space-y-3">
      {/* Header avec cible jour + édition */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-semibold">🎯 Cible jour :</span>
          <span className="text-muted-foreground">
            MAX(${targets.daily.usd.toFixed(0)}, {targets.daily.pct}% × $
            {currentCapital?.toFixed(2)}) ={' '}
            <span className="text-foreground font-medium">
              ${targets.daily.effective.toFixed(0)}
            </span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditingTargets(true)}
          className="text-xs h-7"
        >
          ✏️ Modifier objectifs
        </Button>
      </div>

      {/* Desktop : 4 cards */}
      <div className="hidden md:grid md:grid-cols-4 gap-3">
        <ScopeCard
          scope="daily"
          stats={stats.daily}
          onReset={() => setResetScope('daily')}
          resetting={reset.isLoading}
        />
        <ScopeCard
          scope="weekly"
          stats={stats.weekly}
          onReset={() => {}}
          resetting={false}
        />
        <ScopeCard
          scope="monthly"
          stats={stats.monthly}
          onReset={() => setResetScope('monthly')}
          resetting={reset.isLoading}
        />
        <ScopeCard
          scope="annual"
          stats={stats.annual}
          onReset={() => setResetScope('annual')}
          resetting={reset.isLoading}
        />
      </div>

      {/* Mobile : 1 card swipeable + dots */}
      <div className="md:hidden">
        <div className="flex items-center gap-2 mb-2 justify-center">
          <button
            type="button"
            onClick={() => setMobileScopeIdx((i) => (i + 3) % 4)}
            className="text-muted-foreground p-1"
            aria-label="Précédent"
          >
            ⏴
          </button>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${
                  mobileScopeIdx === i ? 'bg-foreground' : 'bg-muted'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMobileScopeIdx((i) => (i + 1) % 4)}
            className="text-muted-foreground p-1"
            aria-label="Suivant"
          >
            ⏵
          </button>
        </div>
        <ScopeCard
          scope={mobileScope}
          stats={stats[mobileScope]}
          onReset={() =>
            mobileScope !== 'weekly' && setResetScope(mobileScope as 'daily' | 'monthly' | 'annual')
          }
          resetting={reset.isLoading}
        />
      </div>

      {/* Modals */}
      {editingTargets && targets && currentCapital !== null && (
        <GainsTargetEditor
          portfolioId={portfolioId}
          targets={targets}
          currentCapital={currentCapital}
          onClose={() => setEditingTargets(false)}
        />
      )}

      {resetScope && (
        <GainsResetConfirmModal
          scope={resetScope}
          onConfirm={() => handleReset(resetScope)}
          onCancel={() => setResetScope(null)}
        />
      )}
    </Card>
  );
}
