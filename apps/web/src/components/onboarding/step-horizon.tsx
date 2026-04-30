'use client';

import type { HorizonOption, LiquidityNeed } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { HelpTip } from '@/components/ui/help-tip';
import { cn } from '@/lib/utils';

interface OptionItem<T> {
  value: T;
  label: string;
  hint: string;
}

const HORIZONS: OptionItem<HorizonOption>[] = [
  { value: 'less_1y', label: "Moins d'un an", hint: "J'ai besoin de ce capital bientôt" },
  { value: '1_3y', label: '1 à 3 ans', hint: 'Court terme — vacances, achat, projet' },
  { value: '3_5y', label: '3 à 5 ans', hint: 'Moyen terme — immobilier, reconversion' },
  { value: '5_10y', label: '5 à 10 ans', hint: 'Long terme — patrimoine, études des enfants' },
  { value: 'more_10y', label: 'Plus de 10 ans', hint: 'Très long terme — retraite, transmission' },
];

const LIQUIDITY_ITEMS: OptionItem<LiquidityNeed>[] = [
  { value: 'high', label: "Dans moins d'un mois", hint: 'Ce capital peut être rappelé rapidement' },
  { value: 'medium', label: 'Dans 3 à 12 mois', hint: 'Quelques mois de délai acceptables' },
  { value: 'low', label: 'Dans 1 à 3 ans', hint: 'Pas de besoin immédiat' },
  { value: 'none', label: "Je n'en aurai pas besoin", hint: 'Capital totalement disponible pour investir' },
];

function OptionList<T extends string>({
  items,
  selected,
  onSelect,
}: {
  items: OptionItem<T>[];
  selected: T | null;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onSelect(item.value)}
          aria-pressed={selected === item.value}
          className={cn(
            'flex w-full items-start gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
            selected === item.value
              ? 'border-primary bg-primary/10'
              : 'hover:bg-muted/50',
          )}
        >
          <span
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 rounded-full border-2',
              selected === item.value ? 'border-primary bg-primary' : 'border-muted-foreground',
            )}
            aria-hidden
          />
          <div>
            <div className="font-medium">{item.label}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{item.hint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function StepHorizon() {
  const { horizon, liquidityNeed, setHorizon, setLiquidityNeed, next } = useOnboardingStore();

  const canNext = horizon !== null && liquidityNeed !== null;

  return (
    <WizardShell stepLabel="Votre horizon" canNext={canNext} onNext={next}>
      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold">
              Combien de temps pouvez-vous laisser votre capital investi ?
              <HelpTip
                text="Un horizon long permet d'accepter plus de volatilité : les marchés baissent parfois, mais sur 10+ ans ils ont historiquement toujours récupéré."
                glossarySlug="horizon-investissement"
                side="right"
              />
            </h2>
          </div>
          <OptionList items={HORIZONS} selected={horizon} onSelect={setHorizon} />
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold">
              Dans quel délai pourriez-vous avoir besoin de ce capital ?
              <HelpTip
                text="Si vous avez besoin de cet argent rapidement, les simulations favoriseront des actifs liquides et peu risqués."
                glossarySlug="liquidite"
                side="right"
              />
            </h2>
          </div>
          <OptionList items={LIQUIDITY_ITEMS} selected={liquidityNeed} onSelect={setLiquidityNeed} />
        </section>
      </div>
    </WizardShell>
  );
}
