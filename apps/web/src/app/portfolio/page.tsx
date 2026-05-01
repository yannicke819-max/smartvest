'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Wallet, Trash2 } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { deletePortfolio } from '@/app/actions/portfolio';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export default function PortfolioPage() {
  const { data: portfolios, isLoading, error, refetch } = usePortfolios();
  const qc = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ id: string; name: string } | null>(null);

  async function handleDelete(id: string, name: string) {
    setDeleteDialog({ id, name });
  }

  async function confirmDelete() {
    if (!deleteDialog) return;
    const { id } = deleteDialog;
    setDeleteDialog(null);
    setDeletingId(id);
    try {
      await deletePortfolio(id);
      await qc.invalidateQueries({ queryKey: ['portfolios'] });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mon portefeuille</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gérez vos portefeuilles et les comptes associés.
          </p>
        </div>
        <Link href="/onboarding">
          <Button size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Nouveau
          </Button>
        </Link>
      </div>

      {error ? (
        <ErrorState
          message={(error as Error).message}
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : portfolios?.length === 0 ? (
        <EmptyState
          icon={<Wallet className="h-10 w-10" />}
          title="Aucun portefeuille"
          description="Créez votre premier portefeuille via l'onboarding."
          action={
            <Link href="/onboarding">
              <Button>Commencer l'onboarding</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {portfolios?.map((p) => (
            <Card key={p.id} className="transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription>Devise : {p.base_currency}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.description ? (
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                ) : null}
                <div className="flex gap-2">
                  <Link href={`/portfolio/${p.id}`}>
                    <Button variant="outline" size="sm">
                      Détails
                    </Button>
                  </Link>
                  <Link href={`/accounts/new?portfolioId=${p.id}`}>
                    <Button variant="ghost" size="sm">
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Compte
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-destructive hover:text-destructive"
                    disabled={deletingId === p.id}
                    onClick={() => void handleDelete(p.id, p.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteDialog !== null}
        title="Supprimer le portefeuille"
        description={deleteDialog ? `Supprimer "${deleteDialog.name}" ? Cette action est irréversible.` : ''}
        confirmLabel="Supprimer"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteDialog(null)}
        dangerous
      />
    </div>
  );
}
