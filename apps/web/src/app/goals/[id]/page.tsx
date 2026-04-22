'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, MapPin, AlertCircle, CheckCircle, XCircle, Lock } from 'lucide-react';
import { useGoal, useAssessFeasibility, useFeasibility } from '@/hooks/use-goals';
import { useCashReservationsQuery } from '@/hooks/use-cash';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { BackButton } from '@/components/ui/back-button';

const TENSION_LABELS: Record<string, string> = {
  target_too_high: 'Objectif trop élevé',
  horizon_too_short: 'Horizon trop court',
  contribution_insufficient: 'Versements insuffisants',
  risk_profile_mismatch: 'Profil de risque inadapté',
  volatility_too_high: 'Volatilité trop élevée',
};

const LEVER_LABELS: Record<string, string> = {
  increase_contribution: 'Augmenter les versements',
  extend_horizon: 'Prolonger l\'horizon',
  reduce_target: 'Réduire l\'objectif',
  accept_higher_volatility: 'Accepter plus de volatilité',
  reallocate_existing_capital: 'Réallouer le capital existant',
};

function CredibilityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 60 ? 'text-emerald-600' : pct >= 35 ? 'text-yellow-600' : 'text-red-500';
  return <span className={`text-lg font-semibold ${color}`}>{pct}%</span>;
}

export default function GoalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const goalQuery = useGoal(id);
  const feasibilityQuery = useFeasibility(id);
  const assessMutation = useAssessFeasibility(id);
  const reservationsQuery = useCashReservationsQuery({ goalId: id });

  const goal = goalQuery.data;
  const feasibility = feasibilityQuery.data;

  if (goalQuery.isLoading) {
    return <div className="mx-auto max-w-3xl p-6"><SkeletonCard /></div>;
  }

  if (!goal) {
    return <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">Objectif introuvable.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">{goal.name}</h1>
          <p className="text-sm text-muted-foreground capitalize">{goal.type} · {goal.status}</p>
        </div>
      </div>

      {/* Goal summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Montant cible', value: `${parseFloat(goal.target_amount).toLocaleString('fr-FR')} ${goal.currency}` },
          { label: 'Capital actuel', value: `${parseFloat(goal.current_amount).toLocaleString('fr-FR')} ${goal.currency}` },
          { label: 'Versement / mois', value: `${parseFloat(goal.monthly_contribution).toFixed(0)} ${goal.currency}` },
          { label: 'Horizon', value: `${goal.horizon_months} mois` },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{kpi.label}</p>
            <p className="mt-0.5 font-semibold">{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => assessMutation.mutate()}
          disabled={assessMutation.isPending}
        >
          <BarChart3 className="mr-1.5 h-4 w-4" />
          {assessMutation.isPending ? 'Analyse…' : 'Évaluer la faisabilité'}
        </Button>
        <Link href={`/goals/${id}/scenarios`}>
          <Button variant="outline" size="sm">
            <BarChart3 className="mr-1.5 h-4 w-4" />
            Scénarios
          </Button>
        </Link>
        <Link href={`/goals/${id}/plan`}>
          <Button variant="outline" size="sm">
            <MapPin className="mr-1.5 h-4 w-4" />
            Plan d'action
          </Button>
        </Link>
      </div>

      {/* Feasibility result */}
      {feasibility && (
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Analyse de faisabilité</h2>
            <div className="flex items-center gap-2">
              {feasibility.isCredible
                ? <CheckCircle className="h-4 w-4 text-emerald-600" />
                : <XCircle className="h-4 w-4 text-red-500" />}
              <CredibilityBadge score={feasibility.credibilityScore} />
            </div>
          </div>

          <div className="text-sm">
            <span className="text-muted-foreground">Rendement annuel requis : </span>
            <span className="font-medium">{parseFloat(feasibility.impliedAnnualReturnRequired).toFixed(2)}%</span>
          </div>

          {feasibility.tensions.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Tensions détectées</p>
              <ul className="space-y-1">
                {feasibility.tensions.map((t) => (
                  <li key={t} className="flex items-center gap-1.5 text-sm text-yellow-700">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    {TENSION_LABELS[t] ?? t}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feasibility.levers.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Leviers d'action</p>
              <ul className="space-y-1">
                {feasibility.levers.map((l) => (
                  <li key={l.kind} className="text-sm">
                    <span className="font-medium">{LEVER_LABELS[l.kind] ?? l.kind}</span>
                    {l.requiredChange && <span className="ml-1 text-muted-foreground">({l.requiredChange})</span>}
                    <p className="text-xs text-muted-foreground">{l.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feasibility.riskProfileNote && (
            <p className="text-xs text-muted-foreground italic">{feasibility.riskProfileNote}</p>
          )}

          {feasibility.notes && (
            <p className="text-xs text-muted-foreground">{feasibility.notes}</p>
          )}

          <p className="text-[10px] text-muted-foreground">
            Les performances passées ne préjugent pas des performances futures. Hypothèses déterministes — aucune garantie de rendement.
          </p>
        </div>
      )}

      {/* Cash reserved for this goal */}
      {(reservationsQuery.data ?? []).length > 0 && (
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Lock className="h-4 w-4 text-muted-foreground" />
            Cash réservé pour cet objectif
          </h2>
          <ul className="divide-y">
            {(reservationsQuery.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">{r.reason}</span>
                <span className="tabular-nums font-medium">
                  {parseFloat(r.amount).toFixed(2)} {r.currency}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
