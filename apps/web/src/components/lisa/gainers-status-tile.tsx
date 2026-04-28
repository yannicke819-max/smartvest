'use client';

import { Rocket, TrendingUp, TrendingDown } from 'lucide-react';
import { useGainersStatus, useOperatingMode } from '@/hooks/use-operating-mode';

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
    </div>
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
