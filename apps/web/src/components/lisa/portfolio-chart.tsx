'use client';

import { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { LineChart as LineChartIcon, RefreshCw } from 'lucide-react';
import { useLisaSnapshotHistory } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

type ChartPoint = {
  t: number;
  tFull: string;
  value: number;
  realized: number;
  returnPct: number;
  drawdown: number;
};

// Tooltip défini hors du composant parent pour garantir que recharts appelle
// bien le render à chaque déplacement du curseur (pas de closure capturée
// sur une data point figée).
function ChartTooltip(props: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  if (!point || typeof point.value !== 'number') return null;
  return (
    <div
      className="rounded-md border bg-card p-2 text-[11px] shadow-sm"
      style={{ minWidth: 160 }}
    >
      <div className="font-mono text-muted-foreground mb-1">{point.tFull}</div>
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Valeur</span>
        <span className="font-mono font-medium tabular-nums">
          {point.value.toFixed(2)} USD
        </span>
      </div>
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Return</span>
        <span className={`font-mono tabular-nums ${point.returnPct >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {point.returnPct >= 0 ? '+' : ''}{point.returnPct.toFixed(2)}%
        </span>
      </div>
      {point.drawdown < 0 && (
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Drawdown</span>
          <span className="font-mono tabular-nums text-red-500">
            {point.drawdown.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

type TimeWindow = '1d' | '1w' | '1m' | '1y';

const WINDOW_DAYS: Record<TimeWindow, number> = {
  '1d': 1,
  '1w': 7,
  '1m': 30,
  '1y': 365,
};

const WINDOW_LABELS: Record<TimeWindow, string> = {
  '1d': '24 heures',
  '1w': '7 jours',
  '1m': '30 jours',
  '1y': '1 an',
};

export function LisaPortfolioChart({ portfolioId }: { portfolioId: string }) {
  const [window, setWindow] = useState<TimeWindow>('1m');
  const historyQuery = useLisaSnapshotHistory(portfolioId, WINDOW_DAYS[window]);

  const data = historyQuery.data ?? [];

  const chartData = useMemo(() => {
    return data.map((s) => ({
      t: new Date(s.timestamp).getTime(),
      tFull: new Date(s.timestamp).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
      value: parseFloat(s.total_value_usd),
      realized: parseFloat(s.realized_pnl_cumulative_usd),
      returnPct: s.return_from_inception_pct,
      drawdown: s.drawdown_from_peak_pct,
    }));
  }, [data]);

  const hasData = chartData.length > 1;
  const firstValue = chartData[0]?.value ?? 0;
  const latestValue = chartData[chartData.length - 1]?.value ?? 0;
  const periodReturn = firstValue > 0 ? ((latestValue - firstValue) / firstValue) * 100 : 0;

  // Y-axis : range auto mais on garde au moins 2% de padding pour ne pas
  // écraser visuellement les petites variations (cas typique après peu de
  // mouvements sur un portefeuille 10k).
  const yDomain = useMemo((): [number | 'auto', number | 'auto'] => {
    if (chartData.length === 0) return ['auto', 'auto'];
    const values = chartData.map((d) => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const padding = Math.max(range * 0.15, max * 0.002);
    return [Math.max(0, min - padding), max + padding];
  }, [chartData]);

  // Tick formatter qui adapte la précision selon l'amplitude des valeurs.
  const tickFormatter = (v: number): string => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${(v / 1000).toFixed(2)}k`;
    if (abs >= 1000) return `${(v / 1000).toFixed(3)}k`;
    return v.toFixed(0);
  };

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <LineChartIcon className="h-4 w-4 text-muted-foreground" />
            Évolution du capital
          </h2>
          {hasData && (
            <p className="mt-1 text-xs text-muted-foreground">
              Sur {WINDOW_LABELS[window]} :{' '}
              <span className={periodReturn >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                {periodReturn >= 0 ? '+' : ''}{periodReturn.toFixed(2)}%
              </span>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => historyQuery.refetch()}
            disabled={historyQuery.isFetching}
            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            title="Forcer le rafraîchissement du graph"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${historyQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex gap-1 rounded-md border p-0.5">
          {(Object.keys(WINDOW_DAYS) as TimeWindow[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                window === w
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {w.toUpperCase()}
            </button>
          ))}
          </div>
        </div>
      </div>

      {historyQuery.isLoading && <SkeletonCard />}

      {!historyQuery.isLoading && !hasData && (
        <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          Pas assez de snapshots sur {WINDOW_LABELS[window]} pour tracer une courbe.
          <br />
          Le risk monitor génère un snapshot à chaque cycle.
        </div>
      )}

      {hasData && (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', opacity: 0.2 }}
                tickFormatter={(t: number) => new Date(t).toLocaleString('fr-FR',
                  window === '1d'
                    ? { hour: '2-digit', minute: '2-digit' }
                    : window === '1y'
                      ? { month: 'short', year: '2-digit' }
                      : { day: '2-digit', month: 'short' },
                )}
                minTickGap={30}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', opacity: 0.2 }}
                domain={yDomain}
                tickFormatter={tickFormatter}
              />
              <Tooltip
                cursor={{ stroke: 'currentColor', strokeWidth: 1, opacity: 0.2 }}
                isAnimationActive={false}
                content={<ChartTooltip />}
              />
              <ReferenceLine
                y={firstValue}
                stroke="currentColor"
                strokeDasharray="4 4"
                opacity={0.3}
                label={{
                  value: 'Départ',
                  position: 'right',
                  fontSize: 9,
                  fill: 'currentColor',
                  opacity: 0.5,
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={periodReturn >= 0 ? '#10b981' : '#ef4444'}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
