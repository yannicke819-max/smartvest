'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';

interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  calmarRatio: number;
  avgPnlPerTradeUsd: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalCostsUsd: number;
}

interface EquityPoint {
  date: string;
  equityUsd: number;
  drawdownPct: number;
}

interface BacktestTrade {
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  entryDate: string;
  exitDate: string;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
  convictionScore: number;
}

interface BacktestResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  warnings: string[];
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'USO', 'VXX', 'TLT', 'IEF', 'HYG'];

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function BacktestPage() {
  const [fromDate, setFromDate] = useState(isoMinusDays(90));
  const [toDate, setToDate] = useState(isoMinusDays(1));
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [antiConsensus, setAntiConsensus] = useState(5);
  const [maxPositionPct, setMaxPositionPct] = useState(8);
  const [maxAssetClassPct, setMaxAssetClassPct] = useState(20);
  const [maxOpenPositions, setMaxOpenPositions] = useState(12);
  const [slippageBps, setSlippageBps] = useState(10);
  const [stopLossPct, setStopLossPct] = useState(2);
  const [takeProfitPct, setTakeProfitPct] = useState(4);
  const [enableOptions, setEnableOptions] = useState(false);
  const [optionsDte, setOptionsDte] = useState(14);
  const [strikeOtmPct, setStrikeOtmPct] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<BacktestResult>('/backtest/run', {
        method: 'POST',
        body: JSON.stringify({
          fromDate,
          toDate,
          initialCapitalUsd: initialCapital,
          universe: DEFAULT_TICKERS,
          antiConsensusStrength: antiConsensus,
          maxPositionSizePct: maxPositionPct,
          maxAssetClassExposurePct: maxAssetClassPct,
          maxOpenPositions,
          slippageBps,
          stopLossPct,
          takeProfitPct,
          enableOptions,
          optionsDte,
          strikeOtmPct,
        }),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setRunning(false);
    }
  }

  // Set both dates : "X derniers jours" = aujourd'hui-X → aujourd'hui.
  // Backtest = données passées uniquement.
  const setQuickPeriod = (days: number) => {
    setFromDate(isoMinusDays(days));
    setToDate(isoMinusDays(0));
  };

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Tester sur le passé</h1>
        <p className="text-sm text-muted-foreground">
          Rejoue la stratégie sur des données EODHD historiques pour estimer Sharpe, drawdown, win rate.
          Mock Lisa déterministe (rule-based) — teste le framework, pas l'intuition Claude.
        </p>
      </div>

      <div className="rounded-lg border p-5 space-y-4">
        <p className="text-xs text-muted-foreground italic">
          Le backtest rejoue des données <strong>passées</strong> (EODHD historique).
          Les dates futures n'existent pas encore — toujours dans le passé jusqu'à aujourd'hui.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-2">Période rapide :</span>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(7)}>
            7 derniers jours
          </Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(30)}>
            30 derniers jours
          </Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(90)}>
            90 derniers jours
          </Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(180)}>
            6 derniers mois
          </Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(365)}>
            1 dernière année
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Du (date passée)">
            <input
              type="date"
              value={fromDate}
              max={isoMinusDays(0)}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Au (jusqu'à aujourd'hui max)">
            <input
              type="date"
              value={toDate}
              max={isoMinusDays(0)}
              onChange={(e) => setToDate(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Capital initial (USD)">
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label={`Anti-consensus : ${antiConsensus}/10`}>
            <input
              type="range"
              min={0}
              max={10}
              value={antiConsensus}
              onChange={(e) => setAntiConsensus(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          <Field label="Max par position (%)">
            <input
              type="number"
              value={maxPositionPct}
              onChange={(e) => setMaxPositionPct(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Max par classe d'actifs (%)">
            <input
              type="number"
              value={maxAssetClassPct}
              onChange={(e) => setMaxAssetClassPct(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Max positions ouvertes">
            <input
              type="number"
              value={maxOpenPositions}
              onChange={(e) => setMaxOpenPositions(parseInt(e.target.value, 10))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label={`Slippage par trade (bps) : ${slippageBps}`}>
            <input
              type="range"
              min={0}
              max={50}
              value={slippageBps}
              onChange={(e) => setSlippageBps(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          <Field label="Stop-loss (%)">
            <input
              type="number"
              step={0.5}
              value={stopLossPct}
              onChange={(e) => setStopLossPct(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Take-profit (%)">
            <input
              type="number"
              step={0.5}
              value={takeProfitPct}
              onChange={(e) => setTakeProfitPct(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
        </div>

        <div className="border-t pt-3 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={enableOptions}
              onChange={(e) => setEnableOptions(e.target.checked)}
            />
            <strong>Activer les options</strong>
            <span className="text-muted-foreground">
              (long calls/puts pour conviction ≥ 8/10 — payoff asymétrique, downside borné au premium)
            </span>
          </label>
          {enableOptions && (
            <div className="grid grid-cols-2 gap-3 ml-6">
              <Field label={`Days-to-expiry : ${optionsDte}`}>
                <input
                  type="range"
                  min={3}
                  max={60}
                  value={optionsDte}
                  onChange={(e) => setOptionsDte(parseInt(e.target.value, 10))}
                  className="w-full"
                />
              </Field>
              <Field label={`Strike OTM : ${strikeOtmPct}%`}>
                <input
                  type="range"
                  min={0}
                  max={20}
                  value={strikeOtmPct}
                  onChange={(e) => setStrikeOtmPct(parseInt(e.target.value, 10))}
                  className="w-full"
                />
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={running}>
            {running ? 'Run en cours…' : 'Lancer le backtest'}
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>

      {result && (
        <>
          <MetricsCard metrics={result.metrics} durationMs={result.durationMs} />
          <EquityChart equityCurve={result.equityCurve} />
          <TradesTable trades={result.trades} />
          {result.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4">
              <h3 className="text-sm font-medium mb-2">Avertissements</h3>
              <ul className="text-xs space-y-1 text-amber-900 dark:text-amber-200">
                {result.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground block mb-1">{label}</span>
      {children}
    </label>
  );
}

function MetricsCard({ metrics, durationMs }: { metrics: BacktestMetrics; durationMs: number }) {
  const totalRet = metrics.totalReturnPct;
  const sharpe = metrics.sharpeRatio;
  const dd = metrics.maxDrawdownPct;
  const wr = metrics.winRatePct;
  const pf = metrics.profitFactor;

  const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '∞');
  const colorRet = totalRet > 0 ? 'text-emerald-600' : totalRet < 0 ? 'text-red-600' : '';
  const colorSharpe = sharpe >= 1 ? 'text-emerald-600' : sharpe >= 0 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className="rounded-lg border p-5">
      <div className="flex justify-between items-baseline mb-3">
        <h2 className="font-medium">Métriques</h2>
        <span className="text-xs text-muted-foreground">
          Run en {(durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <Metric label="Return total" value={`${fmt(totalRet)}%`} colorClass={colorRet} />
        <Metric label="Annualisé" value={`${fmt(metrics.annualizedReturnPct)}%`} />
        <Metric label="Sharpe ratio" value={fmt(sharpe)} colorClass={colorSharpe} />
        <Metric label="Max drawdown" value={`-${fmt(dd)}%`} colorClass="text-red-600" />
        <Metric label="Win rate" value={`${fmt(wr, 1)}%`} />
        <Metric label="Profit factor" value={fmt(pf)} />
        <Metric label="Calmar ratio" value={fmt(metrics.calmarRatio)} />
        <Metric label="Avg P&L / trade" value={`$${fmt(metrics.avgPnlPerTradeUsd)}`} />
        <Metric label="Trades" value={`${metrics.totalTrades} (${metrics.winningTrades}W/${metrics.losingTrades}L)`} />
        <Metric label="Coûts cumulés" value={`$${fmt(metrics.totalCostsUsd)}`} />
      </div>
    </div>
  );
}

function Metric({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-medium ${colorClass ?? ''}`}>{value}</div>
    </div>
  );
}

function EquityChart({ equityCurve }: { equityCurve: EquityPoint[] }) {
  if (equityCurve.length < 2) return null;
  const min = Math.min(...equityCurve.map((p) => p.equityUsd));
  const max = Math.max(...equityCurve.map((p) => p.equityUsd));
  const w = 800;
  const h = 240;
  const x = (i: number) => (i / (equityCurve.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * h;
  const path = equityCurve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.equityUsd)}`).join(' ');
  const last = equityCurve[equityCurve.length - 1];
  const first = equityCurve[0];
  const trendUp = last.equityUsd >= first.equityUsd;

  return (
    <div className="rounded-lg border p-5">
      <div className="flex justify-between items-baseline mb-3">
        <h2 className="font-medium">Évolution de l'équité</h2>
        <span className="text-xs text-muted-foreground">
          ${first.equityUsd.toFixed(0)} → ${last.equityUsd.toFixed(0)}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-60 overflow-visible">
        <path
          d={path}
          fill="none"
          stroke={trendUp ? '#10b981' : '#ef4444'}
          strokeWidth={2}
        />
      </svg>
      <div className="text-xs text-muted-foreground flex justify-between mt-1">
        <span>{first.date}</span>
        <span>{last.date}</span>
      </div>
    </div>
  );
}

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length === 0) return null;
  const display = trades.slice(0, 50);
  return (
    <div className="rounded-lg border p-5">
      <h2 className="font-medium mb-3">
        Trades ({trades.length}{trades.length > 50 ? ', 50 premiers affichés' : ''})
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="text-left py-1">Symbol</th>
              <th className="text-left py-1">Dir.</th>
              <th className="text-left py-1">Entrée</th>
              <th className="text-left py-1">Sortie</th>
              <th className="text-right py-1">Conv.</th>
              <th className="text-right py-1">P&amp;L $</th>
              <th className="text-right py-1">P&amp;L %</th>
              <th className="text-left py-1">Raison</th>
            </tr>
          </thead>
          <tbody>
            {display.map((t, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1 font-mono">{t.symbol}</td>
                <td className="py-1">{t.direction}</td>
                <td className="py-1">{t.entryDate}</td>
                <td className="py-1">{t.exitDate}</td>
                <td className="py-1 text-right">{t.convictionScore.toFixed(1)}</td>
                <td className={`py-1 text-right ${t.pnlUsd >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {t.pnlUsd >= 0 ? '+' : ''}{t.pnlUsd.toFixed(2)}
                </td>
                <td className={`py-1 text-right ${t.pnlPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
                </td>
                <td className="py-1">{t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
