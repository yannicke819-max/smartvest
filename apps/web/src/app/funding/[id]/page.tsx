'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, ArrowUpCircle, History, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useFundingTransfer,
  useFundingTransferAudit,
  useInitiateTransfer,
  useSettleTransfer,
  useCancelTransfer,
  type FundingTransferStatus,
} from '@/hooks/use-funding';

const STATUS_STYLE: Record<FundingTransferStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  initiated: 'bg-sky-50 text-sky-700 border-sky-200',
  pending_settlement: 'bg-amber-50 text-amber-700 border-amber-200',
  settled: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partially_settled: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  cancelled: 'bg-slate-50 text-slate-500 border-slate-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  reversed: 'bg-orange-50 text-orange-700 border-orange-200',
};

const STATUS_LABEL: Record<FundingTransferStatus, string> = {
  draft: 'Brouillon',
  initiated: 'Initié',
  pending_settlement: 'En attente de règlement',
  settled: 'Réglé',
  partially_settled: 'Partiellement réglé',
  cancelled: 'Annulé',
  failed: 'Échoué',
  reversed: 'Reversé',
};

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n)
    ? n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v;
}

export default function FundingTransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const transferQuery = useFundingTransfer(id ?? null);
  const auditQuery = useFundingTransferAudit(id ?? null);
  const initiate = useInitiateTransfer();
  const settle = useSettleTransfer();
  const cancel = useCancelTransfer();

  const [showSettleForm, setShowSettleForm] = useState(false);
  const [settledAmount, setSettledAmount] = useState('');
  const [settlementDate, setSettlementDate] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (transferQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (transferQuery.error) {
    return <ErrorState message={(transferQuery.error as Error).message} />;
  }

  const t = transferQuery.data;
  if (!t) return <ErrorState message="Transfert introuvable" />;

  const canInitiate = t.status === 'draft';
  const canSettle = t.status === 'initiated' || t.status === 'pending_settlement' || t.status === 'partially_settled';
  const canCancel = t.status === 'draft' || t.status === 'initiated';

  function handleInitiate() {
    setActionError(null);
    initiate.mutate(id, {
      onError: (e) => setActionError((e as Error).message),
    });
  }

  function handleSettle(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(settledAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setActionError('Montant réglé invalide.');
      return;
    }
    setActionError(null);
    settle.mutate(
      {
        id,
        payload: {
          settled_amount: amt.toFixed(10),
          ...(settlementDate ? { settlement_date: settlementDate } : {}),
        },
      },
      {
        onSuccess: () => {
          setShowSettleForm(false);
          setSettledAmount('');
          setSettlementDate('');
        },
        onError: (err) => setActionError((err as Error).message),
      },
    );
  }

  function handleCancel() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setActionError(null);
    cancel.mutate(
      { id },
      {
        onError: (err) => setActionError((err as Error).message),
        onSettled: () => setConfirmCancel(false),
      },
    );
  }

  const audit = auditQuery.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/funding">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
            Transfert
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{t.id}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            transferQuery.refetch();
            auditQuery.refetch();
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Rafraîchir
        </Button>
      </div>

      <DisclaimerBanner />

      {/* Summary card */}
      <div className="rounded-lg border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span
            className={`rounded-full border px-3 py-0.5 text-xs font-medium ${STATUS_STYLE[t.status]}`}
          >
            {STATUS_LABEL[t.status]}
          </span>
          <span className="text-2xl font-semibold tabular-nums">
            {fmt(t.amount)} {t.currency}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Montant réglé</p>
            <p className="mt-0.5 font-semibold tabular-nums">
              {t.settled_amount ? `${fmt(t.settled_amount)} ${t.currency}` : '—'}
            </p>
          </div>
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Règlement prévu</p>
            <p className="mt-0.5 font-semibold">
              {t.expected_settlement_date
                ? new Date(t.expected_settlement_date).toLocaleDateString('fr-FR')
                : '—'}
            </p>
          </div>
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Date de règlement</p>
            <p className="mt-0.5 font-semibold">
              {t.settlement_date
                ? new Date(t.settlement_date).toLocaleDateString('fr-FR')
                : '—'}
            </p>
          </div>
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Référence</p>
            <p className="mt-0.5 font-mono text-xs font-semibold">{t.reference ?? '—'}</p>
          </div>
          <div className="rounded-md bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Créé le</p>
            <p className="mt-0.5 font-semibold">
              {new Date(t.created_at).toLocaleString('fr-FR', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          {t.notes && (
            <div className="rounded-md bg-muted/30 p-3 md:col-span-1">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="mt-0.5 text-xs">{t.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Transition actions */}
      {(canInitiate || canSettle || canCancel) && (
        <section className="rounded-lg border p-4 space-y-3">
          <h2 className="text-sm font-medium">Actions</h2>

          <div className="flex flex-wrap gap-2">
            {canInitiate && (
              <Button
                size="sm"
                onClick={handleInitiate}
                disabled={initiate.isPending}
              >
                {initiate.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                Marquer comme initié
              </Button>
            )}
            {canSettle && !showSettleForm && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSettleForm(true)}
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Enregistrer le règlement
              </Button>
            )}
            {canCancel && (
              <Button
                size="sm"
                variant={confirmCancel ? 'destructive' : 'outline'}
                onClick={handleCancel}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />
                )}
                {confirmCancel ? 'Confirmer l\'annulation' : 'Annuler'}
              </Button>
            )}
          </div>

          {showSettleForm && (
            <form onSubmit={handleSettle} className="mt-3 space-y-3 rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium text-muted-foreground">Enregistrer un règlement</p>
              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <label className="block text-xs font-medium">Montant réglé</label>
                  <input
                    type="number"
                    value={settledAmount}
                    onChange={(e) => setSettledAmount(e.target.value)}
                    min="0.01"
                    step="0.01"
                    placeholder={fmt(t.amount)}
                    required
                    className="h-8 w-full rounded border bg-background px-2 text-sm tabular-nums"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <label className="block text-xs font-medium">Date de règlement</label>
                  <input
                    type="date"
                    value={settlementDate}
                    onChange={(e) => setSettlementDate(e.target.value)}
                    className="h-8 w-full rounded border bg-background px-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={settle.isPending}>
                  {settle.isPending ? 'Enregistrement…' : 'Valider'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowSettleForm(false);
                    setSettledAmount('');
                  }}
                >
                  Annuler
                </Button>
              </div>
            </form>
          )}

          {actionError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {actionError}
            </div>
          )}
        </section>
      )}

      {/* Contextual links */}
      <section className="flex flex-wrap gap-2">
        <Link href="/cash">
          <Button variant="outline" size="sm" className="text-xs">
            Cash & balances
          </Button>
        </Link>
        <Link href="/cash/ledger">
          <Button variant="outline" size="sm" className="text-xs">
            Journal cash
          </Button>
        </Link>
      </section>

      {/* Audit log */}
      <section className="rounded-lg border">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Journal d'audit</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            Hash-chainé · append-only
          </span>
        </header>

        {auditQuery.isLoading && (
          <div className="p-4">
            <SkeletonCard />
          </div>
        )}

        {audit.length === 0 && !auditQuery.isLoading && (
          <p className="p-4 text-xs text-muted-foreground">Aucune entrée d'audit.</p>
        )}

        {audit.length > 0 && (
          <ol className="divide-y">
            {audit.map((entry, i) => (
              <li key={entry.id} className="px-4 py-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      #{audit.length - i}
                    </span>
                    <span className="font-medium capitalize">
                      {entry.event_kind.replace(/_/g, ' ')}
                    </span>
                    {entry.from_status && entry.to_status && (
                      <span className="text-muted-foreground">
                        {entry.from_status} → {entry.to_status}
                      </span>
                    )}
                    {entry.amount && (
                      <span className="font-mono font-semibold">
                        {fmt(entry.amount)} {t.currency}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(entry.occurred_at).toLocaleString('fr-FR', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {entry.reason && (
                  <p className="mt-0.5 text-muted-foreground">{entry.reason}</p>
                )}
                <p className="mt-1 font-mono text-[10px] text-muted-foreground/60 truncate">
                  hash: {entry.hash}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
