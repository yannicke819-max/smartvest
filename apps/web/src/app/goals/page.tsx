'use client';

import Link from 'next/link';
import { Plus, Target, CheckCircle, PauseCircle, XCircle, Clock } from 'lucide-react';
import { useGoals, type GoalRow } from '@/hooks/use-goals';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/ui/skeleton';

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <Clock className="h-4 w-4 text-muted-foreground" />,
  active: <Target className="h-4 w-4 text-emerald-600" />,
  paused: <PauseCircle className="h-4 w-4 text-yellow-500" />,
  achieved: <CheckCircle className="h-4 w-4 text-emerald-600" />,
  abandoned: <XCircle className="h-4 w-4 text-muted-foreground" />,
};

const GOAL_TYPE_LABELS: Record<string, string> = {
  retirement: 'Retraite',
  education: 'Éducation',
  real_estate: 'Immobilier',
  emergency_fund: 'Épargne de précaution',
  travel: 'Voyage',
  business: 'Projet entrepreneurial',
  other: 'Autre',
};

function progressPct(goal: GoalRow): number {
  const current = parseFloat(goal.current_amount);
  const target = parseFloat(goal.target_amount);
  if (target <= 0) return 0;
  return Math.min(100, (current / target) * 100);
}

export default function GoalsPage() {
  const goalsQuery = useGoals();
  const goals = goalsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Mes objectifs</h1>
          <p className="text-sm text-muted-foreground">
            Définissez vos projets, évaluez leur faisabilité et construisez un plan d'action.
          </p>
        </div>
        <Link href="/goals/new">
          <Button size="sm">
            <Plus className="mr-1.5 h-4 w-4" />
            Nouvel objectif
          </Button>
        </Link>
      </div>

      {goalsQuery.isLoading && (
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!goalsQuery.isLoading && goals.length === 0 && (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <Target className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">Aucun objectif défini</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Créez votre premier objectif pour simuler une trajectoire et construire un plan.
          </p>
          <Link href="/goals/new">
            <Button size="sm" className="mt-4">
              <Plus className="mr-1.5 h-4 w-4" />
              Créer un objectif
            </Button>
          </Link>
        </div>
      )}

      <div className="grid gap-3">
        {goals.map((goal) => {
          const pct = progressPct(goal);
          return (
            <Link key={goal.id} href={`/goals/${goal.id}`}>
              <div className="rounded-lg border p-4 transition-colors hover:bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {STATUS_ICONS[goal.status] ?? null}
                      <span className="font-medium truncate">{goal.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {GOAL_TYPE_LABELS[goal.type] ?? goal.type}
                      </span>
                    </div>
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{parseFloat(goal.current_amount).toLocaleString('fr-FR')} {goal.currency}</span>
                        <span>Objectif : {parseFloat(goal.target_amount).toLocaleString('fr-FR')} {goal.currency}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                        <div
                          className="h-1.5 rounded-full bg-emerald-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Horizon : {goal.horizon_months} mois
                      {goal.monthly_contribution !== '0' && ` · ${parseFloat(goal.monthly_contribution).toFixed(0)} ${goal.currency}/mois`}
                    </p>
                  </div>
                  <div className="text-right text-sm font-semibold text-muted-foreground">
                    {pct.toFixed(0)}%
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
