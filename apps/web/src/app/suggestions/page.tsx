'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Inbox, XCircle, Clock, Ban, Filter } from 'lucide-react';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useProposals,
  type LifecycleState,
  type ProposalAction,
  type ProposalRow,
} from '@/hooks/use-suggestions';

const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  draft: 'Brouillon',
  presented: 'En attente',
  approved: 'Validée',
  rejected: 'Rejetée',
  expired: 'Expirée',
  executed: 'Exécutée',
  cancelled: 'Annulée',
};

const LIFECYCLE_STYLE: Record<LifecycleState, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  presented: 'bg-sky-50 text-sky-700 border-sky-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-orange-50 text-orange-700 border-orange-200',
  expired: 'bg-slate-50 text-slate-500 border-slate-200',
  executed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  cancelled: 'bg-slate-50 text-slate-500 border-slate-200',
};

const ACTION_LABEL: Record<ProposalAction, string> = {
  buy: 'Achat',
  sell: 'Vente',
  rebalance: 'Rééquilibrage',
  contribute: 'Versement',
  withdraw: 'Retrait',
  fx: 'Change',
  other: 'Autre',
};

export default function SuggestionsPage() {
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleState | 'all'>('presented');
  const [actionFilter, setActionFilter] = useState<ProposalAction | 'all'>('all');

  const filters = {
    ...(lifecycleFilter !== 'all' ? { lifecycleState: lifecycleFilter } : {}),
    ...(actionFilter !== 'all' ? { action: actionFilter } : {}),
  };
  const proposalsQuery = useProposals(filters);
  const allProposalsQuery = useProposals({ limit: 200 });

  const pendingCount = (allProposalsQuery.data ?? []).filter((p) => p.lifecycle_state === 'presented').length;

  if (proposalsQuery.error) {
    return <ErrorState message={(proposalsQuery.error as Error).message} />;
  }

  const proposals = proposalsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Centre de revue des suggestions</h1>
          <p className="text-sm text-muted-foreground">
            Examinez les propositions générées par SmartVest. Aucune exécution réelle n'a lieu —
            approuver signifie valider l'intention.
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {/* Summary pill */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <Clock className="h-4 w-4 text-sky-600" />
        <span>
          <strong>{pendingCount}</strong> propositions en attente de revue
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Statut :
        </div>
        {(['all', 'presented', 'approved', 'rejected', 'expired', 'cancelled'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setLifecycleFilter(v)}
            className={`rounded-full px-3 py-0.5 text-xs font-medium border transition-colors ${
              lifecycleFilter === v
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:border-primary/50'
            }`}
          >
            {v === 'all' ? 'Tous' : LIFECYCLE_LABEL[v as LifecycleState]}
          </button>
        ))}
        <div className="mx-2 h-4 w-px bg-border" />
        <div className="text-xs font-medium text-muted-foreground">Action :</div>
        {(['all', 'buy', 'sell', 'rebalance', 'contribute'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setActionFilter(v)}
            className={`rounded-full px-3 py-0.5 text-xs font-medium border transition-colors ${
              actionFilter === v
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:border-primary/50'
            }`}
          >
            {v === 'all' ? 'Toutes' : ACTION_LABEL[v as ProposalAction]}
          </button>
        ))}
      </div>

      {/* List */}
      {proposalsQuery.isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!proposalsQuery.isLoading && proposals.length === 0 && (
        <EmptyState
          icon={<Inbox className="h-10 w-10" />}
          title="Aucune suggestion"
          description={
            lifecycleFilter === 'presented'
              ? "Aucune suggestion en attente de revue pour le moment. SmartVest analyse votre portefeuille en continu — les nouvelles suggestions apparaîtront ici."
              : `Aucune suggestion ne correspond au filtre "${LIFECYCLE_LABEL[lifecycleFilter as LifecycleState] ?? 'sélectionné'}".`
          }
        />
      )}

      <div className="space-y-2">
        {proposals.map((p) => (
          <SuggestionCard key={p.id} proposal={p} />
        ))}
      </div>
    </div>
  );
}

function SuggestionCard({ proposal }: { proposal: ProposalRow }) {
  const expires = proposal.expires_at ? new Date(proposal.expires_at) : null;
  const expired = expires && expires < new Date();
  const assumptions = parseAssumptions(proposal.assumptions);
  const totalFriction = proposal.estimated_total_friction
    ? parseFloat(proposal.estimated_total_friction).toFixed(2)
    : null;

  return (
    <Link href={`/suggestions/${proposal.id}`} className="block">
      <div className="rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/30">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${LIFECYCLE_STYLE[proposal.lifecycle_state]}`}>
                {LIFECYCLE_LABEL[proposal.lifecycle_state]}
              </span>
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {ACTION_LABEL[proposal.action]}
              </span>
              {proposal.ticker && (
                <span className="font-mono text-xs font-semibold">{proposal.ticker}</span>
              )}
              {expired && proposal.lifecycle_state === 'presented' && (
                <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
                  Expirée
                </span>
              )}
            </div>
            <p className="mt-2 text-sm font-medium">{proposal.rationale}</p>
            {assumptions.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {assumptions.slice(0, 2).map((a, i) => <li key={i}>{a}</li>)}
                {assumptions.length > 2 && <li className="italic">+{assumptions.length - 2} autres hypothèses</li>}
              </ul>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 text-right text-[11px] text-muted-foreground">
            <div>Créée le {new Date(proposal.created_at).toLocaleDateString('fr-FR')}</div>
            {expires && (
              <div>
                Expire le {expires.toLocaleDateString('fr-FR')}
              </div>
            )}
            {totalFriction && proposal.friction_currency && (
              <div className="font-mono">
                Frictions : {totalFriction} {proposal.friction_currency}
              </div>
            )}
          </div>
        </div>

        {proposal.lifecycle_state === 'presented' && (
          <div className="mt-3 flex gap-2 border-t pt-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              Ouvrir pour approuver ou rejeter
            </div>
          </div>
        )}

        {proposal.lifecycle_state === 'approved' && (
          <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Intention validée — aucune exécution broker réelle
          </div>
        )}

        {proposal.lifecycle_state === 'rejected' && (
          <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-orange-700">
            <XCircle className="h-3 w-3" />
            Proposition rejetée
          </div>
        )}

        {proposal.lifecycle_state === 'cancelled' && (
          <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
            <Ban className="h-3 w-3" />
            Annulée avant décision
          </div>
        )}
      </div>
    </Link>
  );
}

function parseAssumptions(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
