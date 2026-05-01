'use client';

import type { ExperienceLevel } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

const LEVELS: Array<{
  value: ExperienceLevel;
  emoji: string;
  label: string;
  hint: string;
}> = [
  {
    value: 'none',
    emoji: '🌱',
    label: 'Je débute',
    hint: "Je n'ai encore jamais investi.",
  },
  {
    value: 'basic',
    emoji: '💼',
    label: 'Familier des bases',
    hint: "J'ai un livret A, une assurance-vie ou un PEA.",
  },
  {
    value: 'moderate',
    emoji: '📊',
    label: 'Investisseur occasionnel',
    hint: "J'ai déjà acheté des ETF, des actions ou des obligations.",
  },
  {
    value: 'advanced',
    emoji: '⚙️',
    label: 'Expérimenté',
    hint: "J'utilise des options, des cryptomonnaies ou des marchés étrangers.",
  },
  {
    value: 'expert',
    emoji: '🎯',
    label: 'Expert',
    hint: 'Je gère activement des stratégies complexes (levier, dérivés, arbitrage).',
  },
];

export function StepExperience() {
  const { experience, setExperience, next } = useOnboardingStore();

  return (
    <WizardShell
      stepLabel="Votre niveau"
      canNext={experience !== null}
      onNext={next}
    >
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">
            Quel est votre niveau en investissement ?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cela module la complexité des simulations. Pas de bonne ou mauvaise réponse.
          </p>
        </div>

        <div className="space-y-2">
          {LEVELS.map((lvl) => (
            <button
              key={lvl.value}
              type="button"
              onClick={() => setExperience(lvl.value)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                experience === lvl.value
                  ? 'border-primary bg-primary/10'
                  : 'hover:bg-muted/50',
              )}
              aria-pressed={experience === lvl.value}
            >
              <span className="text-xl" aria-hidden>{lvl.emoji}</span>
              <div>
                <div className="font-medium">{lvl.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{lvl.hint}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </WizardShell>
  );
}
