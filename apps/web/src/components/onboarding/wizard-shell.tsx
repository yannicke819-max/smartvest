'use client';

import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingProgress } from './progress-bar';
import { useOnboardingStore } from '@/stores/onboarding';

interface Props {
  children: ReactNode;
  stepLabel: string;
  canBack?: boolean;
  canNext?: boolean;
  onNext?: () => void;
  nextLabel?: string;
  loading?: boolean;
}

export function WizardShell({
  children,
  stepLabel,
  canBack = true,
  canNext = true,
  onNext,
  nextLabel = 'Continuer',
  loading = false,
}: Props) {
  const { stepIndex, back } = useOnboardingStore();

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 px-4 py-8 sm:px-0">
      <OnboardingProgress stepIndex={stepIndex} stepLabel={stepLabel} />
      <div className="rounded-xl border bg-card p-6 shadow-sm">{children}</div>
      <div className="flex items-center justify-between">
        {canBack && stepIndex > 0 ? (
          <Button variant="ghost" size="sm" onClick={back} type="button">
            <ChevronLeft className="mr-1 h-4 w-4" />
            Retour
          </Button>
        ) : (
          <span />
        )}
        {onNext ? (
          <Button onClick={onNext} disabled={!canNext || loading}>
            {loading ? 'Enregistrement…' : nextLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
