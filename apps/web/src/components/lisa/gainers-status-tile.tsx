'use client';

import { useState } from 'react';
import { Rocket, TrendingUp, TrendingDown } from 'lucide-react';
import {
  useGainersStatus,
  useOperatingMode,
  usePersistenceSnapshot,
} from '@/hooks/use-operating-mode';

/**
 * P7-MODE-GAINERS-BADGE — Mini-tile sous le badge GAINERS actif.
 *
 * Affiche en temps réel (poll 30s) :
 *   - Countdown vers prochain scan (mm:ss)
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
            <Stat
              label="Prochain scan"
              value={formatCountdown(data.nextTickInSeconds)}
              hint={`Cycle ${data.intervalMinutes} min`}
            />
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

      {/* P8 — Multi-TF persistence snapshot */}
      <PersistencePanel portfolioId={portfolioId} />
    </div>
  );
}

/**
 * P8 — Slider topN + summary counters par TF.
 * Réponse littérale à la question user "20 valeurs en hausse 1min,
 * combien sont aussi en hausse 5/10/15/30/60min ?".
 */
function PersistencePanel({ portfolioId }: { portfolioId: string }) {
  const [topN, setTopN] = useState(20);
  const snapQuery = usePersistenceSnapshot(portfolioId, topN, true);
  const data = snapQuery.data;

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
        <div className="flex items-center gap-2">
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
          />
          <span className="text-xs font-medium tabular-nums w-8 text-right">{topN}</span>
        </div>
      </div>

      {snapQuery.isLoading && (
        <p className="text-xs text-muted-foreground">Calcul en cours…</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(
              [
                ['1m', data.summary.oneMinute],
                ['5m', data.summary.fiveMinutes],
                ['10m', data.summary.tenMinutes],
                ['15m', data.summary.fifteenMinutes],
                ['30m', data.summary.thirtyMinutes],
                ['1h', data.summary.oneHour],
              ] as Array<[string, number]>
            ).map(([label, count]) => (
              <SummaryCell
                key={label}
                label={label}
                count={count}
                total={data.candidates.length}
              />
            ))}
          </div>

          {data.candidates.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Top {data.candidates.length} candidats
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
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map((c) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            Snapshot {new Date(data.capturedAt).toLocaleTimeString()} · refresh 60s
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
