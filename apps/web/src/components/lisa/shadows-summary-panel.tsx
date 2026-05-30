'use client';

/**
 * ShadowsSummaryPanel — comparaison read-only TRADER vs HIGH/MIDDLE/SMALL.
 *
 * Affiche 3 cards (1 par shadow portfolio) avec :
 *   - Capital actuel (initial + Σ pnl) + return %
 *   - PnL jour + W/L + win-rate jour
 *   - Positions ouvertes (count + symbols)
 *   - Stats all-time (trades / WR)
 *   - Badge kill-switch si armé
 *
 * Mobile : grid 1 col stacked. Desktop : 3 col horizontal.
 * Polling 60s.
 */

import { Card } from '@/components/ui/card';
import { useShadowsSummary, type ShadowSummaryRow } from '@/hooks/use-shadows-summary';

function fmtPnl(v: number): { txt: string; cls: string } {
  if (v === 0) return { txt: '$0.00', cls: 'text-muted-foreground' };
  const sign = v > 0 ? '+' : '-';
  return {
    txt: `${sign}$${Math.abs(v).toFixed(2)}`,
    cls: v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
  };
}

function fmtPct(v: number | null): { txt: string; cls: string } {
  if (v === null) return { txt: '—', cls: 'text-muted-foreground' };
  return {
    txt: `${v.toFixed(0)}%`,
    cls: v >= 50 ? 'text-emerald-600 dark:text-emerald-400'
      : v >= 35 ? 'text-amber-600 dark:text-amber-400'
      : 'text-rose-600 dark:text-rose-400',
  };
}

function ShadowCard({ shadow }: { shadow: ShadowSummaryRow }) {
  const todayPnl = fmtPnl(shadow.today.pnl_usd);
  const cumPnl = fmtPnl(shadow.cumulative_pnl_usd);
  const todayWR = fmtPct(shadow.today.win_rate_pct);
  const allWR = fmtPct(shadow.all_time.win_rate_pct);
  const retCls = shadow.return_from_inception_pct >= 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400';

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${shadow.kill_switch_active ? 'border-rose-400 bg-rose-50/40 dark:bg-rose-950/20' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-bold">
            {shadow.label}
          </span>
          {shadow.kill_switch_active && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-600 text-white font-semibold">🛑 KILLED</span>
          )}
        </div>
        <span className={`text-xs font-semibold ${retCls} tabular-nums`}>
          {shadow.return_from_inception_pct >= 0 ? '+' : ''}{shadow.return_from_inception_pct.toFixed(2)}%
        </span>
      </div>

      {/* Capital line */}
      <div className="text-xs">
        <span className="text-muted-foreground">Capital</span>{' '}
        <span className="font-semibold tabular-nums">${shadow.current_capital_usd.toFixed(0)}</span>
        <span className={`ml-1 ${cumPnl.cls} text-[11px]`}>({cumPnl.txt})</span>
      </div>

      {/* Today metrics */}
      <div className="rounded bg-muted/40 p-2 text-[11px] space-y-0.5">
        <div className="flex justify-between">
          <span className="text-muted-foreground">P&amp;L jour (réalisé)</span>
          <span className={`font-semibold tabular-nums ${todayPnl.cls}`}>{todayPnl.txt}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Net après frais</span>
          <span className={`tabular-nums ${fmtPnl(shadow.today.net_pnl_after_fees_usd).cls}`}>
            {fmtPnl(shadow.today.net_pnl_after_fees_usd).txt}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Trades</span>
          <span className="tabular-nums">
            {shadow.today.trades} ({shadow.today.wins}W/{shadow.today.losses}L · <span className={todayWR.cls}>{todayWR.txt}</span>)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Cible $200/j</span>
          <span className="tabular-nums">{shadow.today.target_progress_pct.toFixed(0)}%</span>
        </div>
      </div>

      {/* Open positions */}
      <div className="text-[11px]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Ouvertes</span>
          <span className="tabular-nums font-medium">
            {shadow.open_positions} · ${shadow.deployed_usd.toFixed(0)}
          </span>
        </div>
        {shadow.open_symbols.length > 0 && (
          <div className="text-[10px] text-muted-foreground truncate mt-0.5">
            {shadow.open_symbols.join(' · ')}
          </div>
        )}
      </div>

      {/* All-time footer */}
      <div className="text-[10px] text-muted-foreground border-t pt-1.5">
        All-time : {shadow.all_time.trades} trades · WR <span className={allWR.cls}>{allWR.txt}</span>
      </div>
    </div>
  );
}

export function ShadowsSummaryPanel() {
  const { data, isLoading, isError } = useShadowsSummary();

  return (
    <Card className="p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          🥽 Shadow Sizing — comparatif HIGH / MIDDLE / SMALL
        </h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Portfolios système A/B (read-only). Comparer la perf des 3 profils de sizing vs TRADER pour calibrer le sizing optimal.
        </p>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse h-40 bg-muted rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <div className="text-xs text-rose-600 dark:text-rose-400 py-2">
          Erreur de chargement des shadows.
        </div>
      )}

      {!isLoading && data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {data.shadows.map((s) => (
            <ShadowCard key={s.id} shadow={s} />
          ))}
        </div>
      )}

      {data && data.shadows[0]?.snapshot_at && (
        <div className="text-[10px] text-muted-foreground mt-2 text-right">
          Snapshot shadow {new Date(data.shadows[0].snapshot_at).toLocaleTimeString('fr-FR')} ·
          refresh client 60s · données 5min cycle backend
        </div>
      )}
    </Card>
  );
}
