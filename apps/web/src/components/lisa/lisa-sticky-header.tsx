'use client';

/**
 * LisaStickyHeader — header sticky en haut de /lisa.
 *
 * Toujours visible scroll, affiche :
 *   - Brand 🤖 LISA
 *   - Cible jour effective
 *   - Σ TODAY badge (P&L réalisé jour)
 *
 * Responsive : compact sur mobile, expanded sur desktop.
 */

import { useLisaTargetsAndStats } from '@/hooks/use-lisa-targets';
import { NotificationsBell } from './notifications-bell';

interface Props {
  portfolioId: string;
}

export function LisaStickyHeader({ portfolioId }: Props) {
  const {
    targets, stats, currentCapital, drawdownFromInitialPct, killSwitchActive, isLoading,
  } = useLisaTargetsAndStats(portfolioId);

  if (isLoading || !stats || !targets) {
    return (
      <div className="sticky top-0 z-30 bg-card/80 backdrop-blur border-b py-2 px-4">
        <div className="animate-pulse h-6 bg-muted rounded w-32" />
      </div>
    );
  }

  // LISA refonte A.4.1 — Bandeau anti-spirale si kill_switch_active=true.
  // Backend arme kill_switch_active dans lisa_session_configs quand drawdown
  // depuis capital initial < -30%. UI affiche bandeau rouge non-dismissible :
  // l'utilisateur doit aller dans la config pour reset manuellement (à wirer
  // dans la section Config Phase B.3).
  if (killSwitchActive) {
    return (
      <div className="sticky top-0 z-30 bg-rose-600 dark:bg-rose-700 text-white border-b py-3 px-4 shadow-md">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xl">🛑</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm">
              Kill-switch anti-spirale activé
            </div>
            <div className="text-xs opacity-90 mt-0.5">
              Drawdown {drawdownFromInitialPct !== null ? drawdownFromInitialPct.toFixed(1) : '—'}% depuis capital initial.
              TRADER suspendu. Reset manuel requis dans Config LISA.
            </div>
          </div>
          <NotificationsBell portfolioId={portfolioId} />
        </div>
      </div>
    );
  }

  const pnlToday = stats.daily.realized_pnl_usd;
  const pnlColor =
    pnlToday > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : pnlToday < 0
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-muted-foreground';
  const sign = pnlToday >= 0 ? '+' : '';

  return (
    <div className="sticky top-0 z-30 bg-card/90 backdrop-blur border-b py-2 px-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <span className="text-base">🤖</span>
          <span className="font-semibold text-sm">LISA</span>
          <span className="hidden md:inline text-[10px] text-muted-foreground">
            Agent autonome LISA
          </span>
          <NotificationsBell portfolioId={portfolioId} />
        </div>

        {/* Capital + Cible + PnL today */}
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {/* LISA refonte A.4 — Capital actuel (composé) visible toujours */}
          <div className="hidden md:flex items-center gap-1.5">
            <span className="text-muted-foreground">💰</span>
            <span className="font-medium tabular-nums">
              ${currentCapital !== null ? currentCapital.toFixed(0) : '—'}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1.5">
            <span className="text-muted-foreground">🎯</span>
            <span className="font-medium">${targets.daily.effective.toFixed(0)}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Σ today :</span>
            <span className={`font-semibold tabular-nums ${pnlColor}`}>
              {sign}${Math.abs(pnlToday).toFixed(2)}
            </span>
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              ({stats.daily.pct_of_target.toFixed(0)}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
