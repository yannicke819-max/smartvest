'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useGoal, useScenarios, useGenerateScenarios, useGeneratePlan, type ScenarioRow } from '@/hooks/use-goals';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { DisclaimerBanner } from '@/components/disclaimer-banner';

const SCENARIO_COLORS: Record<string, string> = {
  prudent: 'border-blue-200 bg-blue-50',
  central: 'border-emerald-200 bg-emerald-50',
  ambitieux: 'border-orange-200 bg-orange-50',
};

const SCENARIO_LABELS: Record<string, string> = {
  prudent: 'Prudent',
  central: 'Central',
  ambitieux: 'Ambitieux',
};

function ScenarioCard({ scenario, selected, onSelect }: {
  scenario: ScenarioRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const surplus = parseFloat(scenario.shortfallOrSurplus);

  return (
    <div
      className={`rounded-lg border-2 p-4 transition-all ${SCENARIO_COLORS[scenario.scenarioType]} ${selected ? 'ring-2 ring-ring' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold">{SCENARIO_LABELS[scenario.scenarioType]}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Rendement hypothétique : {parseFloat(scenario.annualReturnAssumptionPct).toFixed(1)}% /an
            · Volatilité : {parseFloat(scenario.volatilityAssumptionPct).toFixed(1)}%
          </p>
        </div>
        {scenario.estimatedProbability !== null && (
          <span className="text-xs font-medium text-muted-foreground">
            ~{Math.round(scenario.estimatedProbability * 100)}% de probabilité
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Valeur projetée</p>
          <p className="font-semibold">{parseFloat(scenario.projectedFinalValue).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{surplus >= 0 ? 'Excédent' : 'Manque'}</p>
          <p className={`font-semibold ${surplus >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {surplus >= 0 ? '+' : ''}{surplus.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Versement mensuel</p>
          <p className="font-medium">{parseFloat(scenario.monthlyContribution).toFixed(0)} €/mois</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Allocation suggérée</p>
          <p className="text-xs truncate">
            {Object.entries(scenario.suggestedAllocation)
              .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
              .join(' / ')}
          </p>
        </div>
      </div>

      <button
        onClick={() => setExpanded((e) => !e)}
        className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {expanded ? 'Moins de détails' : 'Voir hypothèses et risques'}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div>
            <p className="mb-1 text-xs font-medium">Hypothèses</p>
            <ul className="space-y-0.5">
              {scenario.assumptions.map((a, i) => (
                <li key={i} className="text-xs text-muted-foreground">· {a}</li>
              ))}
            </ul>
          </div>
          {scenario.risks.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-yellow-700">Risques</p>
              <ul className="space-y-0.5">
                {scenario.risks.map((r, i) => (
                  <li key={i} className="text-xs text-yellow-700">· {r}</li>
                ))}
              </ul>
            </div>
          )}
          {scenario.failureConditions.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-red-600">Conditions d'échec</p>
              <ul className="space-y-0.5">
                {scenario.failureConditions.map((f, i) => (
                  <li key={i} className="text-xs text-red-600">· {f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant={selected ? 'default' : 'outline'}
          onClick={onSelect}
          className="flex-1"
        >
          {selected ? 'Scénario sélectionné' : 'Sélectionner'}
        </Button>
      </div>
    </div>
  );
}

export default function ScenariosPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const goalQuery = useGoal(id);
  const scenariosQuery = useScenarios(id);
  const generateMutation = useGenerateScenarios(id);
  const generatePlanMutation = useGeneratePlan(id);

  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);

  const goal = goalQuery.data;
  const scenarios = scenariosQuery.data ?? [];

  async function handleGeneratePlan() {
    if (!selectedScenarioId) return;
    await generatePlanMutation.mutateAsync({ scenarioId: selectedScenarioId });
    router.push(`/goals/${id}/plan`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <DisclaimerBanner />
      <div className="flex items-center gap-3">
        <Link href={`/goals/${id}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Scénarios — {goal?.name ?? '…'}</h1>
          <p className="text-sm text-muted-foreground">
            Trois projections hypothétiques. Les performances passées ne préjugent pas des performances futures.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
        >
          <RefreshCw className={`mr-1.5 h-4 w-4 ${generateMutation.isPending ? 'animate-spin' : ''}`} />
          {scenarios.length > 0 ? 'Recalculer' : 'Générer les scénarios'}
        </Button>
      </div>

      {scenariosQuery.isLoading && (
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!scenariosQuery.isLoading && scenarios.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Cliquez sur "Générer les scénarios" pour simuler 3 trajectoires.
        </div>
      )}

      {scenarios.length > 0 && (
        <>
          <div className="grid gap-4">
            {scenarios.map((s) => (
              <ScenarioCard
                key={s.id}
                scenario={s}
                selected={selectedScenarioId === s.id}
                onSelect={() => setSelectedScenarioId(s.id)}
              />
            ))}
          </div>

          {selectedScenarioId && (
            <Button
              className="w-full"
              onClick={handleGeneratePlan}
              disabled={generatePlanMutation.isPending}
            >
              {generatePlanMutation.isPending ? 'Génération du plan…' : 'Générer le plan d\'action →'}
            </Button>
          )}

          <p className="text-[10px] text-muted-foreground">
            Simulation à des fins d'aide à la décision uniquement. Aucun conseil en investissement au sens de la directive MiFID.
            Les hypothèses sont affichées explicitement pour chaque scénario.
          </p>
        </>
      )}
    </div>
  );
}
