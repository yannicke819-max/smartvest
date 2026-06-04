'use client';

import { TrendingDown, Clock, ShieldAlert } from 'lucide-react';
import { useOversoldSummary, type OversoldBookPosition } from '@/hooks/use-oversold-summary';

/**
 * Vue dédiée du mode OVERSOLD (mean-reversion swing J+10).
 *
 * Remplace les widgets gainers (cibles journalières, WR scalp, shadow sizing)
 * inadaptés à un swing. Affiche : valeur du book, P&L réalisé vs latent, et les
 * positions ouvertes avec drop% à l'entrée, compte à rebours J+10, distance au
 * stop catastrophe -15%. Stats scopées source=scanner_oversold (pas de mélange
 * avec l'historique gainers du portfolio).
 */
export function OversoldPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldSummary(portfolioId);

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📉 Chargement du book oversold…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📉 Book oversold indisponible pour le moment.
      </div>
    );
  }

  const fmtUsd = (n: number) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const fmtPct = (n: number | null, dp = 2) =>
    n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
  const pnlCls = (n: number | null) =>
    n == null ? 'text-muted-foreground' : n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-600' : '';

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <TrendingDown className="h-4 w-4 text-purple-600" />
        <h2 className="text-sm font-medium">📉 Mode Oversold — book mean-reversion swing</h2>
      </div>

      {/* Métriques de tête */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Metric label="Capital" value={fmtUsd(data.capitalUsd)} />
        <Metric
          label={`Déployé (${data.openCount} pos.)`}
          value={fmtUsd(data.deployedNotionalUsd)}
          sub={
            data.capitalUsd > 0
              ? `${((data.deployedNotionalUsd / data.capitalUsd) * 100).toFixed(0)}% du capital`
              : undefined
          }
        />
        <Metric label="Valeur book" value={fmtUsd(data.currentBookValueUsd)} />
        <Metric
          label="P&L latent"
          value={fmtUsd(data.unrealizedPnlUsd)}
          sub={fmtPct(data.unrealizedPnlPct)}
          valueCls={pnlCls(data.unrealizedPnlUsd)}
        />
        <Metric
          label="P&L réalisé (oversold)"
          value={fmtUsd(data.realizedPnlUsd)}
          sub={
            data.realizedWinRatePct != null
              ? `${data.realizedTrades} trades · WR ${data.realizedWinRatePct.toFixed(0)}%`
              : `${data.realizedTrades} trades`
          }
          valueCls={pnlCls(data.realizedPnlUsd)}
        />
        <Metric
          label="Règles"
          value={`Hold J+${data.holdDaysTarget}`}
          sub={`Stop ${data.stopCatastrophePct}% · bande ${data.dropBand.min}/${data.dropBand.max}%`}
        />
      </div>

      {/* Positions */}
      {data.positions.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          Aucune position oversold ouverte. Le scan quotidien (21:15 UTC, post-close US)
          ouvrira les titres ayant chuté de {data.dropBand.min}% à {data.dropBand.max}% sur 1J.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-2">Symbole</th>
                <th className="py-1.5 px-2 text-right">Drop entrée</th>
                <th className="py-1.5 px-2 text-right">Entrée</th>
                <th className="py-1.5 px-2 text-right">Courant (EOD)</th>
                <th className="py-1.5 px-2 text-right">P&L latent</th>
                <th className="py-1.5 px-2 text-right">
                  <Clock className="inline h-3 w-3" /> J restants
                </th>
                <th className="py-1.5 pl-2 text-right">
                  <ShieldAlert className="inline h-3 w-3" /> Marge stop
                </th>
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => (
                <PositionRow key={p.symbol} p={p} fmtPct={fmtPct} pnlCls={pnlCls} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground italic">
        Valorisation au dernier close EOD (swing J+10, pas d&apos;intraday). Le stop
        catastrophe {data.stopCatastrophePct}% par position et l&apos;exit J+{data.holdDaysTarget}
        sont gérés automatiquement (cron 30 min). MAJ : {new Date(data.asOf).toLocaleTimeString('fr-FR')}.
      </p>
    </div>
  );
}

function Metric(props: { label: string; value: string; sub?: string; valueCls?: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{props.label}</div>
      <div className={`text-sm font-semibold ${props.valueCls ?? ''}`}>{props.value}</div>
      {props.sub && <div className="text-[10px] text-muted-foreground">{props.sub}</div>}
    </div>
  );
}

function PositionRow({
  p,
  fmtPct,
  pnlCls,
}: {
  p: OversoldBookPosition;
  fmtPct: (n: number | null, dp?: number) => string;
  pnlCls: (n: number | null) => string;
}) {
  // Marge stop < 3% → alerte (proche du stop catastrophe).
  const stopWarn = p.distToStopPct != null && p.distToStopPct < 3;
  return (
    <tr className="border-b last:border-0">
      <td className="py-1.5 pr-2 font-medium">{p.symbol.replace('.US', '')}</td>
      <td className="py-1.5 px-2 text-right text-red-600">{fmtPct(p.dropPctAtEntry)}</td>
      <td className="py-1.5 px-2 text-right tabular-nums">${p.entryPrice.toFixed(2)}</td>
      <td className="py-1.5 px-2 text-right tabular-nums">
        {p.currentPrice != null ? `$${p.currentPrice.toFixed(2)}` : '—'}
      </td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${pnlCls(p.unrealizedPnlPct)}`}>
        {fmtPct(p.unrealizedPnlPct)}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">{p.daysRemaining}</td>
      <td
        className={`py-1.5 pl-2 text-right tabular-nums ${
          stopWarn ? 'text-red-600 font-semibold' : 'text-muted-foreground'
        }`}
      >
        {fmtPct(p.distToStopPct, 1)}
      </td>
    </tr>
  );
}
