'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle, Clock, Circle, MapPin } from 'lucide-react';
import { usePlan, useGoal } from '@/hooks/use-goals';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';
import { DisclaimerBanner } from '@/components/disclaimer-banner';

const ACTION_KIND_LABELS: Record<string, string> = {
  contribution_setup: 'Mise en place versement',
  allocation_rebalance: 'Rééquilibrage allocation',
  product_selection: 'Sélection de produits',
  review: 'Revue périodique',
  monitoring: 'Surveillance',
};

const DELEGATION_LABELS: Record<string, string> = {
  MANUAL_EXPLICIT: 'Action manuelle requise',
  HYBRID_SUGGESTIVE: 'Suggestion à valider',
  AUTONOMOUS_GUARDED: 'Autonome (dans mandat)',
};

const OUTCOME_LABELS: Record<string, { label: string; color: string }> = {
  on_track: { label: 'Dans les objectifs', color: 'text-emerald-600' },
  off_track: { label: 'En retard', color: 'text-yellow-600' },
  achieved: { label: 'Atteint', color: 'text-emerald-700' },
  abandoned: { label: 'Abandonné', color: 'text-muted-foreground' },
};

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const goalQuery = useGoal(id);
  const planQuery = usePlan(id);

  const goal = goalQuery.data;
  const planData = planQuery.data as { plan: Record<string, string>; steps: Record<string, unknown>[]; checkpoints: Record<string, unknown>[] } | null;

  if (planQuery.isLoading) {
    return <div className="mx-auto max-w-3xl p-6"><SkeletonCard /></div>;
  }

  if (!planData || !planData.plan) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          <Link href={`/goals/${id}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Retour
            </Button>
          </Link>
          <h1 className="text-xl font-semibold">Plan d'action</h1>
        </div>
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          <MapPin className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p>Aucun plan généré pour cet objectif.</p>
          <p className="mt-1">Sélectionnez un scénario pour générer un plan d'action.</p>
          <Link href={`/goals/${id}/scenarios`}>
            <Button size="sm" className="mt-4">Voir les scénarios</Button>
          </Link>
        </div>
      </div>
    );
  }

  const { plan, steps, checkpoints } = planData;

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
          <h1 className="text-xl font-semibold">Plan d'action — {goal?.name ?? '…'}</h1>
          <p className="text-sm text-muted-foreground capitalize">
            Mode : {DELEGATION_LABELS[plan.delegation_mode as string] ?? plan.delegation_mode}
            · Statut : {plan.status}
          </p>
        </div>
      </div>

      {/* Steps */}
      <div>
        <h2 className="mb-3 text-sm font-medium">Étapes du plan</h2>
        <ol className="space-y-3">
          {(steps as Record<string, unknown>[]).map((step) => {
            const completed = step.completed_at != null;
            const candidates = (step.plan_action_candidates as Record<string, unknown>[] | undefined) ?? [];
            return (
              <li key={step.id as string} className="flex gap-3">
                <div className="mt-0.5 flex-shrink-0">
                  {completed
                    ? <CheckCircle className="h-5 w-5 text-emerald-600" />
                    : <Circle className="h-5 w-5 text-muted-foreground" />}
                </div>
                <div className="flex-1 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{step.order as number}</span>
                      <span className="text-sm font-medium">{step.title as string}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {ACTION_KIND_LABELS[step.action_kind as string] ?? step.action_kind as string}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{step.description as string}</p>
                  {step.target_date && (
                    <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Cible : {step.target_date as string}
                    </p>
                  )}
                  {candidates.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {candidates.map((c) => (
                        <div key={c.id as string} className="flex items-center justify-between rounded bg-muted/40 px-2 py-1 text-xs">
                          <span className="font-medium capitalize">{c.kind as string}</span>
                          {c.amount && <span>{parseFloat(c.amount as string).toFixed(2)} €</span>}
                          <span className="text-muted-foreground">{DELEGATION_LABELS[c.delegation_mode as string] ?? c.delegation_mode as string}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Checkpoints */}
      {checkpoints.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium">Points de contrôle</h2>
          <div className="space-y-2">
            {(checkpoints as Record<string, unknown>[]).map((cp) => {
              const outcomeInfo = cp.outcome ? OUTCOME_LABELS[cp.outcome as string] : null;
              return (
                <div key={cp.id as string} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{cp.title as string}</span>
                    {outcomeInfo
                      ? <span className={`text-xs font-medium ${outcomeInfo.color}`}>{outcomeInfo.label}</span>
                      : <span className="text-xs text-muted-foreground">{cp.scheduled_at as string}</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{cp.description as string}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Ce plan est fourni à titre d'aide à la décision. Chaque action requiert une validation explicite.
        Les performances passées ne préjugent pas des performances futures.
      </p>
    </div>
  );
}
