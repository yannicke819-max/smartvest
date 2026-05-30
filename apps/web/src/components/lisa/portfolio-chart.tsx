'use client';

import { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { LineChart as LineChartIcon, RefreshCw } from 'lucide-react';
import { useLisaSnapshotHistory, useLisaSnapshot, useLisaConfig, useLisaPositions } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

type ChartPoint = {
  t: number;
  tFull: string;
  value: number;
  realized: number;
  returnPct: number;
  drawdown: number;
};

type TradeMarker = {
  t: number;
  value: number;
  symbol: string;
  pnlUsd: number;
  pnlPct: number;
  win: boolean;
  exitReason: string;
};

// Tooltip défini hors du composant parent pour garantir que recharts appelle
// bien le render à chaque déplacement du curseur (pas de closure capturée
// sur une data point figée).
function ChartTooltip(props: { active?: boolean; payload?: Array<{ name?: string; payload: ChartPoint | TradeMarker; dataKey?: string }> }) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;

  // LISA refonte A.5 fix — Identification robuste des markers via :
  //   1. name='winMarker'|'lossMarker' set sur <Scatter name=...>
  //   2. Fallback : payload.symbol présent (TradeMarker shape) absent (ChartPoint)
  // Avant : check uniquement .symbol fonctionnait mal car recharts inclut
  // souvent le ChartPoint en payload[0] même hover sur scatter → fallback
  // line tooltip ($10k 26 mai sur tous les dots).
  const markerEntry = payload.find((e) =>
    e.name === 'winMarker' || e.name === 'lossMarker' ||
    (e.payload as { symbol?: string }).symbol !== undefined
  );
  if (markerEntry) {
    const m = markerEntry.payload as TradeMarker;
    return (
      <div className="rounded-md border bg-card p-2 text-[11px] shadow-sm" style={{ minWidth: 180 }}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className={m.win ? 'text-emerald-600' : 'text-rose-500'}>
            {m.win ? '🟢' : '🔴'}
          </span>
          <span className="font-semibold">{m.symbol}</span>
          <span className="ml-auto text-muted-foreground font-mono text-[10px]">
            {new Date(m.t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">P&amp;L</span>
          <span className={`font-mono font-semibold tabular-nums ${m.win ? 'text-emerald-600' : 'text-rose-500'}`}>
            {m.pnlUsd >= 0 ? '+' : ''}${m.pnlUsd.toFixed(2)} ({m.pnlPct >= 0 ? '+' : ''}{m.pnlPct.toFixed(2)}%)
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Exit</span>
          <span className="font-mono text-[10px]">{m.exitReason}</span>
        </div>
      </div>
    );
  }

  const point = payload[0].payload as ChartPoint;
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
  // Live snapshot pour ajouter un point virtuel à droite du graph en
  // fallback du cron 5min. Garantit que le graph reflète TOUJOURS la
  // valeur courante affichée en haut de page.
  const liveQuery = useLisaSnapshot(portfolioId);
  // Capital initial déclaré (config Lisa) — utilisé comme baseline "Départ"
  // au lieu du premier snapshot persisté qui peut déjà inclure les frais
  // d'un premier trade (incident 27/04 : LMT ouvert puis fermé immédiatement
  // par cap classe → snapshot enregistré à 9996.40 mais inception = 10000).
  const configQuery = useLisaConfig(portfolioId);
  const inceptionCapital = configQuery.data?.capital_usd
    ? parseFloat(configQuery.data.capital_usd)
    : null;

  // LISA refonte A.5 — Trade markers : overlay des trades closés sur la courbe.
  const positionsQuery = useLisaPositions(portfolioId, false);

  const data = historyQuery.data ?? [];

  const chartData = useMemo(() => {
    const points = data.map((s) => ({
      t: new Date(s.timestamp).getTime(),
      tFull: new Date(s.timestamp).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
      // P0 hotfix — defensive coercion : Postgres numeric() columns are
      // serialized as strings by supabase-js. parseFloat est idempotent
      // sur un number JS, donc safe même quand le backend a déjà coercé.
      value: parseFloat(String(s.total_value_usd ?? '0')) || 0,
      realized: parseFloat(String(s.realized_pnl_cumulative_usd ?? '0')) || 0,
      returnPct: parseFloat(String(s.return_from_inception_pct ?? 0)) || 0,
      drawdown: parseFloat(String(s.drawdown_from_peak_pct ?? 0)) || 0,
    }));

    // Ajout point "live" : si la valeur live est plus récente que le
    // dernier snapshot persisté, on l'ajoute en queue. Si pas de live ou
    // antérieur au dernier point, on ne fait rien.
    const live = liveQuery.data;
    if (live) {
      const lastPersistedTs = points.length > 0 ? points[points.length - 1].t : 0;
      const liveTs = new Date(live.timestamp).getTime();
      const liveValue = parseFloat(live.total_value_usd);
      if (liveTs > lastPersistedTs && Number.isFinite(liveValue) && liveValue > 0) {
        const now = new Date();
        points.push({
          t: now.getTime(), // utilise now pour garantir position en queue
          tFull: now.toLocaleString('fr-FR', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          }) + ' (live)',
          value: liveValue,
          realized: parseFloat(String(live.realized_pnl_cumulative_usd ?? '0')) || 0,
          returnPct: parseFloat(String(live.return_from_inception_pct ?? 0)) || 0,
          drawdown: parseFloat(String(live.drawdown_from_peak_pct ?? 0)) || 0,
        });
      }
    }

    return points;
  }, [data, liveQuery.data]);

  // LISA refonte A.5 — Compute trade markers (1 dot par close dans la fenêtre).
  // value (Y) = valeur de la courbe interpolée au timestamp d'exit (sinon on
  // perd la cohérence visuelle avec la ligne).
  const tradeMarkers = useMemo<TradeMarker[]>(() => {
    if (chartData.length === 0) return [];
    const positions = positionsQuery.data ?? [];
    const minT = chartData[0].t;
    const maxT = chartData[chartData.length - 1].t;
    const closed = positions.filter((p) => {
      if (p.status === 'open' || !p.exitTimestamp) return false;
      const t = new Date(p.exitTimestamp).getTime();
      return t >= minT && t <= maxT;
    });
    return closed.map((p) => {
      const t = new Date(p.exitTimestamp!).getTime();
      // Interpolation linéaire entre les 2 points de chartData entourant t
      let value = chartData[chartData.length - 1].value;
      for (let i = 0; i < chartData.length - 1; i++) {
        const a = chartData[i];
        const b = chartData[i + 1];
        if (t >= a.t && t <= b.t) {
          const ratio = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
          value = a.value + (b.value - a.value) * ratio;
          break;
        }
      }
      const pnlUsd = parseFloat(p.realizedPnlUsd ?? '0') || 0;
      return {
        t,
        value,
        symbol: p.symbol,
        pnlUsd,
        pnlPct: p.realizedPnlPct ?? 0,
        win: pnlUsd > 0,
        exitReason: (p.exitReason ?? p.status).slice(0, 40),
      };
    });
  }, [chartData, positionsQuery.data]);
  const winMarkers = useMemo(() => tradeMarkers.filter((m) => m.win), [tradeMarkers]);
  const lossMarkers = useMemo(() => tradeMarkers.filter((m) => !m.win), [tradeMarkers]);

  const hasData = chartData.length > 1;
  const latestValue = chartData[chartData.length - 1]?.value ?? 0;
  // Baseline = capital initial (inception) si dispo, sinon fallback sur le
  // premier snapshot. Évite que la ligne "Départ" pointe vers un snapshot
  // qui inclurait déjà des frais/trades (cf. incident 27/04 :
  // 1er snapshot = 9996.40 alors que capital initial = 10000).
  const firstSnapshotValue = chartData[0]?.value ?? 0;
  const baselineValue = inceptionCapital ?? firstSnapshotValue;
  const periodReturn = baselineValue > 0 ? ((latestValue - baselineValue) / baselineValue) * 100 : 0;

  // P10-FIX — Y-axis ancré sur la baseline (capital initial).
  // Avant : auto-scale + 15% padding → courbe désaxée, baseline 10000 invisible
  //         si la fenêtre observée reste collée au capital initial. User
  //         report : drawdown 0.12% lu visuellement comme chute massive.
  // Après : domain garanti d'inclure la baseline, padding multiplicatif
  //         autour [baseline*0.998 .. baseline*1.002] minimum.
  const yDomain = useMemo((): [number | 'auto', number | 'auto'] => {
    if (chartData.length === 0) return ['auto', 'auto'];
    const values = chartData.map((d) => d.value);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const baseline = inceptionCapital ?? 10000;
    // Lower bound : min(baseline, dataMin) * 0.998
    // Upper bound : max(baseline, dataMax) * 1.002
    const lower = Math.min(baseline, dataMin) * 0.998;
    const upper = Math.max(baseline, dataMax) * 1.002;
    return [Math.max(0, lower), upper];
  }, [chartData, inceptionCapital]);

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
        <div
          className="h-72 w-full"
          role="img"
          aria-label={`Évolution du capital sur ${WINDOW_LABELS[window]} : départ ${baselineValue.toFixed(0)} USD, valeur courante ${latestValue.toFixed(0)} USD, ${periodReturn >= 0 ? 'gain' : 'perte'} de ${Math.abs(periodReturn).toFixed(2)}%`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
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
                shared={false}
                trigger="hover"
              />
              <ReferenceLine
                y={baselineValue}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                opacity={0.6}
                label={{
                  value: `Baseline ${formatBaselineLabel(baselineValue)}`,
                  position: 'right',
                  fontSize: 10,
                  fill: '#94a3b8',
                  opacity: 0.9,
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
              {/* LISA refonte A.5 — Trade markers overlay. name=winMarker/lossMarker
                  utilisé par ChartTooltip pour distinguer scatter vs line. */}
              {winMarkers.length > 0 && (
                <Scatter
                  name="winMarker"
                  data={winMarkers}
                  dataKey="value"
                  fill="#10b981"
                  stroke="#065f46"
                  strokeWidth={1}
                  shape="circle"
                  legendType="none"
                  r={6}
                />
              )}
              {lossMarkers.length > 0 && (
                <Scatter
                  name="lossMarker"
                  data={lossMarkers}
                  dataKey="value"
                  fill="#ef4444"
                  stroke="#7f1d1d"
                  strokeWidth={1}
                  shape="circle"
                  legendType="none"
                  r={6}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {hasData && tradeMarkers.length > 0 && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground -mt-2">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Trade gagnant ({winMarkers.length})
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-rose-500" /> Trade perdant ({lossMarkers.length})
          </span>
        </div>
      )}

      {hasData && (
        <table className="sr-only" aria-label="Données de la courbe d'équité">
          <caption>{`Évolution du capital — ${WINDOW_LABELS[window]} (échantillon)`}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Valeur (USD)</th>
              <th scope="col">Return (%)</th>
            </tr>
          </thead>
          <tbody>
            {sampleChartPoints(chartData).map((p) => (
              <tr key={p.t}>
                <td>{p.tFull}</td>
                <td>{p.value.toFixed(2)}</td>
                <td>{p.returnPct.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Sample up to 10 points from a chart series for screen-reader fallback. */
function sampleChartPoints(points: ChartPoint[]): ChartPoint[] {
  if (points.length <= 10) return points;
  const step = Math.max(1, Math.floor(points.length / 10));
  const sampled = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1]!;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

/**
 * P10-FIX — Format compact pour le label baseline ("10.0k", "100k", "1.0M").
 */
function formatBaselineLabel(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(0);
}
