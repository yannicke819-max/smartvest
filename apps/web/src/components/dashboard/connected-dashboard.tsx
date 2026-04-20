'use client';

import Link from 'next/link';
import { Plus, Wallet } from 'lucide-react';
import { usePortfolios, useUserProfile } from '@/hooks/use-portfolio';
import { usePositions, useRecentTransactions } from '@/hooks/use-dashboard';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { KpiCard } from '@/components/kpi-card';
import { RiskProfileCard } from './risk-profile-card';
import { AllocationDonut } from './allocation-donut';
import { RecentTransactions } from './recent-transactions';
import { CostFrictionCard } from './cost-friction-card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/error-state';

export function ConnectedDashboard() {
  const profileQuery = useUserProfile();
  const portfoliosQuery = usePortfolios();
  const activePortfolio = portfoliosQuery.data?.[0] ?? null;
  const positionsQuery = usePositions(activePortfolio?.id ?? null);
  const txQuery = useRecentTransactions(activePortfolio?.id ?? null);

  const isLoading = profileQuery.isLoading || portfoliosQuery.isLoading;
  const error = portfoliosQuery.error;

  if (error) {
    return <ErrorState message={(error as Error).message} />;
  }

  if (!isLoading && portfoliosQuery.data?.length === 0) {
    return (
      <EmptyState
        icon={<Wallet className="h-10 w-10" />}
        title="Aucun portefeuille"
        description="Créez votre premier portefeuille pour commencer à suivre vos investissements."
        action={
          <Link href="/onboarding">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Créer un portefeuille
            </Button>
          </Link>
        }
      />
    );
  }

  // Calcul KPIs à partir des positions + coûts moyens (prix de marché = avg cost tant que
  // les quotes en temps réel ne sont pas branchées — Section "Phase 3").
  const positions = positionsQuery.data ?? [];
  const totalCost = positions.reduce(
    (sum, p) => sum + parseFloat(p.quantity) * parseFloat(p.average_cost),
    0,
  );
  const currency = activePortfolio?.base_currency ?? 'EUR';

  const allocationByClass: Record<string, number> = {};
  if (totalCost > 0) {
    for (const p of positions) {
      const cls = p.assets?.asset_class ?? 'other';
      const val = parseFloat(p.quantity) * parseFloat(p.average_cost);
      allocationByClass[cls] = (allocationByClass[cls] ?? 0) + val / totalCost;
    }
  }

  // Frictions mockées depuis seed — seront remplacées par le cost-engine en Phase 3.
  const mockFrictions = [
    { label: 'Frais broker', amount: '12.40' },
    { label: 'Spreads estimés', amount: '8.75' },
    { label: 'Coûts FX', amount: '3.20' },
    { label: 'Slippage estimé', amount: '2.10' },
  ];

  return (
    <div className="space-y-6">
      <DisclaimerBanner />

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {activePortfolio?.name ?? 'Tableau de bord'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activePortfolio
              ? `Devise de base : ${currency}`
              : 'Chargement du portefeuille…'}
          </p>
        </div>
        <Link href="/accounts/new">
          <Button variant="outline" size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Ajouter un compte
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Valeur au coût"
            value={`${totalCost.toFixed(2)} ${currency}`}
            hint="Prix de marché disponible en Phase 3"
          />
          <KpiCard
            label="Positions ouvertes"
            value={String(positions.length)}
            hint="Toutes classes d'actifs confondues"
          />
          <KpiCard
            label="Comptes rattachés"
            value={String(activePortfolio ? 1 : 0)}
            hint="Voir la page Portefeuille"
          />
          <KpiCard
            label="P&L latent"
            value="— (Phase 3)"
            hint="Nécessite des cotations marché"
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <RecentTransactions
            transactions={txQuery.data ?? []}
            loading={txQuery.isLoading}
          />
        </div>
        <div className="space-y-4">
          <RiskProfileCard
            profile={profileQuery.data?.risk_profile}
            loading={profileQuery.isLoading}
          />
          <AllocationDonut
            allocation={allocationByClass}
            loading={positionsQuery.isLoading}
          />
          <CostFrictionCard currency={currency} items={mockFrictions} />
        </div>
      </div>
    </div>
  );
}
