'use client';

import { useEffect, useState } from 'react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { RiskStateBanner } from '@/components/lisa/risk-state-banner';
import { AssetClassTpslMatrix } from '@/components/lisa/asset-class-tpsl-matrix';
import { QuickWinsActivityPanel } from '@/components/lisa/quick-wins-activity-panel';

/**
 * PR #338 — page Paramètres adaptatifs (Phase 5 N1+N2).
 *
 * Regroupe :
 *   1. Bandeau état de risque (circuit breaker + sanity rejections + flags)
 *   2. Matrice TP/SL par asset_class (édition)
 *   3. Dashboard activité Quick Wins (24h stats + 50 dernières décisions)
 */
export default function LisaParametersPage() {
  const portfoliosQuery = usePortfolios();
  const simulationPortfolios = (portfoliosQuery.data ?? []).filter(
    (p) => (p as { is_simulation?: boolean }).is_simulation,
  );

  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string | null>(
    simulationPortfolios[0]?.id ?? null,
  );

  useEffect(() => {
    if (!selectedPortfolioId && simulationPortfolios.length > 0) {
      setSelectedPortfolioId(simulationPortfolios[0].id);
    }
  }, [simulationPortfolios, selectedPortfolioId]);

  return (
    <div className="container mx-auto py-8 space-y-8 max-w-6xl px-4">
      <header>
        <h1 className="text-3xl font-bold">Paramètres adaptatifs SmartVest</h1>
        <p className="text-muted-foreground mt-2">
          Configuration runtime des paramètres adaptatifs par classe d&apos;actif, monitoring des
          Quick Wins, et état du circuit breaker. Tous les changements sont appliqués immédiatement
          au prochain cycle scanner.
        </p>
      </header>

      {simulationPortfolios.length > 1 && (
        <div className="rounded-lg border bg-card p-3">
          <label className="text-sm font-medium block mb-2">Portefeuille de simulation</label>
          <select
            value={selectedPortfolioId ?? ''}
            onChange={(e) => setSelectedPortfolioId(e.target.value)}
            className="w-full rounded border bg-background px-3 py-2 text-sm"
          >
            {simulationPortfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.id}
              </option>
            ))}
          </select>
        </div>
      )}

      <section>
        <h2 className="text-2xl font-semibold mb-3">État de risque</h2>
        <RiskStateBanner portfolioId={selectedPortfolioId} />
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-2">Matrice TP/SL par classe d&apos;actif</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Override des paramètres TP/SL globaux. Les valeurs ici écrasent les défauts gainers pour
          les 5 classes seedées (asset_class_tpsl_config). TP et SL sont affichés en pourcentage
          humain (la DB stocke en décimal).
        </p>
        <AssetClassTpslMatrix />
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-2">Activité Quick Wins (24 h)</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Décisions pass/block/modify des Quick Wins pipeline. Le master flag
          QUICK_WINS_PIPELINE_ENABLED contrôle l&apos;ensemble côté Fly. Une QW listée
          &laquo; Inactif &raquo; n&apos;a produit aucune décision sur 24 h (flag désactivé ou
          conditions non rencontrées).
        </p>
        <QuickWinsActivityPanel />
      </section>
    </div>
  );
}
