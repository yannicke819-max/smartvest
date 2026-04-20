'use client';

import { TrendingUp } from 'lucide-react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';

export function StepWelcome() {
  const next = useOnboardingStore((s) => s.next);
  return (
    <WizardShell
      stepLabel="Bienvenue"
      canBack={false}
      onNext={next}
      nextLabel="Commencer"
    >
      <div className="space-y-5 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <TrendingUp className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Bienvenue sur SmartVest</h1>
          <p className="text-sm text-muted-foreground">
            Votre outil personnel de suivi et de simulation d'investissement.
            Multi-actifs, multi-marchés, multi-devises.
          </p>
        </div>
        <div className="space-y-2 rounded-lg bg-muted/60 p-4 text-left text-sm">
          <p className="font-medium">En quelques étapes, SmartVest va :</p>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>Comprendre votre horizon et votre tolérance au risque</li>
            <li>Construire un profil pour paramétrer vos simulations</li>
            <li>Créer votre premier portefeuille</li>
            <li>Rendre visibles les frictions d'intermédiation (frais, spreads, FX)</li>
          </ul>
        </div>
      </div>
    </WizardShell>
  );
}
