'use client';

import Link from 'next/link';
import { ArrowRight, Globe, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSignals } from '@/hooks/use-signals';

const SEVERITY_LABEL: Record<string, { label: string; cls: string }> = {
  systemic: { label: 'Systémique', cls: 'bg-red-100 text-red-800' },
  critical: { label: 'Critique',   cls: 'bg-red-100 text-red-700' },
  warning:  { label: 'Vigilance',  cls: 'bg-amber-100 text-amber-800' },
  watch:    { label: 'Surveillance', cls: 'bg-sky-100 text-sky-700' },
  info:     { label: 'Info',       cls: 'bg-slate-100 text-slate-600' },
};

const CATEGORY_LABEL: Record<string, string> = {
  rates: 'Taux',
  inflation: 'Inflation',
  geopolitics: 'Géopolitique',
  sector: 'Secteur',
  fx: 'Devises',
  credit: 'Crédit',
  liquidity: 'Liquidité',
  regulation: 'Régulation',
  macro_data: 'Macro',
};

export function MarketContextWidget() {
  const query = useSignals();
  // Show only active / non-dismissed signals, top 3 by severity
  const severityRank: Record<string, number> = { systemic: 0, critical: 1, warning: 2, watch: 3, info: 4 };
  const signals = (query.data ?? [])
    .filter((s) => s.status !== 'dismissed' && s.status !== 'resolved')
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
    .slice(0, 3);

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Globe className="h-4 w-4 text-muted-foreground" />
          Contexte marché
        </h3>
        <Link href="/market-context">
          <Button variant="ghost" size="sm" className="text-xs">
            Voir tous
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </div>

      {query.isLoading && <p className="text-xs text-muted-foreground">Chargement…</p>}

      {!query.isLoading && signals.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucun signal actif. Contexte macro stable.</p>
      )}

      <ul className="space-y-2">
        {signals.map((s) => {
          const sev = SEVERITY_LABEL[s.severity] ?? SEVERITY_LABEL['info']!;
          return (
            <li key={s.id}>
              <Link
                href={`/signals/${s.id}`}
                className="block rounded-md border bg-muted/20 px-3 py-2 text-xs transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5">
                  {(s.severity === 'critical' || s.severity === 'systemic') && (
                    <AlertTriangle className="h-3 w-3 text-red-600" />
                  )}
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sev.cls}`}>
                    {sev.label}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {CATEGORY_LABEL[s.category] ?? s.category}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-foreground">{s.title}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
