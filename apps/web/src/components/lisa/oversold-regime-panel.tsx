'use client';

import { useEffect, useState } from 'react';
import { Gauge, Clock, Activity, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useOversoldRegime, type OversoldRegimeStatus } from '@/hooks/use-oversold-regime';
import { apiFetch } from '@/lib/api-client';

/**
 * PR-2 — Panel régime de marché du mode OVERSOLD (remplace la pollution gainers).
 *
 * Thermomètre LIVE des indicateurs qui pilotent le gate d'entrée mean-reversion :
 * volatilité (VIX / V2TX), son accélération 1j, et le rendement 5j de l'indice
 * (SPY / SX5E). Chaque indicateur est coloré selon qu'il franchit ou non son
 * seuil. Affiche le verdict global (scan ouvert / bloqué), le régime de rotation
 * sectorielle, et un compte à rebours vers le prochain scan programmé.
 */
export function OversoldRegimePanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldRegime(portfolioId);

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        🌡️ Chargement du régime de marché…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        🌡️ Régime de marché indisponible pour le moment.
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-purple-600" />
          <h2 className="text-sm font-medium">
            🌡️ Régime de marché — {data.region} ({data.universe})
          </h2>
        </div>
        <Verdict data={data} />
      </div>

      {/* Thermomètre 3 indicateurs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Thermo
          label={`${data.vixLabel} (volatilité)`}
          value={data.vix}
          fmt={(n) => n.toFixed(2)}
          threshold={`max ${data.thresholds.vixMax}`}
          breach={data.vix != null && data.vix > data.thresholds.vixMax}
          tag={data.vixSource === 'live' ? 'live' : 'EOD J-1'}
        />
        <Thermo
          label={`Δ${data.vixLabel} 1j`}
          value={data.vixChgPct}
          fmt={(n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`}
          threshold={`max +${data.thresholds.vixDeltaMax}%`}
          breach={data.vixChgPct != null && data.vixChgPct > data.thresholds.vixDeltaMax}
        />
        <Thermo
          label={`${data.idxLabel} 5j`}
          value={data.idx5dPct}
          fmt={(n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`}
          threshold={`min ${data.thresholds.idx5dMin}%`}
          breach={data.idx5dPct != null && data.idx5dPct < data.thresholds.idx5dMin}
        />
      </div>

      {/* Rotation sectorielle + compte à rebours */}
      <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          {data.rotation && data.rotation.regime ? (
            <span className="text-muted-foreground">
              Rotation sectorielle :{' '}
              <span
                className={
                  data.rotation.regime === 'defensive' ? 'text-amber-600 font-medium' : 'text-emerald-600 font-medium'
                }
              >
                {data.rotation.regime === 'defensive' ? 'défensive' : 'offensive'}
              </span>
              {data.rotation.spreadPct != null && ` (${data.rotation.spreadPct >= 0 ? '+' : ''}${data.rotation.spreadPct.toFixed(1)}%)`}
              {data.rotation.appliedVixPenalty > 0 && (
                <span className="text-amber-600"> · seuil VIX durci −{data.rotation.appliedVixPenalty}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">Rotation sectorielle : —</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ForceScanButton portfolioId={portfolioId} />
          <Countdown iso={data.nextScanUtc} kind={data.nextScanKind} />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        {data.enabled
          ? 'Le scan oversold s’abstient automatiquement quand le régime est hostile (volatilité élevée + indice en repli) — les meilleurs rebonds J+10 sortent en marché calme.'
          : 'Gate régime désactivé (OVERSOLD_REGIME_GATE_ENABLED=false) : le scan ouvre quel que soit le régime.'}{' '}
        MAJ : {new Date(data.asOf).toLocaleTimeString('fr-FR')}.
      </p>
    </div>
  );
}

function Verdict({ data }: { data: OversoldRegimeStatus }) {
  if (!data.enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        ⚪ Gate désactivé
      </span>
    );
  }
  if (data.block) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600">
        <ShieldAlert className="h-3 w-3" /> Hostile — scan bloqué
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
      <ShieldCheck className="h-3 w-3" /> Favorable — scan ouvert
    </span>
  );
}

function Thermo(props: {
  label: string;
  value: number | null;
  fmt: (n: number) => string;
  threshold: string;
  breach: boolean;
  tag?: string;
}) {
  const { label, value, fmt, threshold, breach, tag } = props;
  const valueCls = value == null ? 'text-muted-foreground' : breach ? 'text-red-600' : 'text-emerald-600';
  return (
    <div className={`rounded-md border p-2 ${breach ? 'border-red-500/40 bg-red-500/5' : ''}`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
        {tag && (
          <span className="text-[9px] uppercase tracking-wide text-muted-foreground border rounded px-1">
            {tag}
          </span>
        )}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>
        {value == null ? '—' : fmt(value)}
      </div>
      <div className="text-[10px] text-muted-foreground">seuil {threshold}</div>
    </div>
  );
}

/**
 * Bouton "Forcer le scan" — déclenche un scan intraday immédiat (bypass de la
 * cadence 15 min) via POST /lisa/oversold/scan-now?phase=intraday. Ouvre les
 * positions sur les rebonds confirmés sans attendre le prochain cron. Rafraîchit
 * positions + book + régime après coup.
 */
function ForceScanButton({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  const run = async () => {
    if (state === 'running') return;
    setState('running');
    try {
      await apiFetch('/lisa/oversold/scan-now?phase=intraday', { method: 'POST' });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['lisa', 'positions', portfolioId] }),
        qc.invalidateQueries({ queryKey: ['lisa', 'open-positions-live', portfolioId] }),
        qc.invalidateQueries({ queryKey: ['lisa', 'oversold-summary', portfolioId] }),
        qc.invalidateQueries({ queryKey: ['lisa', 'oversold-regime', portfolioId] }),
      ]);
      setState('done');
      setTimeout(() => setState('idle'), 4000);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  return (
    <button
      onClick={run}
      disabled={state === 'running'}
      title="Force un scan intraday immédiat (bypass la cadence). Ouvre les positions sur rebonds confirmés."
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60 transition-colors"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${state === 'running' ? 'animate-spin' : ''}`} />
      {state === 'running'
        ? 'Scan en cours…'
        : state === 'done'
          ? '✅ Scan lancé'
          : state === 'error'
            ? '❌ Échec'
            : 'Forcer le scan'}
    </button>
  );
}

function Countdown({ iso, kind }: { iso: string; kind: 'intraday' | 'daily' }) {
  const [now, setNow] = useState<number | null>(null);
  // Client-only : démarre après montage pour éviter un mismatch SSR (Date.now
  // diffère serveur/client) et n'afficher le timer qu'avec l'heure du client.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const target = new Date(iso).getTime();
  let remaining = '—';
  if (now != null) {
    const ms = Math.max(0, target - now);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    remaining = h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  }

  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <Clock className="h-3.5 w-3.5" />
      <span>
        Prochain scan ({kind === 'daily' ? 'EOD' : 'intraday'}) dans{' '}
        <span className="font-mono font-medium text-foreground tabular-nums">{remaining}</span>
      </span>
    </div>
  );
}
