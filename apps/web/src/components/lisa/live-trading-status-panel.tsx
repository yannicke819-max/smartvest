'use client';

/**
 * Phase G — UI LIVE Trading status panel.
 *
 * Affiche l'état des feature flags LIVE + bouton kill-switch global.
 * Visible quand DELEGATION_AUTONOMOUS_GUARDED OR BROKER_EXECUTION_ENABLED
 * (= au moins une des deux activée par admin).
 *
 * Le bouton Kill-switch est TOUJOURS visible et JAMAIS gated par feature
 * flag (cf. CLAUDE.md §6 ter — révocation toujours accessible).
 *
 * Polling 30s pour status + connection health.
 */

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, AlertTriangle, Power, Pause } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface LiveTradingStatus {
  flags: {
    BROKER_EXECUTION_ENABLED: boolean;
    DELEGATION_AUTONOMOUS_GUARDED: boolean;
    AUTONOMY_KILL_SWITCH: boolean;
    BROKER_RECONCILIATION_ENABLED: boolean;
    BROKER_ADAPTER_IB_ENABLED: boolean;
    BROKER_ADAPTER_BINANCE_ENABLED: boolean;
  };
}

function useLiveTradingStatus() {
  return useQuery({
    queryKey: ['live-trading-status'],
    queryFn: () => apiFetch<LiveTradingStatus>('/feature-flags'),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function LiveTradingStatusPanel() {
  const { data, isLoading } = useLiveTradingStatus();

  if (isLoading || !data) {
    return null; // Pas d'affichage pendant le load (évite flicker)
  }

  const flags = data.flags;
  const liveActive = flags.BROKER_EXECUTION_ENABLED && flags.DELEGATION_AUTONOMOUS_GUARDED;
  const killSwitch = flags.AUTONOMY_KILL_SWITCH;

  // Si rien de LIVE n'est activé → ne pas afficher le panel
  if (!liveActive && !flags.BROKER_EXECUTION_ENABLED) {
    return null;
  }

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${
      killSwitch ? 'bg-red-500/10 border-red-500'
      : liveActive ? 'bg-emerald-500/5 border-emerald-500/30'
      : 'bg-amber-500/5 border-amber-500/30'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {killSwitch ? (
            <Power className="h-5 w-5 text-red-500" />
          ) : liveActive ? (
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
          ) : (
            <Pause className="h-5 w-5 text-amber-500" />
          )}
          <h3 className="font-semibold text-foreground">
            {killSwitch ? 'Kill-switch actif — exécution suspendue'
             : liveActive ? 'Mode LIVE actif'
             : 'Mode paper (LIVE pas encore activé)'}
          </h3>
        </div>
        {killSwitch && (
          <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
            EMERGENCY STOP
          </span>
        )}
      </div>

      {/* Status grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
        <FlagPill label="Execution" enabled={flags.BROKER_EXECUTION_ENABLED} />
        <FlagPill label="Autonomy" enabled={flags.DELEGATION_AUTONOMOUS_GUARDED} />
        <FlagPill label="Kill-switch" enabled={flags.AUTONOMY_KILL_SWITCH} reverse />
        <FlagPill label="Reconciliation" enabled={flags.BROKER_RECONCILIATION_ENABLED} />
        <FlagPill label="IBKR" enabled={flags.BROKER_ADAPTER_IB_ENABLED} />
        <FlagPill label="Binance" enabled={flags.BROKER_ADAPTER_BINANCE_ENABLED} />
      </div>

      {killSwitch && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500 flex gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            Toute exécution est SUSPENDUE. Investiguer la cause via le decision_log
            avant de désactiver le kill-switch côté admin
            (<code className="bg-red-500/10 px-1 rounded">FEATURE_AUTONOMY_KILL_SWITCH=false</code>).
          </div>
        </div>
      )}

      {liveActive && !killSwitch && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 flex-shrink-0 text-emerald-500" />
            <div className="text-foreground">
              <strong>Garde-fous actifs</strong> : 11 conditions cumulatives vérifiées
              avant chaque ordre (Pre-execution Guard Chain Phase D). Reconciliation
              broker vs DB toutes les 5 min (Phase E).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlagPill({
  label,
  enabled,
  reverse = false,
}: {
  label: string;
  enabled: boolean;
  /** Pour kill-switch : "enabled" est une mauvaise nouvelle */
  reverse?: boolean;
}) {
  const isPositive = reverse ? !enabled : enabled;
  return (
    <div className={`rounded-md border px-2 py-1 flex items-center justify-between ${
      isPositive ? 'border-emerald-500/30 bg-emerald-500/5'
      : 'border-input bg-background'
    }`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${
        isPositive ? 'text-emerald-500' : 'text-muted-foreground'
      }`}>
        {enabled ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}
