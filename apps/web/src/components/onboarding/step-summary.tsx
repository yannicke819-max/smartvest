'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';

const EXPERIENCE_LABELS: Record<string, string> = {
  none: '🌱 Je débute',
  basic: '💼 Familier des bases',
  moderate: '📊 Investisseur occasionnel',
  advanced: '📈 Investisseur expérimenté',
  expert: '🧠 Expert',
};

const TOLERANCE_LABELS: Record<string, string> = {
  very_low: '🛡️ Très prudent',
  low: '🌿 Prudent',
  medium: '⚖️ Équilibré',
  high: '🚀 Dynamique',
  very_high: '⚡ Très dynamique',
};

interface Props {
  onSubmit: () => Promise<void>;
}

export function StepSummary({ onSubmit }: Props) {
  const { experience, tolerance } = useOnboardingStore();
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onSubmit();
    } finally {
      setLoading(false);
    }
  }

  return (
    <WizardShell
      stepLabel="Résumé"
      onNext={handleConfirm}
      nextLabel="Confirmer"
      loading={loading}
      canNext={!loading}
    >
      <div className="space-y-5">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Votre profil</h2>
          <p className="text-sm text-muted-foreground">
            Vérifiez vos réponses avant de confirmer.
          </p>
        </div>

        <div className="divide-y rounded-lg border">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Expérience</span>
            <span className="text-sm font-medium">
              {experience ? EXPERIENCE_LABELS[experience] : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Tolérance au risque</span>
            <span className="text-sm font-medium">
              {tolerance ? TOLERANCE_LABELS[tolerance] : '—'}
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-xs text-muted-foreground">
            Ces informations paramètrent vos simulations. Elles ne constituent pas
            un conseil en investissement et peuvent être modifiées dans Mon&nbsp;compte.
          </p>
        </div>
      </div>
    </WizardShell>
  );
}
