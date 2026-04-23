'use client';

import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Zap, AlertTriangle, TrendingUp, TrendingDown, Minus, Clock, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LisaAgentStatus, MechanicalCycleSummary, AgentAction } from '@/hooks/use-lisa';

interface Props {
  data: LisaAgentStatus | undefined;
  isLoading: boolean;
}

function fmt(n: number | null | undefined, decimals = 2, prefix = '') {
  if (n == null) return 'n/a';
  return `${prefix}${n.toFixed(decimals)}`;
}

function pnlColor(n: number | null | undefined) {
  if (n == null) return 'text-muted-foreground';
  return n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500';
}

const KIND_LABELS: Record<string, { label: string; color: string }> = {
  mechanical_open: { label: 'OPEN', color: 'text-blue-600 dark:text-blue-400' },
  mechanical_close_stop: { label: 'STOP', color: 'text-red-500' },
  mechanical_close_target: { label: 'TARGET', color: 'text-emerald-600 dark:text-emerald-400' },
  mechanical_close_invalidated: { label: 'INVALIDE', color: 'text-orange-500' },
  mechanical_skip: { label: 'SKIP', color: 'text-muted-foreground' },
  autopilot_cycle_completed: { label: 'CYCLE', color: 'text-muted-foreground' },
  mechanical_override_applied: { label: 'OVERRIDE', color: 'text-purple-600 dark:text-purple-400' },
};

const MOMENTUM_LABELS: Record<string, string> = {
  bullish_strong: '🟢 Haussier fort',
  bullish: '🟡 Haussier',
  neutral: '⚪ Neutre',
  bearish: '🔴 Baissier',
};

const TRAJECTORY_LABELS: Record<string, { label: string; color: string }> = {
  EN_AVANCE: { label: '🚀 En avance', color: 'text-emerald-600 dark:text-emerald-400' },
  DANS_LE_PLAN: { label: '✅ Dans le plan', color: 'text-blue-600 dark:text-blue-400' },
  EN_RETARD: { label: '⏳ En retard', color: 'text-orange-500' },
  HORS_TRAJECTOIRE: { label: '🔴 Hors trajectoire', color: 'text-red-500' },
};

function DirectiveSection({ directive }: { directive: LisaAgentStatus['directive'] }) {
  if (!directive) {
    return (
      <div className="text-sm text-muted-foreground italic">
        Aucune directive active — lancez une proposition Lisa pour démarrer l'agent.
      </div>
    );
  }

  const overrides = directive.tactical_overrides ?? {};
  const hasOverrides = Object.keys(overrides).length > 0;
  const trajectoryInfo = TRAJECTORY_LABELS[directive.trajectory_status] ?? { label: directive.trajectory_status, color: '' };
  const validUntil = directive.valid_until ? new Date(directive.valid_until) : null;
  const isExpired = validUntil ? validUntil < new Date() : false;
  const generatedAgo = Math.round((Date.now() - new Date(directive.generated_at).getTime()) / 60000);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-muted-foreground">Momentum</span>
          <p className="font-medium">{MOMENTUM_LABELS[directive.market_momentum] ?? directive.market_momentum}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Trajectoire</span>
          <p className={`font-medium ${trajectoryInfo.color}`}>{trajectoryInfo.label}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Posture de risque</span>
          <p className="font-medium capitalize">{directive.risk_posture?.replace(/_/g, ' ') ?? 'n/a'}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Directive âgée de</span>
          <p className={`font-medium ${isExpired ? 'text-red-500' : ''}`}>
            {generatedAgo} min {isExpired ? '(expirée)' : ''}
          </p>
        </div>
      </div>

      {directive.target_symbols?.length > 0 && (
        <div className="text-sm">
          <span className="text-muted-foreground">Symboles cibles</span>
          <p className="font-mono text-xs mt-0.5">{directive.target_symbols.join(', ')}</p>
        </div>
      )}

      {hasOverrides && (
        <div className="rounded-md bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 p-2 text-xs space-y-1">
          <p className="font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1">
            <Zap className="h-3 w-3" /> Overrides [AGENT] actifs
          </p>
          {overrides.pauseOpens === true && (
            <p className="text-purple-600 dark:text-purple-400">
              ⛔ Ouvertures pausées — {String(overrides.pauseOpensReason ?? 'signal actif')}
            </p>
          )}
          {overrides.tightenStopsMultiplier != null && (overrides.tightenStopsMultiplier as number) < 1 && (
            <p className="text-purple-600 dark:text-purple-400">
              🎯 Stops resserrés ×{Number(overrides.tightenStopsMultiplier).toFixed(2)}
            </p>
          )}
          {overrides.minConvictionOverride != null && (
            <p className="text-purple-600 dark:text-purple-400">
              📊 Conviction min override : {String(overrides.minConvictionOverride)}/10
            </p>
          )}
          {overrides.maxNewOpensOverride != null && (
            <p className="text-purple-600 dark:text-purple-400">
              🔒 Max ouvertures/cycle : {String(overrides.maxNewOpensOverride)}
            </p>
          )}
          {overrides.closeLowestConvictionIfExposureAbovePct != null && (
            <p className="text-purple-600 dark:text-purple-400">
              📉 Ferme plus faible conviction si exposition &gt; {String(overrides.closeLowestConvictionIfExposureAbovePct)}%
            </p>
          )}
          {Array.isArray(overrides.preferredAssetClasses) && (overrides.preferredAssetClasses as string[]).length > 0 && (
            <p className="text-purple-600 dark:text-purple-400">
              🛡️ Classes préférées : {(overrides.preferredAssetClasses as string[]).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle }: { cycle: MechanicalCycleSummary }) {
  const ago = Math.round((Date.now() - new Date(cycle.cycle_at).getTime()) / 60000);
  const pnl = Number(cycle.net_pnl_since_proposal_usd);

  return (
    <tr className="border-b border-border/50 text-xs hover:bg-muted/30">
      <td className="py-1.5 pr-2 text-muted-foreground whitespace-nowrap">
        {ago < 60 ? `${ago}min` : `${Math.round(ago / 60)}h`}
      </td>
      <td className="pr-2">
        <span className="text-blue-600 dark:text-blue-400">+{cycle.opens_count}</span>
        {' / '}
        <span className={cycle.closes_stop_count > 0 ? 'text-red-500' : ''}>
          ✋{cycle.closes_stop_count}
        </span>
        {' / '}
        <span className={cycle.closes_target_count > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}>
          🎯{cycle.closes_target_count}
        </span>
      </td>
      <td className={`pr-2 font-mono ${pnlColor(pnl)}`}>
        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
      </td>
      <td className="pr-2 text-muted-foreground">
        {cycle.win_rate_pct != null ? `${cycle.win_rate_pct.toFixed(0)}%` : '—'}
      </td>
      <td className="pr-2 text-muted-foreground">
        {cycle.exposure_pct != null ? (
          <span className={cycle.exposure_pct > 80 ? 'text-orange-500 font-medium' : ''}>
            {cycle.exposure_pct.toFixed(0)}%
          </span>
        ) : '—'}
      </td>
      <td className="text-muted-foreground">
        {cycle.vix_level != null ? (
          <span className={cycle.vix_level > 25 ? 'text-red-500 font-medium' : ''}>
            {cycle.vix_level.toFixed(1)}
          </span>
        ) : '—'}
      </td>
      {cycle.stops_cluster_flag && (
        <td><AlertTriangle className="h-3 w-3 text-orange-500" /></td>
      )}
    </tr>
  );
}

function ActionRow({ action }: { action: AgentAction }) {
  const info = KIND_LABELS[action.kind] ?? { label: action.kind, color: 'text-muted-foreground' };
  const ago = Math.round((Date.now() - new Date(action.created_at).getTime()) / 60000);

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border/40 text-xs">
      <span className="text-muted-foreground whitespace-nowrap w-10 shrink-0">
        {ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`}
      </span>
      <span className={`font-mono font-semibold w-16 shrink-0 ${info.color}`}>{info.label}</span>
      <span className="text-foreground/80 leading-snug">{action.summary}</span>
    </div>
  );
}

export function MechanicalAgentCard({ data, isLoading }: Props) {
  const [showCycles, setShowCycles] = useState(false);
  const [showActions, setShowActions] = useState(true);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 animate-pulse h-32" />
    );
  }

  const cycles = data?.cycles ?? [];
  const actions = data?.recentActions ?? [];
  const lastCycle = cycles[0];

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Agent mécanique</h3>
          {lastCycle && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              dernier cycle il y a {Math.round((Date.now() - new Date(lastCycle.cycle_at).getTime()) / 60000)} min
            </span>
          )}
        </div>
        {lastCycle && (
          <div className="flex items-center gap-3 text-xs">
            <span className={pnlColor(Number(lastCycle.net_pnl_since_proposal_usd))}>
              P&L {Number(lastCycle.net_pnl_since_proposal_usd) >= 0 ? '+' : ''}${Number(lastCycle.net_pnl_since_proposal_usd).toFixed(2)}
            </span>
            {lastCycle.exposure_pct != null && (
              <span className={lastCycle.exposure_pct > 80 ? 'text-orange-500 font-medium' : 'text-muted-foreground'}>
                Expo {lastCycle.exposure_pct.toFixed(0)}%
              </span>
            )}
            {lastCycle.stops_cluster_flag && (
              <span className="flex items-center gap-1 text-orange-500">
                <AlertTriangle className="h-3 w-3" /> Cluster stops
              </span>
            )}
          </div>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Directive */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Directive active
          </p>
          <DirectiveSection directive={data?.directive ?? null} />
        </div>

        {/* Cycles */}
        {cycles.length > 0 && (
          <div>
            <button
              onClick={() => setShowCycles((v) => !v)}
              className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 hover:text-foreground transition-colors"
            >
              {showCycles ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Cycles récents ({cycles.length})
            </button>
            {showCycles && (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] text-muted-foreground uppercase border-b border-border">
                      <th className="text-left pb-1 pr-2">Il y a</th>
                      <th className="text-left pb-1 pr-2">Open/Stop/Target</th>
                      <th className="text-left pb-1 pr-2">P&L</th>
                      <th className="text-left pb-1 pr-2">Win%</th>
                      <th className="text-left pb-1 pr-2">Expo</th>
                      <th className="text-left pb-1">VIX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycles.map((c, i) => <CycleRow key={i} cycle={c} />)}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Actions récentes */}
        <div>
          <button
            onClick={() => setShowActions((v) => !v)}
            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 hover:text-foreground transition-colors"
          >
            {showActions ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            <Eye className="h-3 w-3" />
            Activité récente ({actions.length})
          </button>
          {showActions && (
            <div className="max-h-64 overflow-y-auto">
              {actions.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  Aucune action enregistrée — migrations 0051/0052 appliquées ?
                </p>
              ) : (
                actions.map((a, i) => <ActionRow key={i} action={a} />)
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
