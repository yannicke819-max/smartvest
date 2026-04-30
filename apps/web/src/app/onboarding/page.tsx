'use client';

import { useRouter } from 'next/navigation';
import { useOnboardingStore } from '@/stores/onboarding';
import { StepWelcome } from '@/components/onboarding/step-welcome';
import { StepDisclaimer } from '@/components/onboarding/step-disclaimer';
import { StepCurrency } from '@/components/onboarding/step-currency';
import { StepFirstName } from '@/components/onboarding/step-first-name';
import { StepExperience } from '@/components/onboarding/step-experience';
import { StepGoal } from '@/components/onboarding/step-goal';
import { StepHorizon } from '@/components/onboarding/step-horizon';
import { StepTolerance } from '@/components/onboarding/step-tolerance';
import { StepProfile } from '@/components/onboarding/step-profile';
import { StepPortfolio } from '@/components/onboarding/step-portfolio';
import { submitOnboarding } from '@/app/actions/onboarding';

export default function OnboardingPage() {
  const router = useRouter();
  const { step, reset } = useOnboardingStore();

  async function handleFinalSubmit() {
    const state = useOnboardingStore.getState();
    if (
      !state.horizon ||
      !state.tolerance ||
      !state.experience ||
      !state.liquidityNeed ||
      !state.goal ||
      !state.scoreResult
    ) {
      throw new Error('Veuillez compléter toutes les étapes du questionnaire.');
    }

    await submitOnboarding({
      baseCurrency: state.baseCurrency,
      riskProfile: state.scoreResult.profile,
      scoreResult: state.scoreResult,
      portfolioName: state.portfolioName,
      portfolioType: state.portfolioType,
    });

    reset();
    router.push('/');
  }

  switch (step) {
    case 'welcome':
      return <StepWelcome />;
    case 'disclaimer':
      return <StepDisclaimer />;
    case 'currency':
      return <StepCurrency />;
    case 'firstName':
      return <StepFirstName />;
    case 'experience':
      return <StepExperience />;
    case 'goal':
      return <StepGoal />;
    case 'horizon':
      return <StepHorizon />;
    case 'tolerance':
      return <StepTolerance />;
    case 'profile':
      return <StepProfile />;
    case 'portfolio':
      return <StepPortfolio onSubmit={handleFinalSubmit} />;
    default:
      return null;
  }
}
