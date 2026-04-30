'use client';

import { useEffect } from 'react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { scoreRiskProfile } from '@smartvest/portfolio-engine';
import { RiskBadge } from '@/components/ui/risk-badge';
import type { OnboardingAnswers } from '@smartvest/shared-types';

export function StepProfile() {
  const {
    baseCurrency,
    horizon,
    tolerance,
    experience,
    liquidityNeed,
    goal,
    scoreResult,
    setScoreResult,
    next,
  } = useOnboardingStore();

  useEffect(() => {
    if (!horizon || !tolerance || !experience || !liquidityNeed || !goal) return;
    const answers: OnboardingAnswers = {
      baseCurrency,
      horizon,
      tolerance,
      experience,
      liquidityNeed,
      goal,
    };
    const result = scoreRiskProfile(answers);
    setScoreResult(result);
  }, [horizon, tolerance, experience, liquidityNeed, goal, baseCurrency, setScoreResult]);

  if (!scoreResult) {
    return (
      <WizardShell stepLabel="Votre profil" onNext={next}>
        <p className="text-sm text-muted-foreground">Calcul en cours…</p>
      </WizardShell>
    );
  }

  return (
    <WizardShell stepLabel="Votre profil" onNext={next} nextLabel="Créer mon portefeuille">
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Votre profil de simulation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Calculé à partir de vos réponses — révisable à tout moment.
          </p>
        </div>

        <div className="flex flex-col items-center gap-2 rounded-xl border bg-muted/30 px-4 py-4 text-center">
          <RiskBadge profile={scoreResult.profile} size="lg" showPhrase showTip />
          <div className="text-xs text-muted-foreground">
            Score : {scoreResult.totalScore} / {scoreResult.maxScore}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{scoreResult.description}</p>

        <div className="space-y-2">
          {scoreResult.dimensions.map((d) => (
            <div key={d.label} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="font-medium">{d.label}</span>
                <span className="text-muted-foreground">{d.score}/{d.max}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70"
                  style={{ width: `${(d.score / d.max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground space-y-1">
          {scoreResult.assumptions.map((a, i) => (
            <p key={i}>• {a}</p>
          ))}
        </div>
      </div>
    </WizardShell>
  );
}
