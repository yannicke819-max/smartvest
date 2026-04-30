'use client';

import type { InvestmentGoal } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

const GOALS: Array<{ value: InvestmentGoal; emoji: string; label: string; hint: string }> = [
  {
    value: 'capital_preservation',
    emoji: '🛡',
    label: 'Préservation du capital',
    hint: 'Ne pas perdre, avant tout.',
  },
  {
    value: 'income',
    emoji: '💰',
    label: 'Revenus / dividendes',
    hint: 'Générer des flux réguliers sans toucher au capital.',
  },
  {
    value: 'moderate_growth',
    emoji: '📈',
    label: 'Croissance modérée',
    hint: 'Equilibre entre sécurité et performance.',
  },
  {
    value: 'strong_growth',
    emoji: '🚀',
    label: 'Croissance forte',
    hint: 'Maximiser le potentiel de valorisation sur le long terme.',
  },
  {
    value: 'speculation',
    emoji: '⚡',
    label: 'Spéculation',
    hint: 'Gains élevés possibles — perte totale acceptée.',
  },
];

export function StepGoal() {
  const { firstName, goal, setGoal, next } = useOnboardingStore();

  return (
    <WizardShell stepLabel="Votre objectif" canNext={goal !== null} onNext={next}>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">
            {firstName ? `${firstName}, quel est votre objectif principal ?` : 'Quel est votre objectif principal ?'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cet objectif oriente les simulations proposées — pas une stratégie imposée.
          </p>
        </div>
        <div className="space-y-2">
          {GOALS.map((g) => (
            <button
              key={g.value}
              type="button"
              onClick={() => setGoal(g.value)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                goal === g.value
                  ? 'border-primary bg-primary/10'
                  : 'hover:bg-muted/50',
              )}
            >
              <span className="text-lg">{g.emoji}</span>
              <div>
                <div className="font-medium">{g.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{g.hint}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </WizardShell>
  );
}
