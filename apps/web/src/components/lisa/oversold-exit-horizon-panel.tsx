'use client';

import { TrendingUp } from 'lucide-react';
import { useOversoldExitHorizon } from '@/hooks/use-oversold-exit-horizon';

/**
 * « Meilleur jour de sortie » v2 — POPULATION COMPLÈTE (J → J+10).
 * Pour TOUTES les entrées oversold (perdantes incluses — biais de survie éliminé) :
 * lock = P&L réalisé des positions fermées ; J+N = rendement si on avait tenu N jours
 * ouvrés (fwd_return du labeler). La v1 (gagnantes verrouillées only) faisait croire
 * à des pics J+3/J+6 — verdict population complète : le lock bat tous les horizons.
 * MESURE SEULE : n'influence aucun trade.
 */
export function OversoldExitHorizonPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldExitHorizon(portfolioId);

  if (isLoading) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">📈 Chargement du meilleur jour de sortie…</div>;
  }
  if (isError || !data) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">📈 Meilleur jour de sortie indisponible pour le moment.</div>;
  }
  if (!data.n) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📈 Pas encore d&apos;entrées — le tableau se peuple avec les trades oversold.
      </div>
    );
  }

  const fmt = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const cls = (x: number | null) => (x == null ? '' : x >= 0 ? 'text-emerald-600' : 'text-red-600');
  const uplift = data.upliftBestHoldVsLockPct;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-blue-600" />
        <h2 className="text-sm font-medium">📈 Meilleur jour de sortie — population complète (J → J+10)</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        TOUTES les entrées ({data.n}), perdantes incluses — pas seulement les gains verrouillés. Lock = P&L réellement encaissé ; J+N = ce qu&apos;aurait donné tenir N jours ouvrés. Mesure seule.
      </p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Tile label="Meilleur jour (moyenne)" value={data.bestDayByMean ?? '—'} />
        <Tile label="Meilleur jour (médiane)" value={data.bestDayByMedian ?? '—'} />
      </div>

      {uplift != null && data.bestHoldLabel && (
        <div className={`text-xs rounded-md p-2 ${uplift > 0.5 ? 'bg-amber-50' : 'bg-emerald-50'}`}>
          Meilleur hold ({data.bestHoldLabel}) vs lock : <span className={cls(uplift)}><b>{fmt(uplift)}</b></span> en moyenne.{' '}
          {uplift > 0.5
            ? '→ tenir paierait — signal à re-vérifier avant toute action.'
            : '→ le lock reste le meilleur jour de sortie (tenir perd en moyenne).'}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b">
              <th className="text-left py-1 font-normal">Sortie</th>
              <th className="text-right font-normal">Moyenne</th>
              <th className="text-right font-normal">Médiane</th>
              <th className="text-right font-normal">%gagn</th>
              <th className="text-right font-normal">n</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => {
              const isBest = d.label === data.bestDayByMean;
              return (
                <tr key={d.key} className={`border-b last:border-0 ${isBest ? 'font-semibold bg-blue-50/50' : ''}`}>
                  <td className="py-1">{isBest ? '🏆 ' : ''}{d.label}</td>
                  <td className={`text-right ${cls(d.avgPct)}`}>{fmt(d.avgPct)}</td>
                  <td className={`text-right ${cls(d.medPct)}`}>{fmt(d.medPct)}</td>
                  <td className="text-right">{d.winPct != null ? `${d.winPct}%` : '—'}</td>
                  <td className="text-right text-muted-foreground">{d.n}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground">
        J+1/J+3/J+6 se peuplent progressivement (backfill du labeler) — les n augmentent chaque jour. Jours à n &lt; {data.minSampleForBest} exclus du « meilleur jour ».
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold text-sm">{value}</div>
    </div>
  );
}
