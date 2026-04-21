'use client';

import Link from 'next/link';
import { ArrowRight, Radar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMarketContext } from '@/hooks/use-signals';

interface ExposureWidgetProps {
  portfolioId: string | null;
  allocationByClass: Record<string, number>;
}

function computeExposedWeight(
  allocationByClass: Record<string, number>,
  exposedSectors: string[],
  exposedAssets: string[],
): number {
  const tokens = new Set(
    [...exposedSectors, ...exposedAssets].map((s) => s.toLowerCase()),
  );
  let sum = 0;
  for (const [cls, weight] of Object.entries(allocationByClass)) {
    const c = cls.toLowerCase();
    for (const t of tokens) {
      if (t.includes(c) || c.includes(t)) {
        sum += weight;
        break;
      }
    }
  }
  return sum;
}

export function ExposureWidget({ portfolioId, allocationByClass }: ExposureWidgetProps) {
  const query = useMarketContext(portfolioId);
  const conclusions = query.data?.recentConclusions ?? [];

  const exposedSectors = Array.from(new Set(conclusions.flatMap((c) => c.exposedSectors ?? [])));
  const exposedAssets = Array.from(new Set(conclusions.flatMap((c) => c.exposedAssets ?? [])));
  const exposedWeight = computeExposedWeight(allocationByClass, exposedSectors, exposedAssets);
  const percent = Math.min(100, Math.round(exposedWeight * 100));

  // Color tone proportional to exposure
  const tone =
    percent >= 60 ? 'text-red-600' :
    percent >= 30 ? 'text-amber-600' :
    'text-emerald-600';

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Radar className="h-4 w-4 text-muted-foreground" />
          Portefeuille exposé
        </h3>
        <Link href="/market-context">
          <Button variant="ghost" size="sm" className="text-xs">
            Analyser
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </div>

      {query.isLoading && <p className="text-xs text-muted-foreground">Chargement…</p>}

      {!query.isLoading && (
        <>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{percent}%</span>
            <span className="text-xs text-muted-foreground">du portefeuille sensible aux signaux actifs</span>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${
                percent >= 60 ? 'bg-red-500' : percent >= 30 ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>

          {exposedSectors.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Secteurs cités ({exposedSectors.length})
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {exposedSectors.slice(0, 4).map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700"
                  >
                    {s}
                  </span>
                ))}
                {exposedSectors.length > 4 && (
                  <span className="text-[10px] text-muted-foreground">+{exposedSectors.length - 4}</span>
                )}
              </div>
            </div>
          )}

          {!query.isLoading && conclusions.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Aucun signal actif ne concerne directement vos classes d'actifs.
            </p>
          )}
        </>
      )}
    </div>
  );
}
