'use client';

import Link from 'next/link';
import { ArrowLeft, Plug, Plus, CheckCircle2, AlertTriangle, Ban, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { useBrokerConnections, type ConnectionStatus, type BrokerProvider } from '@/hooks/use-brokers';

const PROVIDER_LABEL: Record<BrokerProvider, string> = {
  INTERACTIVE_BROKERS: 'Interactive Brokers',
  SAXO: 'Saxo',
  DEGIRO: 'DeGiro (CSV)',
  TRADING212: 'Trading 212',
  BOURSE_DIRECT: 'Bourse Direct (CSV)',
  FORTUNEO: 'Fortuneo (CSV)',
  MANUAL: 'Manuel / CSV',
};

const STATUS_STYLE: Record<ConnectionStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  revoked: 'bg-slate-50 text-slate-500 border-slate-200',
  expired: 'bg-amber-50 text-amber-700 border-amber-200',
};

const STATUS_ICON: Record<ConnectionStatus, React.ReactNode> = {
  pending: <Clock className="h-3 w-3" />,
  active: <CheckCircle2 className="h-3 w-3" />,
  error: <AlertTriangle className="h-3 w-3" />,
  revoked: <Ban className="h-3 w-3" />,
  expired: <AlertTriangle className="h-3 w-3" />,
};

export default function BrokerConnectionsPage() {
  const query = useBrokerConnections();
  if (query.error) return <ErrorState message={(query.error as Error).message} />;
  const connections = query.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Plug className="h-5 w-5 text-muted-foreground" />
            Comptes broker
          </h1>
          <p className="text-sm text-muted-foreground">
            Connectez vos comptes brokers en lecture seule. Credentials stockés dans Supabase Vault,
            jamais exposés.
          </p>
        </div>
        <Link href="/settings/brokers/new">
          <Button size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Connecter un broker
          </Button>
        </Link>
      </div>

      <DisclaimerBanner />

      {query.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <SkeletonCard key={i} />)}</div>
      ) : connections.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-10 w-10" />}
          title="Aucune connexion broker"
          description="Connectez un broker pour importer positions et transactions. DeGiro, Bourse Direct et Fortuneo passent par l'import CSV via /imports."
          action={
            <Link href="/settings/brokers/new">
              <Button size="sm">
                <Plus className="mr-1.5 h-4 w-4" />
                Connecter un broker
              </Button>
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id}>
              <Link
                href={`/settings/brokers/${c.id}`}
                className="block rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{c.label}</span>
                      <span
                        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[c.status]}`}
                      >
                        {STATUS_ICON[c.status]}
                        {c.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {PROVIDER_LABEL[c.provider]}
                      {c.last_sync_at
                        ? ` · dernière sync ${new Date(c.last_sync_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                        : ' · jamais synchronisé'}
                    </p>
                    {c.last_error_message && (
                      <p className="mt-1 text-[11px] text-destructive">
                        {c.last_error_message}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    {c.supports_read && <span className="rounded bg-muted px-1.5 py-0.5">read</span>}
                    {c.supports_execution && <span className="rounded bg-muted px-1.5 py-0.5">exec</span>}
                    {c.supports_csv_import && <span className="rounded bg-muted px-1.5 py-0.5">csv</span>}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
