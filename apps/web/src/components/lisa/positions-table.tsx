'use client';

import { Briefcase, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { useLisaPositions, useLisaPositionsRealtime, type LisaPosition } from '@/hooks/use-lisa';
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

/**
 * PR #253 — Affiner le label `closed_target` selon `exitReason`.
 *
 * Avant : tous les exits vers `closed_target` affichaient « TP hit » dans
 * l'historique, qu'il s'agisse d'un vrai TP atteint (1.5%), d'un TP absolu
 * (2.5%/4%) ou d'un reactive RSI/MACD lock-in (≥0.5% pnl). Confusion user
 * qui voyait des "TP hit" à +0.68% au lieu des +1.5% configurés.
 *
 * Après : on parse `exitReason` pour distinguer 4 cas. Le statut DB reste
 * `closed_target` (pas de migration), seul le label UI change.
 */
function refineCloseLabel(
  status: LisaPosition['status'],
  exitReason: string | null | undefined,
): { label: string; color: string } {
  const base = STATUS_LABELS[status];
  if (!exitReason) return base;
  const r = exitReason.toLowerCase();

  // PR #256 — Reactive SL early-cut (cut losses tôt sur RSI+MACD bearish)
  if (status === 'closed_stop' && (r.includes('reactive sl') || r.includes('early-cut'))) {
    return { label: 'Reactive SL', color: 'bg-orange-50 text-orange-700 border-orange-200' };
  }

  if (status !== 'closed_target') return base;
  if (r.includes('take-profit absolu') || r.includes('take_profit_absolu') || r.includes('matérialisation gain')) {
    return { label: 'TP absolu', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' };
  }
  if (r.includes('take-profit atteint') || r.includes('target=')) {
    return { label: 'TP atteint', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  }
  if (r.includes('exit réactif') || r.includes('reactive')) {
    if (r.includes('rsi')) {
      return { label: 'Reactive RSI', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' };
    }
    if (r.includes('macd')) {
      return { label: 'Reactive MACD', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
    }
    return { label: 'Reactive', color: 'bg-violet-50 text-violet-700 border-violet-200' };
  }
  return base;
}

export function LisaPositionsTable({ portfolioId }: { portfolioId: string }) {
  // PR E — invalidation immédiate de la cache positions sur INSERT/UPDATE/DELETE
  // côté DB (le mécanique ouvre/ferme sans interaction UI).
  useLisaPositionsRealtime(portfolioId);
  const openQuery = useLisaPositions(portfolioId, true);
  const allQuery = useLisaPositions(portfolioId, false);

  const openRaw = openQuery.data ?? [];
  const all = allQuery.data ?? [];
  // Tri par entry_timestamp desc (plus récente en haut) pour voir l'activité Lisa
  const open = [...openRaw].sort(
    (a, b) => new Date(b.entryTimestamp).getTime() - new Date(a.entryTimestamp).getTime(),
  );
  const closed = all
    .filter((p) => p.status !== 'open')
    .sort((a, b) => {
      const ta = new Date(a.exitTimestamp ?? a.entryTimestamp).getTime();
      const tb = new Date(b.exitTimestamp ?? b.entryTimestamp).getTime();
      return tb - ta;
    });

  // Activité des dernières 24h pour voir si Lisa a bougé
  const since24h = Date.now() - 86_400_000;
  const openedLast24h = all.filter((p) => new Date(p.entryTimestamp).getTime() >= since24h).length;
  const closedLast24h = all.filter((p) => p.exitTimestamp && new Date(p.exitTimestamp).getTime() >= since24h).length;
  const lastActivity = all
    .map((p) => new Date(p.exitTimestamp ?? p.entryTimestamp).getTime())
    .reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Briefcase className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Positions simulées</h2>
        <span className="text-xs text-muted-foreground">
          ({open.length} ouvertes · {closed.length} fermées)
        </span>
        {all.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1.5">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">
              24h : +{openedLast24h} / −{closedLast24h}
            </span>
            {lastActivity > 0 && (
              <span>dernière activité {relativeAge(new Date(lastActivity).toISOString())}</span>
            )}
          </span>
        )}
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

function relativeAge(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'à l\'instant';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.round(h / 24);
  return `il y a ${d}j`;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// P0 hotfix #2 — fallback statut pour les valeurs DB inconnues du
// PROFILE_LABELS frontend. Évite le crash `.color`/`.label` sur undefined.
const UNKNOWN_STATUS_CFG = {
  label: 'Statut',
  color: 'bg-slate-50 text-slate-500 border-slate-200',
};

function PositionRow({ pos }: { pos: LisaPosition }) {
  // PR #253 — affine le label closed_target via exitReason.
  const statusCfg = pos.status
    ? refineCloseLabel(pos.status, pos.exitReason)
    : UNKNOWN_STATUS_CFG;
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
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span title={formatAbsolute(pos.entryTimestamp)}>
            Ouverte {relativeAge(pos.entryTimestamp)}
          </span>
          <span>·</span>
          <span className="font-mono">{formatAbsolute(pos.entryTimestamp)}</span>
          {pos.exitTimestamp && (
            <>
              <span>→</span>
              <span title={formatAbsolute(pos.exitTimestamp)}>
                Fermée {relativeAge(pos.exitTimestamp)}
              </span>
            </>
          )}
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
