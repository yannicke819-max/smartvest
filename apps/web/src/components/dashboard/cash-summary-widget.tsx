'use client';

import Link from 'next/link';
import { Wallet, ArrowRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCashSummaryQuery } from '@/hooks/use-cash';

function fmt(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : v;
}

export function CashSummaryWidget() {
  const query = useCashSummaryQuery();
  const summary = query.data ?? [];
  // Use the first currency row as the headline — the full breakdown is on /cash
  const headline = summary[0];

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Cash &amp; funding
        </h3>
        <Link href="/cash">
          <Button variant="ghost" size="sm" className="text-xs">
            Détail
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </div>

      {query.isLoading && (
        <div className="space-y-2">
          <div className="h-6 w-32 animate-pulse rounded bg-muted" />
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="h-4 w-36 animate-pulse rounded bg-muted" />
        </div>
      )}

      {query.error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <div className="flex-1">
            {(query.error as Error).message.slice(0, 120)}
            <button
              type="button"
              onClick={() => query.refetch()}
              className="ml-2 underline hover:no-underline"
            >
              Réessayer
            </button>
          </div>
        </div>
      )}

      {!query.isLoading && !query.error && !headline && (
        <p className="text-xs text-muted-foreground">
          Aucun compte d'investissement alimenté. Les fonds doivent être crédités avant de devenir
          disponibles.
        </p>
      )}

      {headline && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-emerald-700">
              {fmt(headline.available)}
            </span>
            <span className="text-xs text-muted-foreground">{headline.currency} disponibles</span>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded bg-muted/30 px-2 py-1.5">
              <dt className="text-muted-foreground">Settled</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{fmt(headline.settled)}</dd>
            </div>
            <div className="rounded bg-muted/30 px-2 py-1.5">
              <dt className="text-muted-foreground">Réservé</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-sky-700">
                {fmt(headline.reserved)}
              </dd>
            </div>
            <div className="rounded bg-muted/30 px-2 py-1.5">
              <dt className="text-muted-foreground">En transit</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-amber-700">
                {fmt(headline.pending_in)}
              </dd>
            </div>
          </dl>

          {summary.length > 1 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              +{summary.length - 1} autre(s) devise(s) — voir le détail
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <Link href="/cash" className="flex-1">
              <Button variant="outline" size="sm" className="w-full text-xs">
                Balances
              </Button>
            </Link>
            <Link href="/cash/ledger" className="flex-1">
              <Button variant="outline" size="sm" className="w-full text-xs">
                Journal
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
