'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';

export function StepDisclaimer() {
  const next = useOnboardingStore((s) => s.next);
  const [accepted, setAccepted] = useState(false);

  return (
    <WizardShell
      stepLabel="Information importante"
      canNext={accepted}
      onNext={next}
      nextLabel="J'ai compris, continuer"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0" />
          <h2 className="text-lg font-semibold">Avant de commencer</h2>
        </div>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            SmartVest est un <strong className="text-foreground">outil personnel d'analyse
            et de simulation</strong>. Il ne fournit pas de conseil en investissement
            personnalisé au sens réglementaire.
          </p>
          <p>
            Aucune des informations, projections ou simulations présentées ne constitue
            une recommandation d'achat, de vente ou de conservation d'un instrument financier.
          </p>
          <p>
            <strong className="text-foreground">Les performances passées ne préjugent pas
            des performances futures.</strong> Toute simulation est basée sur des hypothèses
            explicites et peut différer significativement de la réalité.
          </p>
          <p>
            Pour une décision d'investissement, consultez un professionnel réglementé
            (conseiller financier, CIF, etc.).
          </p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span className="text-sm">
            J'ai lu et compris que SmartVest est un simulateur personnel, et non un
            conseiller financier réglementé.
          </span>
        </label>
      </div>
    </WizardShell>
  );
}
