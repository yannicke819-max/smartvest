'use client';

import { Briefcase, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { useLisaPositions, type LisaPosition } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

const STATUS_LABELS: Record<LisaPosition['status'], { label: string; color: string }> = {
  open: { label: 'Ouverte', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  closed_target: { label: 'TP hit', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  closed_stop: { label: 'SL hit', color: 'bg-red-50 text-red-700 border-red-200' },
  closed_invalidated: { label: 'Invalidée', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  closed_user: { label: 'Fermée user', color: 'bg-slate-50 text-slate-700 border-slate-200' },
  closed_kill: { label: 'Kill switch', color: 'bg-red-100 text-red-800 border-red-300' },
  closed_expired: { label: 'Expirée', color: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export function LisaPositionsTable({ portfolioId }: { portfolioId: string }) {
  const openQuery = useLisaPositions(portfolioId, true);
  const allQuery = useLisaPositions(portfolioId, false);

  const open = openQuery.data ?? [];
  const all = allQuery.data ?? [];
  const closed = all.filter((p) => p.status !== 'open');

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Briefcase className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Positions simulées</h2>
        <span className="text-xs text-muted-foreground">
          ({open.length} ouvertes · {closed.length} fermées)
        </span>
      </div>

      {openQuery.isLoading && <SkeletonCard />}

      {!openQuery.isLoading && open.length === 0 && closed.length === 0 && (
        <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          Aucune position simulée pour l'instant.
        </div>
      )}

      {open.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-2 text-emerald-700">Ouvertes</p>
          <div className="space-y-2">
            {open.map((p) => <PositionRow key={p.id} pos={p} />)}
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-2 text-muted-foreground">Historique (10 dernières)</p>
          <div className="space-y-2">
            {closed.slice(0, 10).map((p) => <PositionRow key={p.id} pos={p} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function PositionRow({ pos }: { pos: LisaPosition }) {
  const statusCfg = STATUS_LABELS[pos.status];
  const pnl = pos.realizedPnlUsd ? parseFloat(pos.realizedPnlUsd) : null;
  const pnlPct = pos.realizedPnlPct;
  const pnlColor = pnl === null ? '' : pnl >= 0 ? 'text-emerald-600' : 'text-red-500';

  return (
    <div className="rounded border p-3 flex items-start justify-between gap-3 text-xs">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`rounded-full border px-2 py-0.5 font-medium ${statusCfg.color}`}>
            {statusCfg.label}
          </span>
          <span className="font-semibold">{pos.direction.toUpperCase()} {pos.symbol}</span>
          <span className="text-muted-foreground">{pos.assetClass}</span>
          <span className="text-muted-foreground">· {pos.venue}</span>
        </div>
        <div className="mt-1 text-muted-foreground">
          Qty {parseFloat(pos.quantity).toFixed(4)} @ entrée {parseFloat(pos.entryPrice).toFixed(4)}
          {' '}→ {pos.exitPrice ? `sortie ${parseFloat(pos.exitPrice).toFixed(4)}` : 'en cours'}
        </div>
        {pos.exitReason && (
          <div className="mt-1 text-muted-foreground italic flex items-start gap-1">
            <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
            {pos.exitReason}
          </div>
        )}
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-muted-foreground text-[10px]">Notionnel</div>
        <div className="font-medium">{parseFloat(pos.entryNotionalUsd).toFixed(0)} USD</div>
        {pnl !== null && pnlPct !== null && (
          <div className={`mt-1 font-semibold ${pnlColor} flex items-center gap-0.5 justify-end`}>
            {pnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
          </div>
        )}
      </div>
    </div>
  );
}
