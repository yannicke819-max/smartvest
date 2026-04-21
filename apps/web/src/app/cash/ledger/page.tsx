'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ScrollText, Filter, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { LedgerEntryBadge } from '@/components/cash/ledger-entry-badge';
import { useCashLedgerQuery, type MovementType } from '@/hooks/use-cash';
import { BackButton } from '@/components/ui/back-button';

const MOVEMENT_OPTIONS: Array<{ value: MovementType | 'all'; label: string }> = [
  { value: 'all', label: 'Tous' },
  { value: 'deposit', label: 'Dépôt' },
  { value: 'withdrawal', label: 'Retrait' },
  { value: 'settlement_credit', label: 'Règlement +' },
  { value: 'settlement_debit', label: 'Règlement −' },
  { value: 'reservation', label: 'Réservation' },
  { value: 'reservation_release', label: 'Libération' },
  { value: 'transfer_in', label: 'Entrée' },
  { value: 'transfer_out', label: 'Sortie' },
  { value: 'adjustment', label: 'Ajustement' },
];

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
}

function direction(amount: string): 'credit' | 'debit' | 'neutral' {
  const n = parseFloat(amount);
  if (!Number.isFinite(n) || n === 0) return 'neutral';
  return n > 0 ? 'credit' : 'debit';
}

export default function CashLedgerPage() {
  const [movementType, setMovementType] = useState<MovementType | 'all'>('all');
  const [currency, setCurrency] = useState<string>('');

  const filters = {
    ...(movementType !== 'all' ? { movementType } : {}),
    ...(currency ? { currency } : {}),
    limit: 100,
  };
  const query = useCashLedgerQuery(filters);

  if (query.error) {
    return <ErrorState message={(query.error as Error).message} />;
  }

  const entries = query.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ScrollText className="h-5 w-5 text-muted-foreground" />
            Journal cash
          </h1>
          <p className="text-sm text-muted-foreground">
            Historique append-only de tous les mouvements de cash. Chaque ligne est horodatée et
            immuable.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Rafraîchir
        </Button>
      </div>

      <DisclaimerBanner />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Type :
        </div>
        {MOVEMENT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setMovementType(opt.value)}
            className={`rounded-full border px-3 py-0.5 text-xs font-medium transition-colors ${
              movementType === opt.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/50'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <div className="mx-2 h-4 w-px bg-border" />
        <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Devise :
          <input
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            placeholder="Toutes"
            className="h-7 w-20 rounded border bg-background px-2 text-xs uppercase"
          />
        </label>
      </div>

      {/* Table */}
      {query.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-10 w-10" />}
          title="Aucun mouvement enregistré"
          description={
            movementType !== 'all' || currency
              ? 'Aucune entrée ne correspond aux filtres sélectionnés.'
              : 'Le journal est vide. Les mouvements apparaîtront dès qu\'un transfert sera réglé ou qu\'une réservation sera posée.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Compte</th>
                <th className="px-3 py-2 font-medium">Devise</th>
                <th className="px-3 py-2 text-right font-medium">Montant</th>
                <th className="px-3 py-2 text-right font-medium">Solde après</th>
                <th className="px-3 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((e) => {
                const dir = direction(e.amount);
                return (
                  <tr key={e.id} className="hover:bg-muted/20">
                    <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
                      {new Date(e.occurred_at).toLocaleString('fr-FR', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      <LedgerEntryBadge type={e.movement_type} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {e.destination_id.slice(0, 8)}…
                    </td>
                    <td className="px-3 py-2 font-medium">{e.currency}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums font-medium ${
                        dir === 'credit'
                          ? 'text-emerald-700'
                          : dir === 'debit'
                          ? 'text-orange-700'
                          : ''
                      }`}
                    >
                      {dir === 'credit' ? '+' : ''}
                      {fmt(e.amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {fmt(e.balance_after)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {e.description ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
