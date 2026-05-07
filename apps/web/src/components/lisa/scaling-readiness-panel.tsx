'use client';

/**
 * PR #268 — Panel "Scaling Readiness" pour suivre les 5 critères qui
 * déterminent si l'edge est sustainable et si on peut scaler le capital
 * (paper → LIVE micro caps puis caps normaux).
 *
 * Critères :
 *   1. profitable_ratio  ≥ 80%
 *   2. avg_daily_pnl     ≥ $50
 *   3. pnl_volatility    ≤ 1.0 (stddev/mean)
 *   4. worst_day         ≥ -$50
 *   5. win_rate_7day     ≥ 65%
 *
 * Verdict : READY / CAUTION / NOT_READY / INSUFFICIENT_DATA
 */

import { useState } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useTradingStats } from '@/hooks/use-operating-mode';

interface Props {
  portfolioId: string;
}

export function ScalingReadinessPanel({ portfolioId }: Props) {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useTradingStats(portfolioId, days);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Calcul des métriques en cours…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Aucune donnée disponible.
      </div>
    );
  }

  const verdictColor = {
    READY: 'bg-emerald-500/10 border-emerald-500 text-emerald-500',
    CAUTION: 'bg-amber-500/10 border-amber-500 text-amber-500',
    NOT_READY: 'bg-red-500/10 border-red-500 text-red-500',
    INSUFFICIENT_DATA: 'bg-muted border-input text-muted-foreground',
  }[data.verdict];

  const verdictLabel = {
    READY: 'PRÊT POUR SCALING (LIVE / capital ×)',
    CAUTION: 'PRUDENCE — quelques critères en dessous',
    NOT_READY: 'NON PRÊT — edge instable',
    INSUFFICIENT_DATA: 'DONNÉES INSUFFISANTES (< 7 jours)',
  }[data.verdict];

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-orange-500" />
          <h3 className="font-semibold text-foreground">Scaling readiness</h3>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="h-7 rounded-md border bg-background px-2 text-xs"
        >
          <option value={7}>7 jours</option>
          <option value={14}>14 jours</option>
          <option value={30}>30 jours</option>
          <option value={90}>90 jours</option>
        </select>
      </div>

      {/* Verdict global */}
      <div className={`rounded-md border px-3 py-2 text-center text-sm font-semibold ${verdictColor}`}>
        {verdictLabel}
      </div>

      {/* Métriques summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Metric
          label="PnL total"
          value={`$${data.metrics.total_pnl.toFixed(2)}`}
          positive={data.metrics.total_pnl > 0}
          icon={data.metrics.total_pnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        />
        <Metric
          label="Win rate global"
          value={`${data.metrics.win_rate_pct.toFixed(1)}%`}
          positive={data.metrics.win_rate_pct >= 65}
        />
        <Metric
          label="Expectancy/trade"
          value={`$${data.metrics.expectancy_per_trade.toFixed(2)}`}
          positive={data.metrics.expectancy_per_trade > 0}
        />
        <Metric
          label="Trades fermés"
          value={`${data.metrics.trades_count_total} (${data.metrics.trades_tp_sl_only} TP/SL)`}
        />
      </div>

      {/* Critères détaillés */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Critères de scaling
        </div>
        {data.scaling_criteria.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            Pas assez de données ({data.metrics.total_days} jour{data.metrics.total_days > 1 ? 's' : ''}, besoin de ≥ 7).
          </div>
        ) : (
          data.scaling_criteria.map((c) => (
            <CriterionRow key={c.name} criterion={c} />
          ))
        )}
      </div>

      {/* Breakdown asset class */}
      {data.by_asset_class.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Performance par classe
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-input">
                <th className="text-left py-1">Classe</th>
                <th className="text-right py-1">W/L</th>
                <th className="text-right py-1">Win %</th>
                <th className="text-right py-1">PnL</th>
              </tr>
            </thead>
            <tbody>
              {data.by_asset_class.map((ac) => (
                <tr key={ac.asset_class} className="border-b border-input/50">
                  <td className="py-1 font-medium text-foreground">{ac.asset_class}</td>
                  <td className="text-right py-1">{ac.wins}/{ac.losses}</td>
                  <td className="text-right py-1">
                    {ac.win_rate_pct != null ? `${ac.win_rate_pct.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`text-right py-1 font-medium ${ac.pnl_usd >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    ${ac.pnl_usd.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Distribution journalière compacte */}
      {data.daily_series.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Distribution journalière
            </span>
            <span className="text-xs text-muted-foreground">
              {data.metrics.profitable_days}+ / {data.metrics.losing_days}- / {data.metrics.flat_days}=
              · best: ${data.metrics.best_day.toFixed(2)} · worst: ${data.metrics.worst_day.toFixed(2)}
            </span>
          </div>
          <div className="flex gap-px overflow-x-auto">
            {data.daily_series.map((d) => {
              const pnl = d.pnl_usd;
              const intensity = Math.min(1, Math.abs(pnl) / 100);
              const bg = pnl > 0
                ? `rgba(16, 185, 129, ${0.3 + intensity * 0.7})`
                : pnl < 0
                  ? `rgba(239, 68, 68, ${0.3 + intensity * 0.7})`
                  : 'rgba(100, 116, 139, 0.3)';
              return (
                <div
                  key={d.date}
                  className="flex-shrink-0 h-8 w-3 rounded-sm cursor-help"
                  style={{ backgroundColor: bg }}
                  title={`${d.date}: $${pnl.toFixed(2)} (${d.wins}W/${d.losses}L)`}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground text-right pt-1">
        Mis à jour {new Date(data.as_of).toLocaleTimeString('fr-FR')} · cache 60s
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  positive,
  icon,
}: {
  label: string;
  value: string;
  positive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-semibold flex items-center gap-1 ${
        positive === true ? 'text-emerald-500' : positive === false ? 'text-red-500' : 'text-foreground'
      }`}>
        {icon}
        {value}
      </div>
    </div>
  );
}

function CriterionRow({ criterion }: { criterion: import('@/hooks/use-operating-mode').ScalingCriterion }) {
  const statusIcon = {
    PASS: <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />,
    FAIL: <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />,
    INSUFFICIENT_DATA: <AlertTriangle className="h-4 w-4 text-muted-foreground flex-shrink-0" />,
  }[criterion.status];

  const statusBg = {
    PASS: 'bg-emerald-500/5 border-emerald-500/30',
    FAIL: 'bg-red-500/5 border-red-500/30',
    INSUFFICIENT_DATA: 'bg-muted border-input',
  }[criterion.status];

  const formatVal = (v: number | null, unit: string): string => {
    if (v == null) return '—';
    if (unit === 'USD') return `$${v.toFixed(2)}`;
    if (unit === '%') return `${v.toFixed(1)}%`;
    if (unit === 'x') return `${v.toFixed(2)}x`;
    return String(v);
  };

  const formatTarget = (target: number, unit: string, name: string): string => {
    const op = (name === 'pnl_volatility_ratio') ? '≤' : (name === 'worst_day' ? '≥' : '≥');
    return `${op} ${formatVal(target, unit)}`;
  };

  return (
    <div className={`rounded-md border px-3 py-2 ${statusBg}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {statusIcon}
          <span className="text-xs font-medium text-foreground">{criterion.label}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="font-semibold text-foreground">
            {formatVal(criterion.value, criterion.unit)}
          </span>
          <span className="text-muted-foreground">
            {formatTarget(criterion.target, criterion.unit, criterion.name)}
          </span>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1 ml-6">{criterion.advice}</div>
    </div>
  );
}
