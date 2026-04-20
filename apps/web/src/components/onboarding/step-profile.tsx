'use client';

import { useEffect } from 'react';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { scoreRiskProfile } from '@smartvest/portfolio-engine';
import type { OnboardingAnswers } from '@smartvest/shared-types';

const PROFILE_BADGE_COLOR: Record<string, string> = {
  prudent: 'bg-accent/20 text-accent border-accent/30',
  equilibre: 'bg-primary/20 text-primary border-primary/30',
  dynamique: 'bg-warning/20 text-warning border-warning/30',
  offensif: 'bg-destructive/20 text-destructive border-destructive/30',
  sur_mesure: 'bg-muted text-muted-foreground border-border',
};

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

        <div
          className={`rounded-xl border px-4 py-3 text-center ${PROFILE_BADGE_COLOR[scoreResult.profile]}`}
        >
          <div className="text-xl font-bold">{scoreResult.label}</div>
          <div className="mt-0.5 text-xs">
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
