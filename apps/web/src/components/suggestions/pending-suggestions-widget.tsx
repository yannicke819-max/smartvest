'use client';

import Link from 'next/link';
import { ArrowRight, Inbox, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProposals } from '@/hooks/use-suggestions';

const ACTION_LABEL: Record<string, string> = {
  buy: 'Achat',
  sell: 'Vente',
  rebalance: 'Rééquilibrage',
  contribute: 'Versement',
  withdraw: 'Retrait',
  fx: 'Change',
  other: 'Autre',
};

export function PendingSuggestionsWidget() {
  const query = useProposals({ lifecycleState: 'presented', limit: 3 });
  const pending = query.data ?? [];

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          Suggestions en attente
        </h3>
        <Link href="/suggestions">
          <Button variant="ghost" size="sm" className="text-xs">
            Voir toutes
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </div>

      {query.isLoading && (
        <p className="text-xs text-muted-foreground">Chargement…</p>
      )}

      {!query.isLoading && pending.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Aucune suggestion en attente. SmartVest analyse votre portefeuille en continu.
        </p>
      )}

      <ul className="space-y-2">
        {pending.map((p) => {
          const expires = p.expires_at ? new Date(p.expires_at) : null;
          return (
            <li key={p.id}>
              <Link
                href={`/suggestions/${p.id}`}
                className="block rounded-md border bg-muted/20 px-3 py-2 text-xs transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                        {ACTION_LABEL[p.action] ?? p.action}
                      </span>
                      {p.ticker && <span className="font-mono font-semibold">{p.ticker}</span>}
                    </div>
                    <p className="mt-1 truncate text-muted-foreground">{p.rationale}</p>
                  </div>
                  {expires && (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {expires.toLocaleDateString('fr-FR')}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
