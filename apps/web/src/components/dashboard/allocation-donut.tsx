'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  allocation: Record<string, number>;
  loading?: boolean;
}

const CLASS_LABELS: Record<string, { label: string; color: string }> = {
  equity: { label: 'Actions', color: '#3b82f6' },
  etf: { label: 'ETF', color: '#06b6d4' },
  bond: { label: 'Obligations', color: '#22c55e' },
  cash: { label: 'Liquidités', color: '#a3a3a3' },
  crypto: { label: 'Crypto', color: '#f59e0b' },
  commodity: { label: 'Matières premières', color: '#ef4444' },
  other: { label: 'Autre', color: '#8b5cf6' },
};

export function AllocationDonut({ allocation, loading }: Props) {
  const entries = Object.entries(allocation).filter(([, v]) => v > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Allocation par classe d'actifs
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune position ouverte.</p>
        ) : (
          <div className="space-y-2">
            {entries
              .sort(([, a], [, b]) => b - a)
              .map(([cls, weight]) => {
                const meta = CLASS_LABELS[cls] ?? { label: cls, color: '#8b5cf6' };
                const pct = (weight * 100).toFixed(1);
                return (
                  <div key={cls} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium">{meta.label}</span>
                      <span className="text-muted-foreground">{pct} %</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: meta.color }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
