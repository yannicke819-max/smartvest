'use client';

import { ScrollText, Sparkles, ShieldCheck, Swords, AlertTriangle, UserCheck, Clock, CheckCircle2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLisaDecisionLog, useAuditChainVerify, type LisaDecisionLogRow } from '@/hooks/use-lisa';
import { SkeletonCard } from '@/components/ui/skeleton';

const KIND_ICONS: Record<string, ReactNode> = {
  proposal_generated: <Sparkles className="h-3.5 w-3.5 text-primary" />,
  proposal_approved: <UserCheck className="h-3.5 w-3.5 text-emerald-600" />,
  proposal_rejected: <UserCheck className="h-3.5 w-3.5 text-slate-500" />,
  position_opened: <Swords className="h-3.5 w-3.5 text-blue-600" />,
  position_closed: <Swords className="h-3.5 w-3.5 text-slate-600" />,
  position_resized: <Swords className="h-3.5 w-3.5 text-blue-500" />,
  thesis_invalidated: <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />,
  risk_limit_breached: <AlertTriangle className="h-3.5 w-3.5 text-red-600" />,
  kill_switch_triggered: <ShieldCheck className="h-3.5 w-3.5 text-red-700" />,
  autopilot_cycle_started: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
  autopilot_cycle_completed: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
  market_regime_changed: <Sparkles className="h-3.5 w-3.5 text-amber-600" />,
  analog_matched: <ScrollText className="h-3.5 w-3.5 text-primary" />,
  user_override: <UserCheck className="h-3.5 w-3.5 text-amber-600" />,
};

const TRIGGER_LABELS: Record<string, string> = {
  user_manual: 'Utilisateur',
  autopilot_cron: 'Autopilot',
  risk_monitor: 'Risk monitor',
  corpus_trigger: 'Corpus match',
  market_event: 'Event marché',
};

export function LisaDecisionLog({ portfolioId }: { portfolioId: string }) {
  const logQuery = useLisaDecisionLog(portfolioId, 50);
  const verifyQuery = useAuditChainVerify(portfolioId);
  const entries = logQuery.data ?? [];
  const chain = verifyQuery.data;

  return (
    <div className="rounded-lg border p-5 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Decision log</h2>
        {chain && chain.totalEntries > 0 && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              chain.isValid
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-red-50 text-red-700 border-red-200'
            }`}
            title={`${chain.totalEntries} entrée(s) vérifiée(s)`}
          >
            {chain.isValid ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            Hash chain {chain.isValid ? 'intègre' : `corrompue #${chain.firstCorruptedIndex ?? '?'}`}
          </span>
        )}
      </div>

      {logQuery.isLoading && <SkeletonCard />}

      {!logQuery.isLoading && entries.length === 0 && (
        <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          Pas encore de décisions enregistrées.
        </div>
      )}

      {entries.length > 0 && (
        <div className="max-h-[480px] overflow-y-auto space-y-2 pr-1">
          {entries.map((e) => <DecisionRow key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}

function DecisionRow({ entry }: { entry: LisaDecisionLogRow }) {
  const icon = KIND_ICONS[entry.kind] ?? <ScrollText className="h-3.5 w-3.5 text-muted-foreground" />;

  return (
    <div className="flex items-start gap-2 rounded border p-3 text-xs">
      <div className="mt-0.5 flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{entry.summary}</span>
          <span className="text-[10px] text-muted-foreground">
            · {TRIGGER_LABELS[entry.triggered_by] ?? entry.triggered_by}
          </span>
          <span className="text-[10px] text-muted-foreground">
            · {new Date(entry.timestamp).toLocaleString('fr-FR')}
          </span>
        </div>
        {entry.rationale && entry.rationale !== entry.summary && (
          <p className="mt-1 text-muted-foreground leading-relaxed">
            {entry.rationale}
          </p>
        )}
        {entry.hash_chain_current && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            <code className="bg-muted rounded px-1">{entry.hash_chain_current}</code>
          </p>
        )}
      </div>
    </div>
  );
}
