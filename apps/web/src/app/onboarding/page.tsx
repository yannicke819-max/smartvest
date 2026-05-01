'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useOnboardingStore } from '@/stores/onboarding';
import { StepWelcome } from '@/components/onboarding/step-welcome';
import { StepExperience } from '@/components/onboarding/step-experience';
import { StepTolerance } from '@/components/onboarding/step-tolerance';
import { StepSummary } from '@/components/onboarding/step-summary';
import { completeOnboarding, skipOnboarding } from '@/app/actions/onboarding';
import type { ExperienceLevel, ToleranceOption } from '@smartvest/shared-types';

export default function OnboardingPage() {
  const router = useRouter();
  const { step, experience, tolerance, reset } = useOnboardingStore();

  async function handleComplete() {
    const state = useOnboardingStore.getState();
    if (!state.experience || !state.tolerance) return;
    await completeOnboarding(
      state.experience as ExperienceLevel,
      state.tolerance as ToleranceOption,
    );
    reset();
    router.push('/');
  }

  async function handleSkip() {
    await skipOnboarding();
    reset();
    router.push('/');
  }

  return (
    <div className="relative">
      <div className="absolute right-4 top-4 z-10">
        <Button variant="ghost" size="sm" onClick={handleSkip} className="text-muted-foreground">
          Plus tard
        </Button>
      </div>

      {step === 'welcome' && <StepWelcome />}
      {step === 'experience' && <StepExperience />}
      {step === 'tolerance' && <StepTolerance />}
      {step === 'summary' && (
        <StepSummary
          onSubmit={handleComplete}
        />
      )}
    </div>
  );
}
