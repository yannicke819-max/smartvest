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
import { LineChart as LineChartIcon } from 'lucide-react';
import { useLisaSnapshotHistory } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

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
      tLabel: new Date(s.timestamp).toLocaleString('fr-FR', {
        month: 'short',
        day: 'numeric',
        hour: window === '1d' ? '2-digit' : undefined,
        minute: window === '1d' ? '2-digit' : undefined,
      }),
      value: parseFloat(s.total_value_usd),
      realized: parseFloat(s.realized_pnl_cumulative_usd),
      returnPct: s.return_from_inception_pct,
      drawdown: s.drawdown_from_peak_pct,
    }));
  }, [data, window]);

  const hasData = chartData.length > 1;
  const firstValue = chartData[0]?.value ?? 0;
  const latestValue = chartData[chartData.length - 1]?.value ?? 0;
  const periodReturn = firstValue > 0 ? ((latestValue - firstValue) / firstValue) * 100 : 0;

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
                dataKey="tLabel"
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', opacity: 0.2 }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'currentColor' }}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', opacity: 0.2 }}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 6,
                  fontSize: 11,
                }}
                formatter={(v) => `${Number(v ?? 0).toFixed(2)} USD`}
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
