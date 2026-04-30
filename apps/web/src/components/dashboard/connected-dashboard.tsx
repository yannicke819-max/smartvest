'use client';

import type React from 'react';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Wallet, BellRing, Shuffle, TrendingUp, UploadCloud, Target, Globe, Shield, Inbox, Coins, ArrowUpCircle, Gauge, FlaskConical, Sparkles } from 'lucide-react';
import { usePortfolios, useUserProfile } from '@/hooks/use-portfolio';
import { createPaperPortfolio, deduplicateSimulationPortfolios } from '@/app/actions/paper-portfolio';
import { useQueryClient } from '@tanstack/react-query';
import { useRecentTransactions } from '@/hooks/use-dashboard';
import { useValuation, useAllocation, useAlerts } from '@/hooks/use-valuation';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { KpiCard } from '@/components/kpi-card';
import { RiskProfileCard } from './risk-profile-card';
import { AllocationDonut } from './allocation-donut';
import { RecentTransactions } from './recent-transactions';
import { CostFrictionCard } from './cost-friction-card';
import { PendingSuggestionsWidget } from '@/components/suggestions/pending-suggestions-widget';
import { SniperBadge } from '@/components/dashboard/sniper-badge';
import { BrokerConnectionsWidget } from '@/components/dashboard/broker-connections-widget';
import { MarketContextWidget } from './market-context-widget';
import { ExposureWidget } from './exposure-widget';
import { CashSummaryWidget } from './cash-summary-widget';
import { SkeletonCard } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/error-state';

export function ConnectedDashboard() {
  const router = useRouter();
  const qc = useQueryClient();
  const profileQuery = useUserProfile();
  const portfoliosQuery = usePortfolios();
  const activePortfolio = portfoliosQuery.data?.[0] ?? null;
  const portfolioId = activePortfolio?.id ?? null;
  const [paperPending, setPaperPending] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);

  async function handleCreatePaperPortfolio() {
    setPaperPending(true);
    setPaperError(null);
    try {
      await createPaperPortfolio({ initialCapital: 10000, baseCurrency: 'EUR' });
      await qc.invalidateQueries({ queryKey: ['portfolios'] });
      router.refresh();
    } catch (e) {
      setPaperError((e as Error).message);
    } finally {
      setPaperPending(false);
    }
  }

  // Nettoie silencieusement les doublons de portfolios simulation au chargement.
  useEffect(() => {
    deduplicateSimulationPortfolios()
      .then((n) => { if (n > 0) qc.invalidateQueries({ queryKey: ['portfolios'] }); })
      .catch(() => {});
  }, []); // eslint-disable-line

  const valuationQuery = useValuation(portfolioId);
  const allocationQuery = useAllocation(portfolioId);
  const alertsQuery = useAlerts(portfolioId);
  const txQuery = useRecentTransactions(portfolioId);

  const isLoading = profileQuery.isLoading || portfoliosQuery.isLoading;
  const error = portfoliosQuery.error;

  if (error) {
    return <ErrorState message={(error as Error).message} />;
  }

  if (!isLoading && portfoliosQuery.data?.length === 0) {
    return (
      <div className="space-y-6">
        <DisclaimerBanner />
        <EmptyState
          icon={<Wallet className="h-10 w-10" />}
          title="Aucun portefeuille"
          description="Créez un portefeuille réel à partir de votre situation patrimoniale, ou lancez directement une simulation 100% virtuelle pour tester des stratégies sans engager de capital."
          action={
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              <Link href="/onboarding">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Créer un portefeuille
                </Button>
              </Link>
              <Button
                variant="outline"
                onClick={handleCreatePaperPortfolio}
                disabled={paperPending}
              >
                <FlaskConical className="mr-2 h-4 w-4" />
                {paperPending ? 'Création…' : 'Simulation 10 000 € virtuels'}
              </Button>
            </div>
          }
        />
        {paperError && (
          <p className="text-center text-sm text-destructive">{paperError}</p>
        )}
        <p className="mx-auto max-w-md text-center text-xs text-muted-foreground">
          La simulation est entièrement virtuelle : aucune connexion broker, aucun
          ordre réel. Idéale pour observer des stratégies et laisser l'analyste IA
          proposer des scénarios structurés sans engagement financier.
        </p>
      </div>
    );
  }

  const valuation = valuationQuery.data;
  const currency = valuation?.currency ?? activePortfolio?.base_currency ?? 'EUR';

  const totalMarketValue = valuation?.totalMarketValue ?? '0.00';
  const pnlAbsolute = valuation?.pnlAbsolute ?? '0.00';
  const pnlPercent = valuation?.pnlPercent ?? '0.0000';
  const positionCount = valuation?.positionCount ?? 0;

  const pnlSign = parseFloat(pnlAbsolute) >= 0 ? '+' : '';
  const pnlColor =
    parseFloat(pnlAbsolute) > 0
      ? 'text-emerald-600'
      : parseFloat(pnlAbsolute) < 0
      ? 'text-red-500'
      : '';

  const allocationByClass: Record<string, number> = {};
  for (const [cls, entry] of Object.entries(allocationQuery.data?.byClass ?? {})) {
    allocationByClass[cls] = entry.weight;
  }

  const criticalAlerts = (alertsQuery.data ?? []).filter((a) => a.severity === 'critical').length;
  const warningAlerts = (alertsQuery.data ?? []).filter((a) => a.severity === 'warning').length;

  const mockFrictions = [
    { label: 'Frais broker', amount: '12.40' },
    { label: 'Spreads estimés', amount: '8.75' },
    { label: 'Coûts FX', amount: '3.20' },
    { label: 'Slippage estimé', amount: '2.10' },
  ];

  return (
    <div className="space-y-6">
      <DisclaimerBanner />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {activePortfolio?.name ?? 'Mon tableau de bord'}
            </h1>
            {(activePortfolio as { is_simulation?: boolean } | null)?.is_simulation && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                <FlaskConical className="h-3 w-3" />
                Simulation
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {activePortfolio ? `Devise de base : ${currency}` : 'Chargement du portefeuille…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SniperBadge />
          {portfolioId && (
            <Link href={`/portfolio/${portfolioId}/alerts`}>
              <Button variant="outline" size="sm">
                <BellRing className="mr-1.5 h-3.5 w-3.5" />
                Alertes
                {(criticalAlerts > 0 || warningAlerts > 0) && (
                  <span className="ml-1.5 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground">
                    {criticalAlerts + warningAlerts}
                  </span>
                )}
              </Button>
            </Link>
          )}
          {portfolioId && (
            <Link href={`/portfolio/${portfolioId}/performance`}>
              <Button variant="outline" size="sm">
                <TrendingUp className="mr-1.5 h-3.5 w-3.5" />
                Performance
              </Button>
            </Link>
          )}
          <Link href="/goals">
            <Button variant="outline" size="sm">
              <Target className="mr-1.5 h-3.5 w-3.5" />
              Objectifs
            </Button>
          </Link>
          <Link href="/market-context">
            <Button variant="outline" size="sm">
              <Globe className="mr-1.5 h-3.5 w-3.5" />
              Macro
            </Button>
          </Link>
          <Link href="/suggestions">
            <Button variant="outline" size="sm">
              <Inbox className="mr-1.5 h-3.5 w-3.5" />
              Suggestions
            </Button>
          </Link>
          <Link href="/cash">
            <Button variant="outline" size="sm">
              <Coins className="mr-1.5 h-3.5 w-3.5" />
              Cash
            </Button>
          </Link>
          <Link href="/funding">
            <Button variant="outline" size="sm">
              <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
              Funding
            </Button>
          </Link>
          <Link href="/settings/delegation">
            <Button variant="outline" size="sm">
              <Shield className="mr-1.5 h-3.5 w-3.5" />
              Délégation
            </Button>
          </Link>
          <Link href="/settings/strategy-mode">
            <Button variant="outline" size="sm">
              <Gauge className="mr-1.5 h-3.5 w-3.5" />
              Mode
            </Button>
          </Link>
          <Link href="/imports">
            <Button variant="outline" size="sm">
              <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
              Imports
            </Button>
          </Link>
          {portfolioId && (
            <Link href={`/portfolio/${portfolioId}/simulations`}>
              <Button variant="outline" size="sm">
                <Shuffle className="mr-1.5 h-3.5 w-3.5" />
                Simuler
              </Button>
            </Link>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCreatePaperPortfolio}
            disabled={paperPending}
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            {paperPending ? 'Création…' : 'Simulation'}
          </Button>
          <Link href="/lisa">
            <Button variant="outline" size="sm">
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Lisa
            </Button>
          </Link>
          <Link href="/accounts/new">
            <Button variant="outline" size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Ajouter un compte
            </Button>
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Valeur de marché"
            value={`${parseFloat(totalMarketValue).toFixed(2)} ${currency}`}
            hint={valuation ? `Valorisé le ${new Date(valuation.valuedAt).toLocaleTimeString('fr-FR')}` : 'API non connectée'}
            helpTip="Valeur actuelle de toutes vos positions au cours du marché. Inclut les gains et pertes latents non réalisés."
            helpGlossarySlug="cours"
          />
          <KpiCard
            label="P&L latent"
            value={
              <span className={pnlColor}>
                {pnlSign}{parseFloat(pnlAbsolute).toFixed(2)} {currency}
              </span>
            }
            hint={`${pnlSign}${parseFloat(pnlPercent).toFixed(2)}% vs coût d'achat`}
            helpTip="Gain ou perte non encore encaissé sur vos positions ouvertes. Se matérialise seulement à la vente."
            helpGlossarySlug="pnl-latent"
          />
          <KpiCard
            label="Positions ouvertes"
            value={String(positionCount)}
            hint="Toutes classes d'actifs confondues"
            helpTip="Nombre d'actifs actuellement détenus dans votre portefeuille, toutes classes d'actifs confondues."
            helpGlossarySlug="position"
          />
          <KpiCard
            label="Alertes actives"
            value={String((alertsQuery.data ?? []).length)}
            hint={
              criticalAlerts > 0
                ? `${criticalAlerts} critique(s), ${warningAlerts} avertissement(s)`
                : warningAlerts > 0
                ? `${warningAlerts} avertissement(s)`
                : 'Aucune alerte critique'
            }
            helpTip="Notifications déclenchées sur vos positions (seuil de perte, objectif atteint, anomalie détectée)."
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <RecentTransactions
            transactions={(txQuery.data ?? []) as unknown as React.ComponentProps<typeof RecentTransactions>['transactions']}
            loading={txQuery.isLoading}
          />
        </div>
        <div className="space-y-4">
          <BrokerConnectionsWidget />
          <CashSummaryWidget />
          <MarketContextWidget />
          <ExposureWidget portfolioId={portfolioId} allocationByClass={allocationByClass} />
          <PendingSuggestionsWidget />
          <RiskProfileCard
            profile={profileQuery.data?.risk_profile}
            loading={profileQuery.isLoading}
          />
          <AllocationDonut
            allocation={allocationByClass}
            loading={allocationQuery.isLoading}
          />
          <CostFrictionCard currency={currency} items={mockFrictions} />
        </div>
      </div>
    </div>
  );
}
