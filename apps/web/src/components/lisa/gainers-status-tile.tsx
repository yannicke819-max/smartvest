'use client';

import { useEffect, useState } from 'react';
import { Rocket, TrendingUp, TrendingDown } from 'lucide-react';
import {
  useGainersStatus,
  useOperatingMode,
  usePersistenceSnapshot,
  useUpdateGainersCycle,
  type PathQualityByTf,
  type PersistenceCandidate,
} from '@/hooks/use-operating-mode';

const CYCLE_OPTIONS = [1, 5, 10, 15, 20, 30, 45, 60];

/**
 * P7-MODE-GAINERS-BADGE — Mini-tile sous le badge GAINERS actif.
 * P9-UX : selector de cycle + slider topN dynamique + path quality badge.
 *
 * Affiche en temps réel (poll 30s) :
 *   - Selector "Fréquence scan" (1, 5, 10, 15, 20, 30, 45, 60 min) → DB write
 *   - Countdown vers prochain scan (mm:ss) basé sur cycle DB
 *   - Positions ouvertes / max
 *   - PnL session UTC (vert si >0, rouge si <0)
 *   - 3 derniers candidats vus (top score du dernier tick)
 *
 * Rendu uniquement quand strategy_mode='gainers'. Auto-masqué sinon.
 */
export function GainersStatusTile({ portfolioId }: { portfolioId: string }) {
  const modeQuery = useOperatingMode(portfolioId);
  const isGainersMode = modeQuery.data?.mode === 'gainers';
  const statusQuery = useGainersStatus(portfolioId, isGainersMode);

  if (!isGainersMode) return null;

  const data = statusQuery.data;

  return (
    <div className="rounded-lg border border-orange-200 dark:border-orange-900/40 bg-orange-50/40 dark:bg-orange-950/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Rocket className="h-4 w-4 text-orange-600" />
        <h3 className="text-sm font-medium">Scanner Gainers · état temps réel</h3>
      </div>

      {!data && (
        <p className="text-xs text-muted-foreground">Chargement…</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Prochain scan
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {formatCountdown(data.nextTickInSeconds)}
              </p>
              <CycleSelector
                portfolioId={portfolioId}
                currentCycle={data.intervalMinutes}
              />
            </div>
            <Stat
              label="Positions ouvertes"
              value={`${data.openPositions} / ${data.maxPositions}`}
              hint={data.openPositions >= data.maxPositions ? 'Plein' : 'Slots disponibles'}
            />
            <Stat
              label="PnL session"
              value={formatPnl(data.sessionPnlUsd)}
              valueClass={
                data.sessionPnlUsd > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : data.sessionPnlUsd < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground'
              }
              hint="Réalisé · UTC"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Derniers candidats scannés
            </p>
            {data.lastCandidates.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Aucun scan terminé pour l&apos;instant. Le premier cycle s&apos;exécute dans quelques minutes.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {data.lastCandidates.map((c) => {
                  const positive = c.changePct >= 0;
                  const Icon = positive ? TrendingUp : TrendingDown;
                  return (
                    <li
                      key={c.symbol}
                      className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
                    >
                      <Icon
                        className={`h-3 w-3 ${
                          positive ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      />
                      <span className="font-medium">{c.symbol}</span>
                      <span
                        className={positive ? 'text-emerald-600' : 'text-red-600'}
                      >
                        {positive ? '+' : ''}
                        {c.changePct.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground">
                        ·&nbsp;score {c.score.toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {/* P8 + P9-UX — Multi-TF persistence snapshot */}
      <PersistencePanel portfolioId={portfolioId} />
    </div>
  );
}

/**
 * P9-UX — Selector "Fréquence scan" (replace "Cycle X min" hardcoded).
 * 8 valeurs préconfigurées : 1, 5, 10, 15, 20, 30, 45, 60. POST DB
 * lisa_session_configs.gainers_cycle_minutes via useUpdateGainersCycle.
 *
 * Toast d'avertissement si user choisit 1 min (coût API ×15 vs 15 min).
 */
function CycleSelector({
  portfolioId,
  currentCycle,
}: {
  portfolioId: string;
  currentCycle: number;
}) {
  const mut = useUpdateGainersCycle(portfolioId);
  const [warn, setWarn] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = parseInt(e.target.value, 10);
    if (!Number.isFinite(next)) return;
    if (next === 1) {
      setWarn('Coût API ×15 vs 15 min — surveille daily_cost_budget_usd');
    } else if (next < 5) {
      setWarn('Cycle < 5 min — risque rate-limit EODHD/Binance');
    } else {
      setWarn(null);
    }
    mut.mutate(next);
  };

  return (
    <div className="space-y-0.5">
      <label className="text-[10px] text-muted-foreground flex items-center gap-1">
        <span>Fréquence scan</span>
        {mut.isPending && <span className="text-orange-600">…</span>}
      </label>
      <select
        value={currentCycle}
        onChange={handleChange}
        disabled={mut.isPending}
        className="h-6 rounded border bg-background px-1.5 text-xs"
        aria-label="Fréquence du scanner Gainers"
      >
        {CYCLE_OPTIONS.map((min) => (
          <option key={min} value={min}>{min} min</option>
        ))}
      </select>
      {warn && (
        <p className="text-[10px] text-amber-700 dark:text-amber-500">⚠ {warn}</p>
      )}
    </div>
  );
}

/**
 * P8 + P9-UX — Slider topN + summary counters par TF + path quality badge.
 *
 * P9-UX changements :
 * - Titre "Top {N} candidats" interpolé (au lieu de "Top 10" hardcoded)
 * - Slice tableau à N lignes
 * - Summary counters use N comme denominator
 * - Sous-titre "Top {N} en hausse 1min"
 * - Debounce slider 300ms avant refetch
 * - Colonne Path avec badge 🟢/🟡/🔴
 * - Toggle "Cacher choppy" filtre client-side
 */
function PersistencePanel({ portfolioId }: { portfolioId: string }) {
  const [topN, setTopN] = useState(20);
  const [debouncedTopN, setDebouncedTopN] = useState(20);
  const [hideChoppy, setHideChoppy] = useState(false);

  // P9-UX — Debounce 300ms : évite spam backend lors du drag du slider.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTopN(topN), 300);
    return () => clearTimeout(id);
  }, [topN]);

  const snapQuery = usePersistenceSnapshot(portfolioId, debouncedTopN, true);
  const data = snapQuery.data;

  // Filtre client-side choppy
  const visibleCandidates: PersistenceCandidate[] = data
    ? hideChoppy
      ? data.candidates.filter(
          (c) => c.pathQuality?.overallSmoothness !== 'choppy',
        )
      : data.candidates
    : [];
  // Slice à topN (le backend peut retourner moins si données insuffisantes)
  const sliced = visibleCandidates.slice(0, topN);

  // Summary recalculé sur sliced pour cohérence avec ce qu'on affiche
  const recomputedSummary = data
    ? {
        oneMinute: sliced.filter((c) => (c.tf1m ?? 0) > 0).length,
        fiveMinutes: sliced.filter((c) => (c.tf5m ?? 0) > 0).length,
        tenMinutes: sliced.filter((c) => (c.tf10m ?? 0) > 0).length,
        fifteenMinutes: sliced.filter((c) => (c.tf15m ?? 0) > 0).length,
        thirtyMinutes: sliced.filter((c) => (c.tf30m ?? 0) > 0).length,
        oneHour: sliced.filter((c) => (c.tf1h ?? 0) > 0).length,
      }
    : null;

  return (
    <div className="rounded-md border bg-background/60 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Persistance multi-TF
          </p>
          <p className="text-[11px] text-muted-foreground italic">
            Top {topN} en hausse 1min · combien sont aussi en hausse 5m/10m/15m/30m/1h ?
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[11px] text-muted-foreground">N=</label>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={topN}
            onChange={(e) => setTopN(parseInt(e.target.value, 10))}
            className="w-32"
            aria-label="Nombre de valeurs scannées"
            list="topN-ticks"
          />
          <datalist id="topN-ticks">
            {[5, 10, 20, 50, 100].map((tick) => (
              <option key={tick} value={tick} />
            ))}
          </datalist>
          <span className="text-xs font-medium tabular-nums w-8 text-right">{topN}</span>
          <label className="flex items-center gap-1 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              checked={hideChoppy}
              onChange={(e) => setHideChoppy(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Cacher choppy</span>
          </label>
        </div>
      </div>

      {snapQuery.isLoading && (
        <p className="text-xs text-muted-foreground">Calcul en cours…</p>
      )}

      {data && recomputedSummary && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(
              [
                ['1m', recomputedSummary.oneMinute],
                ['5m', recomputedSummary.fiveMinutes],
                ['10m', recomputedSummary.tenMinutes],
                ['15m', recomputedSummary.fifteenMinutes],
                ['30m', recomputedSummary.thirtyMinutes],
                ['1h', recomputedSummary.oneHour],
              ] as Array<[string, number]>
            ).map(([label, count]) => (
              <SummaryCell
                key={label}
                label={label}
                count={count}
                total={topN}
              />
            ))}
          </div>

          {sliced.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Top {topN} candidats {sliced.length < topN ? `(${sliced.length} dispos)` : ''}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left pr-2 font-medium">Symbol</th>
                      <th className="text-right px-1 font-medium">1m</th>
                      <th className="text-right px-1 font-medium">5m</th>
                      <th className="text-right px-1 font-medium">10m</th>
                      <th className="text-right px-1 font-medium">15m</th>
                      <th className="text-right px-1 font-medium">30m</th>
                      <th className="text-right px-1 font-medium">1h</th>
                      <th className="text-right pl-1 font-medium">Score</th>
                      <th className="text-right pl-1 font-medium">Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sliced.map((c) => (
                      <tr key={c.symbol} className="border-t">
                        <td className="text-left pr-2 font-medium py-0.5">{c.symbol}</td>
                        <Cell value={c.tf1m} />
                        <Cell value={c.tf5m} />
                        <Cell value={c.tf10m} />
                        <Cell value={c.tf15m} />
                        <Cell value={c.tf30m} />
                        <Cell value={c.tf1h} />
                        <td className="text-right pl-1 py-0.5">
                          {c.persistenceCount ?? '—'}
                        </td>
                        <td className="text-right pl-1 py-0.5">
                          <PathBadge pq={c.pathQuality ?? null} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            Snapshot {new Date(data.capturedAt).toLocaleTimeString()} · refresh 60s · debounce slider 300ms
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCell({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const pct = total > 0 ? count / total : 0;
  return (
    <div className="rounded-md border bg-background p-2 text-center space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`text-base font-semibold tabular-nums ${
          pct >= 0.7
            ? 'text-emerald-600'
            : pct >= 0.4
              ? 'text-amber-600'
              : 'text-muted-foreground'
        }`}
      >
        {count}
        <span className="text-[10px] text-muted-foreground"> /{total}</span>
      </p>
    </div>
  );
}

function Cell({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <td className="text-right px-1 text-muted-foreground/50 py-0.5">—</td>
    );
  }
  const positive = value > 0;
  return (
    <td
      className={`text-right px-1 py-0.5 ${
        positive ? 'text-emerald-600' : value < 0 ? 'text-red-600' : 'text-muted-foreground'
      }`}
    >
      {positive ? '+' : ''}
      {value.toFixed(1)}
    </td>
  );
}

/**
 * P9-UX ADDENDUM — Path quality badge avec tooltip (hover).
 * 🟢 smooth (efficiency≥0.7 + pullback≤1%)
 * 🟡 mixed
 * 🔴 choppy (efficiency<0.4 OU pullback>2%)
 */
function PathBadge({ pq }: { pq: PathQualityByTf | null }) {
  if (!pq || !pq.overallSmoothness) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const emoji =
    pq.overallSmoothness === 'smooth' ? '🟢'
    : pq.overallSmoothness === 'mixed' ? '🟡'
    : '🔴';
  const tooltip = pq.overallEfficiency != null
    ? `eff ${(pq.overallEfficiency * 100).toFixed(0)}% · ${pq.overallSmoothness}`
    : pq.overallSmoothness;
  return (
    <span title={tooltip} className="cursor-help">
      {emoji}
    </span>
  );
}

function Stat(props: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {props.label}
      </p>
      <p className={`text-lg font-semibold tabular-nums ${props.valueClass ?? ''}`}>
        {props.value}
      </p>
      {props.hint && <p className="text-[10px] text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec.toString().padStart(2, '0')}s`;
}

function formatPnl(usd: number): string {
  const sign = usd > 0 ? '+' : usd < 0 ? '−' : '';
  const abs = Math.abs(usd);
  return `${sign}$${abs.toFixed(2)}`;
}
