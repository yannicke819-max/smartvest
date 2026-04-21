'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';

export default function AlertsPage() {
  const { data: portfolios, isLoading } = usePortfolios();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Alertes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Alertes et règles de surveillance par portefeuille.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!isLoading && portfolios?.length === 0 && (
        <EmptyState
          icon={<Bell className="h-10 w-10" />}
          title="Aucun portefeuille"
          description="Créez un portefeuille pour configurer des alertes."
          action={
            <Link href="/onboarding" className="text-sm text-primary underline underline-offset-4">
              Commencer l'onboarding
            </Link>
          }
        />
      )}

      {portfolios && portfolios.length > 0 && (
        <div className="rounded-lg border divide-y">
          {portfolios.map((p) => (
            <Link
              key={p.id}
              href={`/portfolio/${p.id}/alerts`}
              className="flex items-center justify-between px-4 py-4 transition-colors hover:bg-muted/30"
            >
              <div>
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">Devise : {p.base_currency}</p>
              </div>
              <div className="flex items-center gap-2 text-sm text-primary">
                <Bell className="h-4 w-4" />
                Voir les alertes
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
