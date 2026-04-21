'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, CheckCircle2, XCircle, Clock, ShieldCheck, AlertTriangle, History,
  Ban, Info, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useProposal,
  useProposalAudit,
  useApproveProposal,
  useRejectProposal,
  useCancelProposal,
  type LifecycleState,
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

export default function SuggestionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const proposalQuery = useProposal(id ?? null);
  const auditQuery = useProposalAudit(id ?? null);
  const approve = useApproveProposal();
  const reject = useRejectProposal();
  const cancel = useCancelProposal();

  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | 'cancel' | null>(null);

  if (proposalQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6 space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (proposalQuery.error) {
    return <ErrorState message={(proposalQuery.error as Error).message} />;
  }

  const proposal = proposalQuery.data;
  if (!proposal) return <ErrorState message="Proposition introuvable" />;

  const assumptions = parseAssumptions(proposal.assumptions);
  const canAct = proposal.lifecycle_state === 'presented' || proposal.lifecycle_state === 'draft';

  async function runAction() {
    if (!id || !confirmAction) return;
    setActionError(null);
    try {
      if (confirmAction === 'approve') {
        await approve.mutateAsync({ id, note: note || undefined });
      } else if (confirmAction === 'reject') {
        await reject.mutateAsync({ id, note: note || undefined });
      } else {
        await cancel.mutateAsync({ id, reason: note || undefined });
      }
      setConfirmAction(null);
      setNote('');
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-3">
        <Link href="/suggestions">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Centre de revue
          </Button>
        </Link>
      </div>

      <DisclaimerBanner />

      {/* Header */}
      <div className="rounded-lg border p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-sky-600" />
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Proposition {proposal.kind}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                {LIFECYCLE_LABEL[proposal.lifecycle_state]}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase">
                {proposal.delegation_mode}
              </span>
            </div>
            <h1 className="mt-2 text-lg font-semibold">
              {proposal.ticker ? `${proposal.action.toUpperCase()} ${proposal.ticker}` : proposal.action}
            </h1>
            {proposal.quantity && (
              <p className="mt-1 text-sm text-muted-foreground">
                Quantité : <span className="font-mono">{proposal.quantity}</span>
                {proposal.notional && (
                  <>
                    {' · '}Notionnel :{' '}
                    <span className="font-mono">
                      {parseFloat(proposal.notional).toFixed(2)} {proposal.currency ?? ''}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Créée le {new Date(proposal.created_at).toLocaleString('fr-FR')}</div>
            {proposal.expires_at && (
              <div className="mt-0.5">
                Expire le {new Date(proposal.expires_at).toLocaleString('fr-FR')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rationale */}
      <Section icon={<TrendingUp className="h-4 w-4" />} title="Pourquoi cette suggestion">
        <p className="text-sm">{proposal.rationale}</p>
      </Section>

      {/* Assumptions */}
      {assumptions.length > 0 && (
        <Section icon={<Info className="h-4 w-4" />} title="Hypothèses">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle className="mr-1.5 inline h-3 w-3" aria-hidden />
            Ces hypothèses sont des simulations. Les performances passées ne préjugent pas des
            performances futures.
          </p>
        </Section>
      )}

      {/* Friction estimate */}
      {proposal.estimated_total_friction && (
        <Section icon={<TrendingUp className="h-4 w-4" />} title="Frictions estimées">
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <Metric label="Frais broker" value={proposal.estimated_broker_fee} currency={proposal.friction_currency} />
            <Metric label="Spread" value={proposal.estimated_spread_cost} currency={proposal.friction_currency} />
            <Metric label="Slippage" value={proposal.estimated_slippage_cost} currency={proposal.friction_currency} />
            <Metric label="FX" value={proposal.estimated_fx_markup} currency={proposal.friction_currency} />
          </div>
          <div className="mt-3 border-t pt-2 text-sm font-medium">
            Total : {parseFloat(proposal.estimated_total_friction).toFixed(2)} {proposal.friction_currency ?? ''}
          </div>
        </Section>
      )}

      {/* Guardrails */}
      {proposal.mandate_id && (
        <Section icon={<ShieldCheck className="h-4 w-4" />} title="Garde-fous appliqués">
          <p className="text-sm text-muted-foreground">
            Cette proposition a été cadrée par le mandat {proposal.mandate_id.slice(0, 8)}…
          </p>
        </Section>
      )}

      {/* Actions */}
      {canAct && (
        <div className="rounded-lg border p-5">
          <h3 className="mb-2 font-medium">Votre décision</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Approuver valide l'intention produit. <strong>Aucun ordre broker n'est envoyé.</strong>
          </p>

          {actionError && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {actionError}
            </div>
          )}

          <textarea
            placeholder="Note (optionnelle) — justification, conditions, ajustements..."
            className="mb-3 w-full rounded border px-3 py-2 text-sm"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {!confirmAction ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setConfirmAction('approve')}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Approuver
              </Button>
              <Button
                variant="outline"
                className="border-orange-300 text-orange-700 hover:bg-orange-50"
                onClick={() => setConfirmAction('reject')}
              >
                <XCircle className="mr-1.5 h-4 w-4" />
                Rejeter
              </Button>
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmAction('cancel')}
              >
                <Ban className="mr-1.5 h-4 w-4" />
                Annuler la proposition
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="text-sm">
                Confirmer : {confirmAction === 'approve' ? 'Approuver' : confirmAction === 'reject' ? 'Rejeter' : 'Annuler'} cette proposition ?
              </span>
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  onClick={runAction}
                  disabled={approve.isPending || reject.isPending || cancel.isPending}
                  className={
                    confirmAction === 'approve'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : confirmAction === 'reject'
                      ? 'bg-orange-600 hover:bg-orange-700'
                      : ''
                  }
                >
                  Oui, confirmer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmAction(null)}>
                  Annuler
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audit trail */}
      <Section icon={<History className="h-4 w-4" />} title={`Audit trail (${auditQuery.data?.length ?? 0})`}>
        {auditQuery.isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}
        {auditQuery.data && auditQuery.data.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucun événement encore enregistré.</p>
        )}
        {auditQuery.data && auditQuery.data.length > 0 && (
          <ul className="space-y-2 text-sm">
            {auditQuery.data.map((ev) => (
              <li key={ev.id} className="flex items-start gap-3 border-l-2 border-muted pl-3">
                <Clock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{ev.kind}</div>
                  <div className="text-xs text-muted-foreground">{ev.reason}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {new Date(ev.occurred_at).toLocaleString('fr-FR')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Metric({ label, value, currency }: { label: string; value: string | null; currency: string | null }) {
  return (
    <div className="rounded bg-muted/40 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-xs font-medium">
        {value ? `${parseFloat(value).toFixed(2)} ${currency ?? ''}` : '—'}
      </div>
    </div>
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
