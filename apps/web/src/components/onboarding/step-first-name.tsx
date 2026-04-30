'use client';

import { useRef, useEffect } from 'react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';

export function StepFirstName() {
  const { firstName, setFirstName, next } = useOnboardingStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <WizardShell
      stepLabel="Votre prénom"
      canNext={firstName.trim().length > 0}
      onNext={next}
      nextLabel="C'est parti !"
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Comment vous appelez-vous ?</h2>
          <p className="text-sm text-muted-foreground">
            Votre prénom nous permet de personnaliser votre expérience.
            Il n'est pas partagé ni utilisé à des fins commerciales.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="firstName" className="text-sm font-medium">
            Prénom
          </label>
          <input
            ref={inputRef}
            id="firstName"
            type="text"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && firstName.trim().length > 0) next();
            }}
            placeholder="Marie"
            maxLength={50}
            className="w-full rounded-md border bg-background px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Votre prénom"
          />
        </div>

        <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          SmartVest est un outil de simulation personnelle. Aucune recommandation
          réglementée, aucun ordre réel sans votre accord explicite.
        </p>
      </div>
    </WizardShell>
  );
}
