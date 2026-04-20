'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpCircle, Plus, RefreshCw, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useFundingTransfers,
  type FundingTransferRow,
  type FundingTransferStatus,
} from '@/hooks/use-funding';

const STATUS_OPTIONS: Array<{ value: FundingTransferStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Tous' },
  { value: 'draft', label: 'Brouillon' },
  { value: 'initiated', label: 'Initié' },
  { value: 'pending_settlement', label: 'En attente' },
  { value: 'settled', label: 'Réglé' },
  { value: 'partially_settled', label: 'Partiel' },
  { value: 'cancelled', label: 'Annulé' },
  { value: 'failed', label: 'Échoué' },
  { value: 'reversed', label: 'Reversé' },
];

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
  pending_settlement: 'En attente',
  settled: 'Réglé',
  partially_settled: 'Partiel',
  cancelled: 'Annulé',
  failed: 'Échoué',
  reversed: 'Reversé',
};

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v;
}

export default function FundingPage() {
  const [statusFilter, setStatusFilter] = useState<FundingTransferStatus | 'all'>('all');

  const filters = statusFilter !== 'all' ? { status: statusFilter } : {};
  const query = useFundingTransfers(filters);

  if (query.error) {
    return <ErrorState message={(query.error as Error).message} />;
  }

  const transfers = query.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
            Transferts de fonds
          </h1>
          <p className="text-sm text-muted-foreground">
            Suivi des virements vers vos comptes broker. SmartVest n'exécute aucun transfert réel
            — les données sont déclaratives.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Rafraîchir
        </Button>
        <Link href="/funding/new">
          <Button size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Nouveau transfert
          </Button>
        </Link>
      </div>

      <DisclaimerBanner />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Statut :
        </div>
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStatusFilter(opt.value)}
            className={`rounded-full border px-3 py-0.5 text-xs font-medium transition-colors ${
              statusFilter === opt.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/50'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* List */}
      {query.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : transfers.length === 0 ? (
        <EmptyState
          icon={<ArrowUpCircle className="h-10 w-10" />}
          title="Aucun transfert enregistré"
          description={
            statusFilter !== 'all'
              ? `Aucun transfert au statut « ${STATUS_LABEL[statusFilter as FundingTransferStatus]} ».`
              : 'Enregistrez votre premier virement pour commencer à suivre vos apports de liquidités.'
          }
          action={
            <Link href="/funding/new">
              <Button size="sm">
                <Plus className="mr-1.5 h-4 w-4" />
                Nouveau transfert
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Statut</th>
                <th className="px-3 py-2 font-medium">Devise</th>
                <th className="px-3 py-2 text-right font-medium">Montant</th>
                <th className="px-3 py-2 text-right font-medium">Réglé</th>
                <th className="px-3 py-2 font-medium">Référence</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {transfers.map((t) => (
                <TransferRow key={t.id} transfer={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TransferRow({ transfer: t }: { transfer: FundingTransferRow }) {
  return (
    <tr className="hover:bg-muted/20">
      <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
        {new Date(t.created_at).toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[t.status]}`}
        >
          {STATUS_LABEL[t.status]}
        </span>
      </td>
      <td className="px-3 py-2 font-medium">{t.currency}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium">
        {fmt(t.amount)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {t.settled_amount ? fmt(t.settled_amount) : '—'}
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {t.reference ?? '—'}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate max-w-[160px]">{t.notes ?? '—'}</span>
          <Link
            href={`/funding/${t.id}`}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            Détail →
          </Link>
        </div>
      </td>
    </tr>
  );
}
