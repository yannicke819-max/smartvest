'use client';
import { BackButton } from '@/components/ui/back-button';

import { useParams } from 'next/navigation';
import { TrendingUp, TrendingDown, Activity, BarChart3 } from 'lucide-react';
import { useHistory, usePerformanceMetrics, useBenchmark } from '@/hooks/use-performance';
import { SkeletonCard } from '@/components/ui/skeleton';

function formatPct(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return `${parseFloat(value).toFixed(digits)}%`;
}

export default function PerformancePage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const historyQuery = useHistory(portfolioId ?? null);
  const metricsQuery = usePerformanceMetrics(portfolioId ?? null);
  const benchmarkQuery = useBenchmark(portfolioId ?? null);

  const metrics = metricsQuery.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Performances</h1>
          <p className="text-sm text-muted-foreground">
            Les performances passées ne préjugent pas des performances futures.
          </p>
        </div>
      </div>

      {metricsQuery.isLoading && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Rendement total"
            value={formatPct(metrics.totalReturnPct, 2)}
            accent={parseFloat(metrics.totalReturnPct) >= 0 ? 'positive' : 'negative'}
          />
          <MetricCard
            icon={<Activity className="h-4 w-4" />}
            label="Annualisé"
            value={formatPct(metrics.annualizedReturnPct, 2)}
            hint="Si horizon > ~30j"
          />
          <MetricCard
            icon={<BarChart3 className="h-4 w-4" />}
            label="Volatilité"
            value={formatPct(metrics.volatility, 2)}
            hint="Annualisée, stddev daily"
          />
          <MetricCard
            icon={<TrendingDown className="h-4 w-4" />}
            label="Max drawdown"
            value={formatPct(metrics.maxDrawdownPct, 2)}
            accent="negative"
            hint={`Actuel : ${formatPct(metrics.currentDrawdownPct, 2)}`}
          />
        </div>
      )}

      {metrics && metrics.dayCount > 0 && (
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            Période : {metrics.periodStart} → {metrics.periodEnd} — {metrics.dayCount} jours
            {metrics.positiveDays > 0 || metrics.negativeDays > 0 ? (
              <span className="ml-2">({metrics.positiveDays} positifs, {metrics.negativeDays} négatifs)</span>
            ) : null}
          </p>
        </div>
      )}

      {benchmarkQuery.data?.benchmarkName && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-medium">
            Comparaison vs {benchmarkQuery.data.benchmarkName}
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Portefeuille</div>
              <div className="font-semibold">
                {formatPct(benchmarkQuery.data.portfolioReturnPct, 2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Benchmark</div>
              <div className="font-semibold">
                {formatPct(benchmarkQuery.data.benchmarkReturnPct, 2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Écart</div>
              <div className={`font-semibold ${
                benchmarkQuery.data.excessReturnPct && parseFloat(benchmarkQuery.data.excessReturnPct) >= 0
                  ? 'text-emerald-600'
                  : 'text-red-500'
              }`}>
                {formatPct(benchmarkQuery.data.excessReturnPct, 2)}
              </div>
            </div>
          </div>
        </div>
      )}

      {historyQuery.data && historyQuery.data.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-medium">Historique des snapshots</h3>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-right">Valeur</th>
                  <th className="px-2 py-1.5 text-right">P&L</th>
                  <th className="px-2 py-1.5 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.slice(-30).reverse().map((p) => (
                  <tr key={p.date} className="border-b last:border-0">
                    <td className="px-2 py-1">{p.date}</td>
                    <td className="px-2 py-1 text-right font-mono">{parseFloat(p.marketValue).toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono">{parseFloat(p.pnlAbsolute).toFixed(2)}</td>
                    <td className="px-2 py-1 text-right">{formatPct(p.pnlPercent, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, hint, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: 'positive' | 'negative';
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold ${
        accent === 'positive' ? 'text-emerald-600'
          : accent === 'negative' ? 'text-red-500' : ''
      }`}>
        {value}
      </div>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
