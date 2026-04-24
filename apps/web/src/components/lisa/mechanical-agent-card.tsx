'use client';

import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Zap, AlertTriangle, TrendingUp, TrendingDown, Minus, Clock, Eye, Rocket, CheckCircle2, Hourglass, XCircle, ShieldAlert, Target, Ban } from 'lucide-react';
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

const KIND_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  mechanical_open: { label: 'OPEN', color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-50 dark:bg-blue-950/40' },
  mechanical_close_stop: { label: 'STOP', color: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-950/40' },
  mechanical_close_target: { label: 'TARGET', color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-950/40' },
  mechanical_close_invalidated: { label: 'INVALIDE', color: 'text-orange-700 dark:text-orange-300', bg: 'bg-orange-50 dark:bg-orange-950/40' },
  mechanical_skip: { label: 'SKIP', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-900/40' },
  autopilot_cycle_started: { label: 'CYCLE', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-900/40' },
  autopilot_cycle_completed: { label: 'CYCLE', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-900/40' },
  autopilot_cycle_completed_error: { label: 'ERROR', color: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-950/40' },
  mechanical_override_applied: { label: 'OVERRIDE', color: 'text-purple-700 dark:text-purple-300', bg: 'bg-purple-50 dark:bg-purple-950/40' },
};

type BadgeSpec = {
  label: string;
  Icon: typeof TrendingUp;
  iconClass: string;
  wrapClass: string;
};

const MOMENTUM_BADGES: Record<string, BadgeSpec> = {
  bullish_strong: {
    label: 'Haussier fort',
    Icon: TrendingUp,
    iconClass: 'text-emerald-500',
    wrapClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  },
  bullish: {
    label: 'Haussier',
    Icon: TrendingUp,
    iconClass: 'text-amber-500',
    wrapClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  },
  neutral: {
    label: 'Neutre',
    Icon: Minus,
    iconClass: 'text-slate-400',
    wrapClass: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
  },
  bearish: {
    label: 'Baissier',
    Icon: TrendingDown,
    iconClass: 'text-red-500',
    wrapClass: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  },
};

const TRAJECTORY_BADGES: Record<string, BadgeSpec> = {
  EN_AVANCE: {
    label: 'En avance',
    Icon: Rocket,
    iconClass: 'text-emerald-500',
    wrapClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  },
  DANS_LE_PLAN: {
    label: 'Dans le plan',
    Icon: CheckCircle2,
    iconClass: 'text-blue-500',
    wrapClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  },
  EN_RETARD: {
    label: 'En retard',
    Icon: Hourglass,
    iconClass: 'text-orange-500',
    wrapClass: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
  },
  HORS_TRAJECTOIRE: {
    label: 'Hors trajectoire',
    Icon: XCircle,
    iconClass: 'text-red-500',
    wrapClass: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  },
};

const RISK_BADGES: Record<string, BadgeSpec> = {
  defensive: {
    label: 'Défensive',
    Icon: ShieldAlert,
    iconClass: 'text-slate-500',
    wrapClass: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
  },
  balanced: {
    label: 'Équilibrée',
    Icon: Target,
    iconClass: 'text-blue-500',
    wrapClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  },
  aggressive: {
    label: 'Agressive',
    Icon: Zap,
    iconClass: 'text-purple-500',
    wrapClass: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800',
  },
};

function Badge({ spec }: { spec: BadgeSpec }) {
  const { Icon } = spec;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${spec.wrapClass}`}>
      <Icon className={`h-3.5 w-3.5 ${spec.iconClass}`} />
      {spec.label}
    </span>
  );
}

function fallbackBadge(label: string, tone: 'slate' | 'red' = 'slate'): BadgeSpec {
  return {
    label,
    Icon: Minus,
    iconClass: tone === 'red' ? 'text-red-500' : 'text-slate-400',
    wrapClass:
      tone === 'red'
        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
        : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
  };
}

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
  const momentumBadge = MOMENTUM_BADGES[directive.market_momentum] ?? fallbackBadge(directive.market_momentum);
  const trajectoryBadge = TRAJECTORY_BADGES[directive.trajectory_status] ?? fallbackBadge(directive.trajectory_status);
  const riskKey = (directive.risk_posture ?? '').toLowerCase();
  const riskBadge = RISK_BADGES[riskKey] ?? fallbackBadge(directive.risk_posture?.replace(/_/g, ' ') ?? 'n/a');
  const validUntil = directive.valid_until ? new Date(directive.valid_until) : null;
  const isExpired = validUntil ? validUntil < new Date() : false;
  const generatedAgo = Math.round((Date.now() - new Date(directive.generated_at).getTime()) / 60000);
  const ageLabel = generatedAgo < 60 ? `${generatedAgo} min` : `${Math.floor(generatedAgo / 60)}h${String(generatedAgo % 60).padStart(2, '0')}`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Momentum</span>
          <Badge spec={momentumBadge} />
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Trajectoire</span>
          <Badge spec={trajectoryBadge} />
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Posture de risque</span>
          <Badge spec={riskBadge} />
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Directive âgée de</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            isExpired
              ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800'
              : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700'
          }`}>
            <Clock className={`h-3.5 w-3.5 ${isExpired ? 'text-red-500' : 'text-slate-400'}`} />
            {ageLabel}{isExpired ? ' (expirée)' : ''}
          </span>
        </div>
      </div>

      {directive.target_symbols?.length > 0 && (
        <div className="text-sm">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Symboles cibles</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {directive.target_symbols.map((sym) => (
              <span
                key={sym}
                className="inline-flex items-center rounded-md bg-muted/60 px-2 py-0.5 text-xs font-mono font-medium text-foreground/80"
              >
                {sym}
              </span>
            ))}
          </div>
        </div>
      )}

      {hasOverrides && (
        <div className="rounded-md bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 p-2.5 text-xs space-y-1.5">
          <p className="font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" /> Overrides [AGENT] actifs
          </p>
          {overrides.pauseOpens === true && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <Ban className="h-3.5 w-3.5 shrink-0" />
              Ouvertures pausées — {String(overrides.pauseOpensReason ?? 'signal actif')}
            </p>
          )}
          {overrides.tightenStopsMultiplier != null && (overrides.tightenStopsMultiplier as number) < 1 && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <Target className="h-3.5 w-3.5 shrink-0" />
              Stops resserrés ×{Number(overrides.tightenStopsMultiplier).toFixed(2)}
            </p>
          )}
          {overrides.minConvictionOverride != null && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <TrendingUp className="h-3.5 w-3.5 shrink-0" />
              Conviction min : {String(overrides.minConvictionOverride)}/10
            </p>
          )}
          {overrides.maxNewOpensOverride != null && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              Max ouvertures/cycle : {String(overrides.maxNewOpensOverride)}
            </p>
          )}
          {overrides.closeLowestConvictionIfExposureAbovePct != null && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <TrendingDown className="h-3.5 w-3.5 shrink-0" />
              Ferme plus faible conviction si exposition &gt; {String(overrides.closeLowestConvictionIfExposureAbovePct)}%
            </p>
          )}
          {Array.isArray(overrides.preferredAssetClasses) && (overrides.preferredAssetClasses as string[]).length > 0 && (
            <p className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              Classes préférées : {(overrides.preferredAssetClasses as string[]).join(', ')}
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
  const info = KIND_LABELS[action.kind] ?? {
    label: action.kind.replace(/^(mechanical_|autopilot_)/, '').toUpperCase().slice(0, 10),
    color: 'text-slate-600 dark:text-slate-400',
    bg: 'bg-slate-50 dark:bg-slate-900/40',
  };
  const ago = Math.round((Date.now() - new Date(action.timestamp).getTime()) / 60000);

  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border/40 text-xs">
      <span className="text-muted-foreground whitespace-nowrap w-12 shrink-0 text-right tabular-nums">
        {ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`}
      </span>
      <span className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide w-20 shrink-0 ${info.bg} ${info.color}`}>
        {info.label}
      </span>
      <span className="text-foreground/80 leading-snug truncate min-w-0">{action.summary}</span>
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
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"></span>
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
          </span>
          <Activity className="h-4 w-4 text-muted-foreground shrink-0" />
          <h3 className="font-semibold text-sm whitespace-nowrap">Agent mécanique</h3>
          {lastCycle && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 truncate">
              <Clock className="h-3 w-3 shrink-0" />
              il y a {Math.round((Date.now() - new Date(lastCycle.cycle_at).getTime()) / 60000)} min
            </span>
          )}
        </div>
        {lastCycle && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${
              Number(lastCycle.net_pnl_since_proposal_usd) >= 0
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
            }`}>
              P&amp;L {Number(lastCycle.net_pnl_since_proposal_usd) >= 0 ? '+' : ''}${Number(lastCycle.net_pnl_since_proposal_usd).toFixed(2)}
            </span>
            {lastCycle.exposure_pct != null && (
              <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium ${
                lastCycle.exposure_pct > 80
                  ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                  : 'bg-slate-50 text-slate-600 dark:bg-slate-900/40 dark:text-slate-300'
              }`}>
                Expo {lastCycle.exposure_pct.toFixed(0)}%
              </span>
            )}
            {lastCycle.stops_cluster_flag && (
              <span className="inline-flex items-center gap-1 rounded-md bg-orange-50 px-2 py-0.5 font-medium text-orange-700 dark:bg-orange-950/40 dark:text-orange-300">
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
