'use client';

import Link from 'next/link';
import { ArrowLeft, Wallet, ScrollText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KpiCard } from '@/components/kpi-card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { CashBalancesTable } from '@/components/cash/cash-balances-table';
import { ReservationsPanel } from '@/components/cash/reservations-panel';
import { BackButton } from '@/components/ui/back-button';
import {
  useCashBalancesQuery,
  useCashSummaryQuery,
  type CashSummaryRow,
} from '@/hooks/use-cash';

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
}

function headline(rows: CashSummaryRow[]): CashSummaryRow | null {
  return rows[0] ?? null;
}

export default function CashBalancesPage() {
  const summaryQuery = useCashSummaryQuery();
  const balancesQuery = useCashBalancesQuery();

  if (summaryQuery.error) {
    return <ErrorState message={(summaryQuery.error as Error).message} />;
  }

  const summary = summaryQuery.data ?? [];
  const h = headline(summary);
  const balances = balancesQuery.data ?? [];
  const loading = summaryQuery.isLoading || balancesQuery.isLoading;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Wallet className="h-5 w-5 text-muted-foreground" />
            Cash &amp; balances
          </h1>
          <p className="text-sm text-muted-foreground">
            Suivi du cash crédité sur votre compte d'investissement, du cash réservé et des fonds
            en transit. SmartVest n'est pas dépositaire — les fonds sont sur votre compte broker.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            summaryQuery.refetch();
            balancesQuery.refetch();
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Rafraîchir
        </Button>
      </div>

      <DisclaimerBanner />

      {/* ========== Summary ========== */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : h ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Disponible à allouer"
            value={`${fmt(h.available)} ${h.currency}`}
            hint="Settled − réservé"
          />
          <KpiCard
            label="Settled"
            value={`${fmt(h.settled)} ${h.currency}`}
            hint="Crédité sur le compte"
          />
          <KpiCard
            label="Réservé"
            value={`${fmt(h.reserved)} ${h.currency}`}
            hint="Affecté à un objectif ou plan"
          />
          <KpiCard
            label="En transit"
            value={`${fmt(h.pending_in)} ${h.currency}`}
            hint="Transferts initiés, non encore réglés"
          />
        </div>
      ) : (
        <EmptyState
          icon={<Wallet className="h-10 w-10" />}
          title="Aucun solde cash pour le moment"
          description="Enregistrez un premier transfert pour commencer à suivre vos liquidités. Les fonds doivent être crédités sur le compte d'investissement avant de devenir disponibles à l'allocation."
        />
      )}

      {/* Multi-currency breakdown (only if >1 currency) */}
      {summary.length > 1 && (
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">Répartition par devise</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {summary.map((row) => (
              <div key={row.currency} className="rounded-md bg-muted/30 p-3 text-xs">
                <div className="font-medium">{row.currency}</div>
                <div className="mt-1 space-y-0.5 tabular-nums">
                  <div>
                    <span className="text-muted-foreground">Dispo :</span>{' '}
                    <span className="font-semibold text-emerald-700">{fmt(row.available)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Settled :</span> {fmt(row.settled)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Réservé :</span> {fmt(row.reserved)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Transit :</span> {fmt(row.pending_in)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ========== Balances table ========== */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Balances par compte</h2>
          <Link href="/cash/ledger">
            <Button variant="ghost" size="sm" className="text-xs">
              <ScrollText className="mr-1.5 h-3.5 w-3.5" />
              Voir le journal
            </Button>
          </Link>
        </div>
        {balancesQuery.isLoading ? (
          <SkeletonCard />
        ) : balances.length === 0 ? (
          <EmptyState
            title="Aucune balance individuelle"
            description="Aucun compte d'investissement n'a encore de balance détaillée."
          />
        ) : (
          <CashBalancesTable balances={balances} />
        )}
      </section>

      {/* ========== Reservations ========== */}
      <ReservationsPanel />
    </div>
  );
}
