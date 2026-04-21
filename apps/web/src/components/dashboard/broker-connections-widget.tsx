'use client';

import Link from 'next/link';
import { Plug, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrokerConnections } from '@/hooks/use-brokers';

export function BrokerConnectionsWidget() {
  const { data, isLoading, error } = useBrokerConnections();
  const connections = data ?? [];
  const active = connections.filter((c) => c.status === 'active').length;
  const withError = connections.filter((c) => c.status === 'error').length;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Plug className="h-4 w-4 text-muted-foreground" />
          Comptes connectés
        </h3>
        <Link href="/settings/brokers">
          <Button variant="ghost" size="sm" className="text-xs">
            Gérer
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </div>

      {isLoading && <div className="h-6 w-24 animate-pulse rounded bg-muted" />}

      {!isLoading && !error && connections.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Aucun broker connecté. <Link href="/settings/brokers/new" className="underline">Connecter un compte</Link>.
        </p>
      )}

      {!isLoading && connections.length > 0 && (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>
              <strong>{active}</strong> connexion{active > 1 ? 's' : ''} active{active > 1 ? 's' : ''}
            </span>
          </div>
          {withError > 0 && (
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span>
                <strong>{withError}</strong> en erreur
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
