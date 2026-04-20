'use client';

import type { ToleranceOption } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{
  value: ToleranceOption;
  label: string;
  hint: string;
  color: string;
}> = [
  {
    value: 'no_loss',
    label: 'Aucune perte acceptable',
    hint: 'Je veux préserver intégralement mon capital.',
    color: 'text-accent',
  },
  {
    value: 'up_10pct',
    label: 'Jusqu'à −10 %',
    hint: 'Quelques baisses passagères sont acceptables.',
    color: 'text-primary',
  },
  {
    value: 'up_25pct',
    label: 'Jusqu'à −25 %',
    hint: 'Je peux traverser des corrections significatives.',
    color: 'text-warning',
  },
  {
    value: 'up_50pct',
    label: 'Jusqu'à −50 %',
    hint: 'Je tolère de fortes baisses si le potentiel de rebond est élevé.',
    color: 'text-orange-500',
  },
  {
    value: 'any_loss',
    label: 'Perte totale possible',
    hint: 'Je comprends et accepte que le capital peut être perdu intégralement.',
    color: 'text-destructive',
  },
];

export function StepTolerance() {
  const { tolerance, setTolerance, next } = useOnboardingStore();

  return (
    <WizardShell
      stepLabel="Tolérance à la volatilité"
      canNext={tolerance !== null}
      onNext={next}
    >
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">
            Quelle baisse maximale pourriez-vous tolérer ?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Imaginons que votre portefeuille perd de la valeur à court terme. Quel niveau
            de drawdown resteriez-vous serein à conserver vos positions ?
          </p>
        </div>
        <div className="space-y-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTolerance(opt.value)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                tolerance === opt.value
                  ? 'border-primary bg-primary/10'
                  : 'hover:bg-muted/50',
              )}
            >
              <span className={cn('mt-0.5 text-base font-bold', opt.color)}>◉</span>
              <div>
                <div className="font-medium">{opt.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{opt.hint}</div>
              </div>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Cette réponse est déclarative et module les paramètres des simulations.
          Elle ne constitue pas un profil réglementaire.
        </p>
      </div>
    </WizardShell>
  );
}
