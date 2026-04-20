'use client';

import { useState } from 'react';
import { Lock, Unlock, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/states/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton';
import {
  useCashReservationsQuery,
  useReleaseCashReservationMutation,
  type CashReservationRow,
  type ReservationStatus,
} from '@/hooks/use-cash';

const STATUS_LABEL: Record<ReservationStatus, string> = {
  active: 'Active',
  released: 'Libérée',
  consumed: 'Consommée',
};

const STATUS_STYLE: Record<ReservationStatus, string> = {
  active: 'bg-sky-50 text-sky-700 border-sky-200',
  released: 'bg-slate-50 text-slate-600 border-slate-200',
  consumed: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
}

export function ReservationsPanel() {
  const query = useCashReservationsQuery();
  const reservations = query.data ?? [];

  return (
    <section className="rounded-lg border">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Réservations de cash</h2>
        </div>
        <span className="text-xs text-muted-foreground">
          Cash soft-lock pour un objectif, un plan ou une suggestion
        </span>
      </header>

      {query.isLoading && (
        <div className="space-y-2 p-4">
          <SkeletonCard />
        </div>
      )}

      {query.error && (
        <div className="flex items-center gap-2 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {(query.error as Error).message}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            className="ml-auto text-xs"
          >
            Réessayer
          </Button>
        </div>
      )}

      {!query.isLoading && !query.error && reservations.length === 0 && (
        <EmptyState
          icon={<Lock className="h-8 w-8" />}
          title="Aucune réservation"
          description="Le cash disponible n'est pour l'instant affecté à aucun plan ou objectif."
          className="m-4"
        />
      )}

      {reservations.length > 0 && (
        <ul className="divide-y">
          {reservations.map((r) => (
            <ReservationRow key={r.id} reservation={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReservationRow({ reservation }: { reservation: CashReservationRow }) {
  const [confirming, setConfirming] = useState(false);
  const release = useReleaseCashReservationMutation();

  const canRelease = reservation.status === 'active';

  const handleRelease = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    release.mutate(reservation.id, {
      onSettled: () => setConfirming(false),
    });
  };

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[reservation.status]}`}
      >
        {STATUS_LABEL[reservation.status]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{reservation.reason}</p>
        <p className="text-[11px] text-muted-foreground">
          {reservation.destination_id.slice(0, 8)}… ·{' '}
          {new Date(reservation.created_at).toLocaleDateString('fr-FR')}
        </p>
      </div>
      <div className="text-right tabular-nums">
        <div className="font-semibold">
          {fmt(reservation.amount)} {reservation.currency}
        </div>
      </div>
      {canRelease && (
        <Button
          type="button"
          size="sm"
          variant={confirming ? 'destructive' : 'outline'}
          onClick={handleRelease}
          disabled={release.isPending}
        >
          {release.isPending ? (
            'Libération…'
          ) : confirming ? (
            <>
              <Check className="mr-1 h-3 w-3" />
              Confirmer
            </>
          ) : (
            <>
              <Unlock className="mr-1 h-3 w-3" />
              Libérer
            </>
          )}
        </Button>
      )}
      {release.isError && (
        <span className="w-full text-xs text-destructive">
          {(release.error as Error).message}
        </span>
      )}
    </li>
  );
}
