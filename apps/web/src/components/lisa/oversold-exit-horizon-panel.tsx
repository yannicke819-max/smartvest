'use client';

import { TrendingUp } from 'lucide-react';
import { useOversoldExitHorizon } from '@/hooks/use-oversold-exit-horizon';

/**
 * SHADOW « meilleur jour de sortie » (J → J+10). Pour les positions clôturées par
 * le gain-picker (lock +1.5%), montre ce qu'un exit à chaque horizon aurait donné
 * (moyenne + médiane), à partir de la trajectoire RÉELLE labellisée. MESURE SEULE :
 * aide à décider d'allonger l'horizon (ex US → J+6) sans rien changer au trading.
 */
export function OversoldExitHorizonPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldExitHorizon(portfolioId);

  if (isLoading) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">📈 Chargement du shadow horizon de sortie…</div>;
  }
  if (isError || !data) {
    return <div className="rounded-lg border p-4 text-sm text-muted-foreground">📈 Shadow horizon indisponible pour le moment.</div>;
  }
  if (!data.n) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📈 Pas encore de trajectoire mûrie — se peuple dès J+1 après chaque close.
      </div>
    );
  }

  const fmt = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
  const cls = (x: number | null) => (x == null ? '' : x >= 0 ? 'text-emerald-600' : 'text-red-600');
  const uplift = data.upliftJ6VsLockPct;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-blue-600" />
        <h2 className="text-sm font-medium">📈 Meilleur jour de sortie — shadow (J → J+10)</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Ce qu&apos;un exit à chaque horizon aurait donné sur les closes, mesuré sur la trajectoire réelle. Mesure seule — ne change rien au trading.
      </p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Tile label="Meilleur jour (moyenne)" value={data.bestDayByMean ?? '—'} />
        <Tile label="Meilleur jour (médiane)" value={data.bestDayByMedian ?? '—'} />
      </div>

      {uplift != null && (
        <div className={`text-xs rounded-md p-2 ${uplift > 0.5 ? 'bg-emerald-50' : uplift < -0.5 ? 'bg-amber-50' : 'bg-muted'}`}>
          Tenir jusqu&apos;à <b>J+6</b> vs lock actuel : <span className={cls(uplift)}><b>{fmt(uplift)}</b></span> en moyenne ({data.n} trades).{' '}
          {uplift > 1
            ? "→ allonger l'horizon capterait nettement plus."
            : uplift < -0.5
              ? '→ le lock actuel reste meilleur en moyenne (rebond fragile).'
              : '→ marginal.'}
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
        ⚠️ Biais de survie (gagnantes du gain-picker) + petits échantillons (jours à n &lt; {data.minSampleForBest} exclus du « meilleur jour »). Indicatif, le live sera plus bas.
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
