'use client';
import { BackButton } from '@/components/ui/back-button';

import { useParams } from 'next/navigation';
import { AlertTriangle, Info, XCircle, BellRing } from 'lucide-react';
import { useAlerts, type PortfolioAlert } from '@/hooks/use-valuation';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';

function severityIcon(severity: PortfolioAlert['severity']) {
  if (severity === 'critical') return <XCircle className="h-5 w-5 flex-shrink-0 text-destructive" />;
  if (severity === 'warning') return <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-500" />;
  return <Info className="h-5 w-5 flex-shrink-0 text-blue-500" />;
}

function severityBadgeClass(severity: PortfolioAlert['severity']) {
  if (severity === 'critical') return 'bg-destructive/10 text-destructive border-destructive/30';
  if (severity === 'warning') return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800';
  return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800';
}

export default function AlertsPage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const alertsQuery = useAlerts(portfolioId ?? null);

  const alerts = alertsQuery.data ?? [];
  const critical = alerts.filter((a) => a.severity === 'critical');
  const warnings = alerts.filter((a) => a.severity === 'warning');
  const infos = alerts.filter((a) => a.severity === 'info');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Alertes portefeuille</h1>
          <p className="text-sm text-muted-foreground">
            Analyse automatique de la composition et des risques.
          </p>
        </div>
      </div>

      {alertsQuery.isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!alertsQuery.isLoading && alerts.length === 0 && (
        <EmptyState
          icon={<BellRing className="h-10 w-10" />}
          title="Aucune alerte"
          description="Votre portefeuille ne présente aucun signal d'alerte pour le moment."
        />
      )}

      {!alertsQuery.isLoading && alerts.length > 0 && (
        <div className="space-y-2">
          {[...critical, ...warnings, ...infos].map((alert, i) => (
            <div
              key={i}
              className={`flex gap-3 rounded-lg border p-4 ${severityBadgeClass(alert.severity)}`}
            >
              {severityIcon(alert.severity)}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-sm">{alert.title}</p>
                  {alert.affectedTicker && (
                    <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 text-xs font-mono">
                      {alert.affectedTicker}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs opacity-80">{alert.description}</p>
                {alert.value && alert.threshold && (
                  <p className="mt-1 text-xs opacity-60">
                    Valeur : {alert.value}% · Seuil : {alert.threshold}%
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Ces alertes sont automatiques et indicatives. Elles ne constituent pas un conseil en investissement.
      </p>
    </div>
  );
}
