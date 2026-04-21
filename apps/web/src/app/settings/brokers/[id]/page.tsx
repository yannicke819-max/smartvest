'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Plug, RefreshCw, AlertTriangle, CheckCircle2, Ban,
  History, Trash2, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states/error-state';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import {
  useBrokerConnection, useBrokerAccounts, useBrokerJobs,
  useSyncBrokerConnection, useTestBrokerConnection, useRevokeBrokerConnection,
} from '@/hooks/use-brokers';

export default function BrokerConnectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const connQuery = useBrokerConnection(id);
  const accountsQuery = useBrokerAccounts(id);
  const jobsQuery = useBrokerJobs(id);
  const sync = useSyncBrokerConnection();
  const test = useTestBrokerConnection();
  const revoke = useRevokeBrokerConnection();

  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (connQuery.isLoading) return <div className="mx-auto max-w-3xl p-6"><SkeletonCard /></div>;
  if (connQuery.error) return <ErrorState message={(connQuery.error as Error).message} />;
  const conn = connQuery.data;
  if (!conn) return <ErrorState message="Connexion introuvable" />;

  const accounts = accountsQuery.data ?? [];
  const jobs = jobsQuery.data ?? [];

  function handleSync() {
    setActionError(null);
    sync.mutate(id, { onError: (e) => setActionError((e as Error).message) });
  }

  function handleTest() {
    setActionError(null);
    setTestResult(null);
    test.mutate(id, {
      onSuccess: (r) => setTestResult(`${r.ok ? 'OK' : 'Échec'} — ${r.message}`),
      onError: (e) => setActionError((e as Error).message),
    });
  }

  function handleRevoke() {
    if (!confirmRevoke) { setConfirmRevoke(true); return; }
    revoke.mutate(id, {
      onSuccess: () => router.push('/settings/brokers'),
      onError: (e) => setActionError((e as Error).message),
      onSettled: () => setConfirmRevoke(false),
    });
  }

  const isRevoked = conn.status === 'revoked';

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/settings/brokers">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Plug className="h-5 w-5 text-muted-foreground" />
            {conn.label}
          </h1>
          <p className="text-xs text-muted-foreground">
            {conn.provider} · status <strong>{conn.status}</strong>
            {conn.last_sync_at && ` · dernière sync ${new Date(conn.last_sync_at).toLocaleString('fr-FR')}`}
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {!isRevoked && (
        <section className="flex flex-wrap gap-2 rounded-lg border p-4">
          <Button size="sm" onClick={handleSync} disabled={sync.isPending}>
            {sync.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {sync.isPending ? 'Sync…' : 'Sync now'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleTest} disabled={test.isPending}>
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            {test.isPending ? 'Test…' : 'Tester la connectivité'}
          </Button>
          <Button
            size="sm"
            variant={confirmRevoke ? 'destructive' : 'outline'}
            onClick={handleRevoke}
            disabled={revoke.isPending}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {revoke.isPending ? 'Révocation…' : confirmRevoke ? 'Confirmer la révocation' : 'Révoquer'}
          </Button>
          {testResult && (
            <div className={`w-full text-xs ${testResult.startsWith('OK') ? 'text-emerald-700' : 'text-destructive'}`}>
              {testResult}
            </div>
          )}
          {actionError && (
            <div className="flex w-full items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {actionError}
            </div>
          )}
        </section>
      )}

      {isRevoked && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
          <Ban className="h-4 w-4" />
          Connexion révoquée — credentials supprimés du Vault.
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium">Comptes découverts</h2>
        {accountsQuery.isLoading ? (
          <SkeletonCard />
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun compte pour l'instant. Lancez une sync pour découvrir les comptes.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                <div>
                  <p className="font-medium">{a.display_name ?? a.account_id_external}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {a.account_type} · {a.base_currency}
                  </p>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">{a.account_id_external}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Historique des syncs</h2>
        </header>
        {jobsQuery.isLoading ? (
          <div className="p-4"><SkeletonCard /></div>
        ) : jobs.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Aucune sync exécutée.</p>
        ) : (
          <ol className="divide-y">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    j.status === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : j.status === 'partial' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : j.status === 'running' ? 'bg-sky-50 text-sky-700 border-sky-200'
                    : j.status === 'cancelled' ? 'bg-slate-100 text-slate-700 border-slate-200'
                    : 'bg-red-50 text-red-700 border-red-200'
                  }`}
                >
                  {j.status}
                </span>
                <span className="text-muted-foreground">
                  {new Date(j.started_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="font-mono tabular-nums">
                  {j.positions_count}p · {j.cash_count}c · {j.transactions_count}t
                </span>
                {j.errors.length > 0 && (
                  <span className="text-destructive">{j.errors.length} erreur(s)</span>
                )}
                {j.cancel_reason && <span className="text-muted-foreground italic">{j.cancel_reason}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
