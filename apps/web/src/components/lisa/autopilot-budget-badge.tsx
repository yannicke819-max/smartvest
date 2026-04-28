'use client';

import { AlertTriangle, DollarSign, PauseCircle } from 'lucide-react';
import { useAutopilotCostStatus } from '@/hooks/use-autopilot-cost-status';

/**
 * P8-BR — Badge mini-widget « Budget API: $X / $Y » + raison de pause.
 *
 * Couleur :
 *  - vert  : pct < 60%
 *  - ambre : pct ∈ [60%, 90%[
 *  - rouge : pct ≥ 90% ou paused_reason présent
 *
 * Affiche aussi `paused_reason` (BUDGET_EXCEEDED, MANUAL, PROVIDER_OUTAGE)
 * et la prochaine heure de reset UTC quand pertinent.
 */
export function AutopilotBudgetBadge({ portfolioId }: { portfolioId: string }) {
  const q = useAutopilotCostStatus(portfolioId);
  const data = q.data;

  if (!data) {
    return (
      <div className="text-[11px] text-muted-foreground italic">
        Coût API : chargement…
      </div>
    );
  }

  const { daily_used_usd, daily_budget_usd, pct, paused_reason } = data;
  const colorClass = paused_reason
    ? 'border-red-500 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
    : pct == null
      ? 'border-muted-foreground/30 bg-background text-muted-foreground'
      : pct >= 0.9
        ? 'border-red-500 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
        : pct >= 0.6
          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500'
          : 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400';

  const Icon = paused_reason ? PauseCircle : DollarSign;

  const label = daily_budget_usd != null
    ? `$${daily_used_usd.toFixed(2)} / $${daily_budget_usd.toFixed(2)}`
    : `$${daily_used_usd.toFixed(2)} (no budget)`;

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${colorClass}`}>
      <Icon className="h-3 w-3" />
      <span>API {label}</span>
      {pct != null && !paused_reason && (
        <span className="opacity-70">· {(pct * 100).toFixed(0)}%</span>
      )}
      {paused_reason && (
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          <span>Paused: {pausedLabel(paused_reason)}</span>
        </span>
      )}
    </div>
  );
}

function pausedLabel(reason: string): string {
  if (reason === 'BUDGET_EXCEEDED') return 'budget';
  if (reason === 'MANUAL') return 'manuel';
  if (reason === 'PROVIDER_OUTAGE') return 'provider';
  return reason;
}
