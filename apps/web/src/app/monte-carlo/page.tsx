'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';

interface MCStatistics {
  numPaths: number;
  finalEquity: { mean: number; median: number; p5: number; p25: number; p75: number; p95: number; min: number; max: number };
  returnPct: { mean: number; median: number; p5: number; p25: number; p75: number; p95: number };
  maxDrawdownPct: { mean: number; median: number; p95: number; max: number };
  probAboveTarget: number | null;
  probLossAbove: { lossPct5: number; lossPct10: number; lossPct15: number };
  var95Usd: number;
  cvar95Usd: number;
}

interface MCResult {
  config: { initialCapitalUsd: number; horizonDays: number; numPaths: number; targetEquityUsd?: number };
  durationMs: number;
  statistics: MCStatistics;
  fanChart: Array<{ dayIndex: number; p5: number; p25: number; p50: number; p75: number; p95: number }>;
  histogram: Array<{ binStart: number; binEnd: number; count: number; pct: number }>;
  warnings: string[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MonteCarloPage() {
  const [horizonDays, setHorizonDays] = useState(30);
  const [numPaths, setNumPaths] = useState(1000);
  const [lookbackDays, setLookbackDays] = useState(180);
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [targetEquity, setTargetEquity] = useState(11_000);
  const [antiConsensus, setAntiConsensus] = useState(5);
  // Caps + levier — alignés sur les paramètres de la session Lisa
  const [maxPositionSizePct, setMaxPositionSizePct] = useState(8);
  const [maxAssetClassExposurePct, setMaxAssetClassExposurePct] = useState(20);
  const [enableLeverage, setEnableLeverage] = useState(false);
  const [maxLeverage, setMaxLeverage] = useState(1.5);
  const [stopLossPct, setStopLossPct] = useState(2);
  const [enableOptions, setEnableOptions] = useState(false);
  const [optionsDte, setOptionsDte] = useState(14);
  const [strikeOtmPct, setStrikeOtmPct] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MCResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<MCResult>('/monte-carlo/run', {
        method: 'POST',
        body: JSON.stringify({
          asOfDate: todayIso(),
          lookbackDays,
          horizonDays,
          numPaths,
          initialCapitalUsd: initialCapital,
          antiConsensusStrength: antiConsensus,
          maxPositionSizePct,
          maxAssetClassExposurePct,
          enableLeverage,
          maxLeverage,
          stopLossPct,
          enableOptions,
          optionsDte,
          strikeOtmPct,
          targetEquityUsd: targetEquity > 0 ? targetEquity : undefined,
        }),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Projections futures</h1>
        <p className="text-sm text-muted-foreground">
          Projette N trajectoires possibles à partir des rendements historiques bootstrappés.
          Estime la distribution des résultats, la VaR, et la probabilité d'atteindre une cible.
        </p>
        <p className="text-xs text-muted-foreground italic mt-2">
          ⚠️ Limites : la simulation suppose que le futur ressemble en distribution au passé récent.
          Si un régime jamais vu apparaît (covid, choc géopol majeur), les pertes réelles peuvent excéder la VaR.
        </p>
      </div>

      <div className="rounded-lg border p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Capital initial (USD)">
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label={`Horizon : ${horizonDays} jours`}>
            <input
              type="range"
              min={5}
              max={120}
              value={horizonDays}
              onChange={(e) => setHorizonDays(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          <Field label={`Trajectoires : ${numPaths}`}>
            <input
              type="range"
              min={100}
              max={5000}
              step={100}
              value={numPaths}
              onChange={(e) => setNumPaths(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          <Field label={`Lookback historique : ${lookbackDays}j`}>
            <input
              type="range"
              min={60}
              max={365}
              value={lookbackDays}
              onChange={(e) => setLookbackDays(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          <Field label="Cible (USD)">
            <input
              type="number"
              value={targetEquity}
              onChange={(e) => setTargetEquity(parseFloat(e.target.value))}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label={`Anti-consensus : ${antiConsensus}`}>
            <input
              type="range"
              min={0}
              max={10}
              value={antiConsensus}
              onChange={(e) => setAntiConsensus(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
        </div>

        <div className="border-t pt-4 space-y-3">
          <h3 className="text-sm font-semibold">Caps de risque (doivent matcher ta config Lisa)</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label={`Max par position : ${maxPositionSizePct}%`}>
              <input
                type="range"
                min={2}
                max={50}
                value={maxPositionSizePct}
                onChange={(e) => setMaxPositionSizePct(parseInt(e.target.value, 10))}
                className="w-full"
              />
            </Field>
            <Field label={`Max par classe : ${maxAssetClassExposurePct}%`}>
              <input
                type="range"
                min={5}
                max={100}
                value={maxAssetClassExposurePct}
                onChange={(e) => setMaxAssetClassExposurePct(parseInt(e.target.value, 10))}
                className="w-full"
              />
            </Field>
            <Field label={`Stop-loss par position : ${stopLossPct}%`}>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={stopLossPct}
                onChange={(e) => setStopLossPct(parseFloat(e.target.value))}
                className="w-full"
              />
            </Field>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={enableLeverage}
                onChange={(e) => setEnableLeverage(e.target.checked)}
              />
              <strong>Activer le levier</strong>
            </label>
            {enableLeverage && (
              <Field label={`Levier max : ×${maxLeverage}`}>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.1}
                  value={maxLeverage}
                  onChange={(e) => setMaxLeverage(parseFloat(e.target.value))}
                  className="w-40"
                />
              </Field>
            )}
          </div>

          <div className="flex items-center gap-4 flex-wrap pt-2 border-t">
            <label className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={enableOptions}
                onChange={(e) => setEnableOptions(e.target.checked)}
              />
              <strong>Activer les options</strong>
              <span className="text-muted-foreground">(long calls/puts pour conviction ≥ 8/10 — payoff asymétrique)</span>
            </label>
            {enableOptions && (
              <>
                <Field label={`DTE : ${optionsDte}j`}>
                  <input
                    type="range"
                    min={3}
                    max={60}
                    value={optionsDte}
                    onChange={(e) => setOptionsDte(parseInt(e.target.value, 10))}
                    className="w-32"
                  />
                </Field>
                <Field label={`Strike OTM : ${strikeOtmPct}%`}>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    value={strikeOtmPct}
                    onChange={(e) => setStrikeOtmPct(parseInt(e.target.value, 10))}
                    className="w-32"
                  />
                </Field>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={running}>
            {running ? 'Simulation en cours…' : `Lancer ${numPaths} trajectoires`}
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>

      {result && (
        <>
          <ProbabilityCard stats={result.statistics} target={result.config.targetEquityUsd} initial={result.config.initialCapitalUsd} />
          <DistributionCard stats={result.statistics} />
          <FanChart fanChart={result.fanChart} initialCapital={result.config.initialCapitalUsd} />
          <Histogram histogram={result.histogram} initialCapital={result.config.initialCapitalUsd} target={result.config.targetEquityUsd} />
          <p className="text-xs text-muted-foreground text-right">
            {result.statistics.numPaths} chemins simulés en {(result.durationMs / 1000).toFixed(1)}s
          </p>
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

function ProbabilityCard({ stats, target, initial }: { stats: MCStatistics; target: number | undefined; initial: number }) {
  return (
    <div className="rounded-lg border p-5 space-y-2">
      <h2 className="font-medium">Probabilités</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        {target != null && stats.probAboveTarget != null && (
          <div className={`p-3 rounded ${stats.probAboveTarget >= 0.5 ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-amber-50 dark:bg-amber-950/20'}`}>
            <div className="text-xs text-muted-foreground">P(equity finale &gt; ${target.toLocaleString()})</div>
            <div className="text-2xl font-semibold">{(stats.probAboveTarget * 100).toFixed(1)}%</div>
          </div>
        )}
        <div className="p-3 rounded bg-muted/40">
          <div className="text-xs text-muted-foreground">Equity finale médiane</div>
          <div className="text-2xl font-semibold">${stats.finalEquity.median.toFixed(0)}</div>
          <div className={`text-xs ${stats.finalEquity.median > initial ? 'text-emerald-600' : 'text-red-600'}`}>
            {((stats.finalEquity.median / initial - 1) * 100).toFixed(2)}% vs initial
          </div>
        </div>
        <div className="p-3 rounded bg-red-50 dark:bg-red-950/20">
          <div className="text-xs text-muted-foreground">P(perte &gt; 10%)</div>
          <div className="text-2xl font-semibold">{(stats.probLossAbove.lossPct10 * 100).toFixed(1)}%</div>
          <div className="text-xs text-muted-foreground">
            P&gt;5% : {(stats.probLossAbove.lossPct5 * 100).toFixed(0)}% | P&gt;15% : {(stats.probLossAbove.lossPct15 * 100).toFixed(0)}%
          </div>
        </div>
        <div className="p-3 rounded bg-red-50 dark:bg-red-950/20">
          <div className="text-xs text-muted-foreground">VaR / CVaR 95%</div>
          <div className="text-2xl font-semibold">${stats.var95Usd.toFixed(0)}</div>
          <div className="text-xs text-muted-foreground">CVaR (queue moyenne) : ${stats.cvar95Usd.toFixed(0)}</div>
        </div>
      </div>
    </div>
  );
}

function DistributionCard({ stats }: { stats: MCStatistics }) {
  return (
    <div className="rounded-lg border p-5">
      <h2 className="font-medium mb-3">Distribution des résultats</h2>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="text-left py-1">Métrique</th>
            <th className="text-right py-1">P5</th>
            <th className="text-right py-1">P25</th>
            <th className="text-right py-1">Médiane</th>
            <th className="text-right py-1">P75</th>
            <th className="text-right py-1">P95</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className="py-1">Equity finale ($)</td>
            <td className="py-1 text-right">{stats.finalEquity.p5.toFixed(0)}</td>
            <td className="py-1 text-right">{stats.finalEquity.p25.toFixed(0)}</td>
            <td className="py-1 text-right font-medium">{stats.finalEquity.median.toFixed(0)}</td>
            <td className="py-1 text-right">{stats.finalEquity.p75.toFixed(0)}</td>
            <td className="py-1 text-right">{stats.finalEquity.p95.toFixed(0)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1">Return total (%)</td>
            <td className={`py-1 text-right ${stats.returnPct.p5 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{stats.returnPct.p5.toFixed(2)}</td>
            <td className={`py-1 text-right ${stats.returnPct.p25 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{stats.returnPct.p25.toFixed(2)}</td>
            <td className={`py-1 text-right font-medium ${stats.returnPct.median >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{stats.returnPct.median.toFixed(2)}</td>
            <td className={`py-1 text-right ${stats.returnPct.p75 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{stats.returnPct.p75.toFixed(2)}</td>
            <td className={`py-1 text-right ${stats.returnPct.p95 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{stats.returnPct.p95.toFixed(2)}</td>
          </tr>
          <tr>
            <td className="py-1">Max drawdown (%)</td>
            <td className="py-1 text-right text-red-600">—</td>
            <td className="py-1 text-right text-red-600">—</td>
            <td className="py-1 text-right font-medium text-red-600">{stats.maxDrawdownPct.median.toFixed(2)}</td>
            <td className="py-1 text-right text-red-600">—</td>
            <td className="py-1 text-right text-red-600">{stats.maxDrawdownPct.p95.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FanChart({ fanChart, initialCapital }: { fanChart: MCResult['fanChart']; initialCapital: number }) {
  if (fanChart.length < 2) return null;
  const w = 800;
  const h = 280;
  const allValues = fanChart.flatMap((p) => [p.p5, p.p25, p.p50, p.p75, p.p95]);
  const min = Math.min(...allValues, initialCapital);
  const max = Math.max(...allValues, initialCapital);
  const x = (i: number) => (i / (fanChart.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * h;
  const yInit = y(initialCapital);

  // Bandes : zone P5-P95 (clair), zone P25-P75 (plus opaque)
  const upperOuter = fanChart.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.p95)}`).join(' ');
  const lowerOuter = fanChart
    .slice()
    .reverse()
    .map((p, i, arr) => `L ${x(arr.length - 1 - i)} ${y(p.p5)}`)
    .join(' ');
  const outerPath = `${upperOuter} ${lowerOuter} Z`;

  const upperInner = fanChart.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.p75)}`).join(' ');
  const lowerInner = fanChart
    .slice()
    .reverse()
    .map((p, i, arr) => `L ${x(arr.length - 1 - i)} ${y(p.p25)}`)
    .join(' ');
  const innerPath = `${upperInner} ${lowerInner} Z`;

  const medianPath = fanChart.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.p50)}`).join(' ');

  // Sample up to 6 time points for the screen-reader table
  const step = Math.max(1, Math.floor(fanChart.length / 6));
  const sampleDays = fanChart
    .map((p, i) => ({ day: i, ...p }))
    .filter((_, i) => i % step === 0 || i === fanChart.length - 1);

  const lastPoint = fanChart[fanChart.length - 1]!;

  return (
    <div className="rounded-lg border p-5">
      <h2 className="font-medium mb-3">Fan chart — bandes P5–P95 / P25–P75 / médiane</h2>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-72 overflow-visible"
        role="img"
        aria-label={`Projections futures Monte-Carlo sur ${fanChart.length} jours : médiane finale ${lastPoint.p50.toFixed(0)} $ (P5 ${lastPoint.p5.toFixed(0)} $ — P95 ${lastPoint.p95.toFixed(0)} $)`}
      >
        <title>{`Projections Monte-Carlo — médiane : ${lastPoint.p50.toFixed(0)} $ à J+${fanChart.length}`}</title>
        <line x1={0} y1={yInit} x2={w} y2={yInit} stroke="currentColor" strokeWidth={1} strokeDasharray="4 4" opacity={0.3} aria-hidden="true" />
        <path d={outerPath} fill="#10b981" opacity={0.15} aria-hidden="true" />
        <path d={innerPath} fill="#10b981" opacity={0.3} aria-hidden="true" />
        <path d={medianPath} fill="none" stroke="#10b981" strokeWidth={2} aria-hidden="true" />
      </svg>

      {/* Screen-reader fallback table */}
      <table className="sr-only" aria-label="Données des projections Monte-Carlo">
        <caption>Fan chart — percentiles par jour (échantillon)</caption>
        <thead>
          <tr>
            <th scope="col">Jour</th>
            <th scope="col">P5 ($)</th>
            <th scope="col">P25 ($)</th>
            <th scope="col">Médiane ($)</th>
            <th scope="col">P75 ($)</th>
            <th scope="col">P95 ($)</th>
          </tr>
        </thead>
        <tbody>
          {sampleDays.map(({ day, p5, p25, p50, p75, p95 }) => (
            <tr key={day}>
              <td>J+{day}</td>
              <td>{p5.toFixed(0)}</td>
              <td>{p25.toFixed(0)}</td>
              <td>{p50.toFixed(0)}</td>
              <td>{p75.toFixed(0)}</td>
              <td>{p95.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="text-xs text-muted-foreground flex justify-between mt-1" aria-hidden="true">
        <span>Aujourd'hui</span>
        <span>+{fanChart.length} jours</span>
      </div>
    </div>
  );
}

function Histogram({ histogram, initialCapital, target }: { histogram: MCResult['histogram']; initialCapital: number; target: number | undefined }) {
  if (histogram.length === 0) return null;
  const maxCount = Math.max(...histogram.map((b) => b.count));
  const w = 800;
  const h = 200;
  const barWidth = w / histogram.length;
  const min = histogram[0].binStart;
  const max = histogram[histogram.length - 1].binEnd;
  const xOf = (val: number) => ((val - min) / (max - min)) * w;

  const totalSims = histogram.reduce((s, b) => s + b.count, 0);
  const firstBin = histogram[0]!;
  const lastBin = histogram[histogram.length - 1]!;

  return (
    <div className="rounded-lg border p-5">
      <h2 className="font-medium mb-3">Distribution des equity finales</h2>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-48 overflow-visible"
        role="img"
        aria-label={`Histogramme des équités finales simulées : de ${firstBin.binStart.toFixed(0)} $ à ${lastBin.binEnd.toFixed(0)} $, capital initial ${initialCapital.toFixed(0)} $`}
      >
        <title>{`Distribution des équités finales — ${totalSims} simulations`}</title>
        {histogram.map((b, i) => {
          const barH = (b.count / maxCount) * h;
          const profitable = b.binEnd > initialCapital;
          return (
            <rect
              key={i}
              x={i * barWidth}
              y={h - barH}
              width={barWidth - 1}
              height={barH}
              fill={profitable ? '#10b981' : '#ef4444'}
              opacity={0.7}
              aria-hidden="true"
            />
          );
        })}
        <line x1={xOf(initialCapital)} y1={0} x2={xOf(initialCapital)} y2={h} stroke="currentColor" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} aria-hidden="true" />
        {target != null && target >= min && target <= max && (
          <line x1={xOf(target)} y1={0} x2={xOf(target)} y2={h} stroke="#f59e0b" strokeWidth={2} strokeDasharray="3 3" aria-hidden="true" />
        )}
      </svg>

      {/* Screen-reader fallback table */}
      <table className="sr-only" aria-label="Distribution des équités finales simulées">
        <caption>Histogramme — {totalSims} simulations au total</caption>
        <thead>
          <tr>
            <th scope="col">Tranche ($)</th>
            <th scope="col">Simulations</th>
            <th scope="col">% du total</th>
            <th scope="col">Résultat</th>
          </tr>
        </thead>
        <tbody>
          {histogram.map((b, i) => (
            <tr key={i}>
              <td>{b.binStart.toFixed(0)} – {b.binEnd.toFixed(0)}</td>
              <td>{b.count}</td>
              <td>{totalSims > 0 ? ((b.count / totalSims) * 100).toFixed(1) : '0'}%</td>
              <td>{b.binEnd > initialCapital ? 'Profitable' : 'Perte'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="text-xs text-muted-foreground flex justify-between mt-1" aria-hidden="true">
        <span>${firstBin.binStart.toFixed(0)}</span>
        <span className="font-medium">${initialCapital.toFixed(0)} (initial)</span>
        {target != null && <span className="text-amber-600 font-medium">${target.toFixed(0)} (cible)</span>}
        <span>${lastBin.binEnd.toFixed(0)}</span>
      </div>
    </div>
  );
}
