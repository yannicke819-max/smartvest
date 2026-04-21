'use client';

import Link from 'next/link';
import { ArrowLeft, Plus, FileText, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { useImportHistory } from '@/hooks/use-imports';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { BackButton } from '@/components/ui/back-button';

export default function ImportsPage() {
  const portfoliosQuery = usePortfolios();
  const portfolio = portfoliosQuery.data?.[0] ?? null;
  const historyQuery = useImportHistory(portfolio?.id ?? null);

  const statusIcon = (status: string) => {
    if (status === 'committed') return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (status === 'failed') return <XCircle className="h-4 w-4 text-destructive" />;
    return <Clock className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BackButton />
          <div>
            <h1 className="text-xl font-semibold">Imports de transactions</h1>
            <p className="text-sm text-muted-foreground">
              Historique des imports CSV par portefeuille.
            </p>
          </div>
        </div>
        <Link href="/imports/new">
          <Button>
            <Plus className="mr-1.5 h-4 w-4" />
            Nouvel import
          </Button>
        </Link>
      </div>

      {historyQuery.isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!historyQuery.isLoading && (historyQuery.data?.length ?? 0) === 0 && (
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title="Aucun import"
          description="Importez un fichier CSV broker pour enrichir votre portefeuille."
          action={
            <Link href="/imports/new">
              <Button>
                <Plus className="mr-1.5 h-4 w-4" />
                Nouvel import
              </Button>
            </Link>
          }
        />
      )}

      {(historyQuery.data?.length ?? 0) > 0 && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Format</th>
                <th className="px-4 py-2 text-left font-medium">Fichier</th>
                <th className="px-4 py-2 text-right font-medium">Détectées</th>
                <th className="px-4 py-2 text-right font-medium">Validées</th>
                <th className="px-4 py-2 text-right font-medium">Commit</th>
                <th className="px-4 py-2 text-left font-medium">Statut</th>
              </tr>
            </thead>
            <tbody>
              {(historyQuery.data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b last:border-0">
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(entry.created_at).toLocaleString('fr-FR')}
                  </td>
                  <td className="px-4 py-2">{entry.broker_format}</td>
                  <td className="px-4 py-2 font-mono text-xs">{entry.filename ?? '—'}</td>
                  <td className="px-4 py-2 text-right">{entry.rows_detected}</td>
                  <td className="px-4 py-2 text-right">{entry.rows_valid}</td>
                  <td className="px-4 py-2 text-right">{entry.rows_committed}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      {statusIcon(entry.status)}
                      {entry.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
