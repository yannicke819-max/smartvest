'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { usePortfolio } from '@/hooks/use-portfolio';
import { usePositions, useRecentTransactions } from '@/hooks/use-dashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states/error-state';
import { EmptyState } from '@/components/states/empty-state';
import { RecentTransactions } from '@/components/dashboard/recent-transactions';

interface Props {
  params: { id: string };
}

export default function PortfolioDetailPage({ params }: Props) {
  const portfolioQuery = usePortfolio(params.id);
  const positionsQuery = usePositions(params.id);
  const txQuery = useRecentTransactions(params.id, 20);

  if (portfolioQuery.error) {
    return <ErrorState message={(portfolioQuery.error as Error).message} />;
  }

  const portfolio = portfolioQuery.data;
  const positions = positionsQuery.data ?? [];
  const currency = portfolio?.base_currency ?? 'EUR';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          {portfolioQuery.isLoading ? (
            <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">{portfolio?.name}</h1>
          )}
          <p className="mt-1 text-sm text-muted-foreground">Devise de base : {currency}</p>
        </div>
        <Link href={`/accounts/new?portfolioId=${params.id}`}>
          <Button size="sm" variant="outline">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Ajouter un compte
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Positions ouvertes</CardTitle>
            </CardHeader>
            <CardContent>
              {positionsQuery.isLoading ? (
                <SkeletonCard />
              ) : positions.length === 0 ? (
                <EmptyState
                  title="Aucune position"
                  description="Importez vos transactions pour afficher vos positions."
                />
              ) : (
                <div className="divide-y">
                  {positions.map((p) => (
                    <div key={p.id} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-medium">{p.assets?.ticker ?? '—'}</p>
                        <p className="text-xs text-muted-foreground">{p.assets?.name}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {parseFloat(p.quantity).toFixed(4)} titres
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Coût moy. {parseFloat(p.average_cost).toFixed(2)} {p.cost_currency}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <RecentTransactions transactions={txQuery.data ?? []} loading={txQuery.isLoading} />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Comptes rattachés</CardTitle>
            </CardHeader>
            <CardContent>
              {portfolioQuery.isLoading ? (
                <div className="h-16 animate-pulse rounded bg-muted" />
              ) : (portfolio as any)?.portfolio_accounts?.length === 0 ? (
                <EmptyState
                  title="Aucun compte"
                  description="Ajoutez un compte broker ou wallet."
                />
              ) : (
                <div className="space-y-2">
                  {((portfolio as any)?.portfolio_accounts ?? []).map((acc: any) => (
                    <div key={acc.id} className="rounded-lg border p-3 text-sm">
                      <div className="font-medium">{acc.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {acc.kind} · {acc.account_currency}
                        {acc.brokers ? ` · ${acc.brokers.name}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
