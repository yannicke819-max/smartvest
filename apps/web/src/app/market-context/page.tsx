'use client';

import Link from 'next/link';
import { AlertCircle, AlertTriangle, Eye, Info, BarChart3, Zap } from 'lucide-react';
import { useMarketContext } from '@/hooks/use-signals';
import { usePortfolios } from '@/hooks/use-portfolio';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-blue-500" />,
  watch: <Eye className="h-4 w-4 text-yellow-500" />,
  warning: <AlertTriangle className="h-4 w-4 text-orange-500" />,
  critical: <AlertCircle className="h-4 w-4 text-red-600" />,
  systemic: <Zap className="h-4 w-4 text-red-700" />,
};

export default function MarketContextPage() {
  const portfoliosQuery = usePortfolios();
  const portfolioId = portfoliosQuery.data?.[0]?.id ?? null;
  const contextQuery = useMarketContext(portfolioId);

  const context = contextQuery.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <DisclaimerBanner />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Contexte de marché</h1>
          <p className="text-sm text-muted-foreground">
            Signaux macroéconomiques et géopolitiques en surveillance. Aide à la décision uniquement — pas de conseil en investissement.
          </p>
        </div>
        <Link href="/signals">
          <Button variant="outline" size="sm">
            <BarChart3 className="mr-1.5 h-4 w-4" />
            Tous les signaux
          </Button>
        </Link>
      </div>

      {contextQuery.isLoading && (
        <div className="grid gap-3">{[1,2,3].map((i) => <SkeletonCard key={i} />)}</div>
      )}

      {context && (
        <>
          {/* Watch signals */}
          <div>
            <h2 className="mb-3 text-sm font-medium">Signaux en surveillance active</h2>
            {context.watchSignals.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun signal en surveillance.</p>
            ) : (
              <div className="grid gap-2">
                {context.watchSignals.map((s) => (
                  <Link key={s.id} href={`/signals/${s.id}`}>
                    <div className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30">
                      {SEVERITY_ICONS[s.severity] ?? SEVERITY_ICONS.info}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{s.title}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {s.category.replace(/_/g, ' ')} · {new Date(s.occurred_at).toLocaleDateString('fr-FR')}
                        </p>
                      </div>
                      <span className={`text-xs rounded-full px-2 py-0.5 ${
                        s.severity === 'critical' || s.severity === 'systemic'
                          ? 'bg-red-100 text-red-700'
                          : s.severity === 'warning'
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-muted text-muted-foreground'
                      }`}>{s.severity}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Recent conclusions */}
          {context.recentConclusions.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-medium">Conclusions récentes</h2>
              <div className="grid gap-3">
                {context.recentConclusions.map((c) => (
                  <div key={c.id} className="rounded-lg border p-4 space-y-2">
                    <div className="flex items-start justify-between">
                      <p className="text-sm font-medium">{c.macro_signals?.title ?? 'Signal'}</p>
                      <span className="text-xs rounded bg-muted px-2 py-0.5 flex-shrink-0 ml-2">
                        {c.outputMode?.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{c.summaryText}</p>
                    {c.exposedSectors?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {c.exposedSectors.slice(0, 4).map((s: string) => (
                          <span key={s} className="rounded bg-orange-50 text-orange-700 px-1.5 py-0.5 text-[10px]">{s}</span>
                        ))}
                      </div>
                    )}
                    {c.needsReview && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-yellow-700 bg-yellow-50 rounded px-1.5 py-0.5">
                        <AlertTriangle className="h-3 w-3" />
                        Revue recommandée
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-muted-foreground">
        Ces informations sont fournies à titre d'aide à la décision uniquement. Elles ne constituent pas un conseil en investissement au sens de la directive MiFID.
        Les performances passées ne préjugent pas des performances futures.
      </p>
    </div>
  );
}
