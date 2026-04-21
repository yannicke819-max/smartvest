'use client';

import type { HorizonOption, ExperienceLevel, LiquidityNeed } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

interface OptionItem<T> {
  value: T;
  label: string;
  hint: string;
}

const HORIZONS: OptionItem<HorizonOption>[] = [
  { value: 'less_1y', label: 'Moins d’un an', hint: 'Liquidité prioritaire' },
  { value: '1_3y', label: '1 à 3 ans', hint: 'Court terme' },
  { value: '3_5y', label: '3 à 5 ans', hint: 'Moyen terme' },
  { value: '5_10y', label: '5 à 10 ans', hint: 'Long terme' },
  { value: 'more_10y', label: 'Plus de 10 ans', hint: 'Très long terme, retraite' },
];

const EXPERIENCE_ITEMS: OptionItem<ExperienceLevel>[] = [
  { value: 'none', label: 'Aucune', hint: 'Je n’ai jamais investi' },
  { value: 'basic', label: 'Basique', hint: 'Livret, assurance-vie fonds euros' },
  { value: 'moderate', label: 'Modérée', hint: 'ETF, quelques actions' },
  { value: 'advanced', label: 'Avancée', hint: 'Options, crypto, marchés étrangers' },
  { value: 'expert', label: 'Expert', hint: 'Gestion active, stratégies complexes' },
];

const LIQUIDITY_ITEMS: OptionItem<LiquidityNeed>[] = [
  { value: 'high', label: 'Élevé', hint: 'Besoin de liquidité sous 1 mois' },
  { value: 'medium', label: 'Moyen', hint: '3 à 12 mois' },
  { value: 'low', label: 'Faible', hint: '1 à 3 ans' },
  { value: 'none', label: 'Nul', hint: 'Capital totalement bloquable' },
];

function OptionGrid<T extends string>({
  items,
  selected,
  onSelect,
}: {
  items: OptionItem<T>[];
  selected: T | null;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onSelect(item.value)}
          className={cn(
            'flex flex-col items-start rounded-lg border p-3 text-left text-sm transition-colors',
            selected === item.value
              ? 'border-primary bg-primary/10 font-medium'
              : 'hover:bg-muted/50',
          )}
        >
          <span className="font-medium">{item.label}</span>
          <span className="mt-0.5 text-xs text-muted-foreground">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

export function StepHorizon() {
  const { horizon, experience, liquidityNeed, setHorizon, setExperience, setLiquidityNeed, next } =
    useOnboardingStore();

  const canNext = horizon !== null && experience !== null && liquidityNeed !== null;

  return (
    <WizardShell stepLabel="Horizon & expérience" canNext={canNext} onNext={next}>
      <div className="space-y-6">
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Quel est votre horizon d'investissement ?</h2>
            <p className="text-xs text-muted-foreground">
              Combien de temps pouvez-vous laisser votre capital investi ?
            </p>
          </div>
          <OptionGrid items={HORIZONS} selected={horizon} onSelect={setHorizon} />
        </section>
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Votre expérience d'investissement</h2>
            <p className="text-xs text-muted-foreground">
              Ce paramètre module la complexité des simulations proposées.
            </p>
          </div>
          <OptionGrid items={EXPERIENCE_ITEMS} selected={experience} onSelect={setExperience} />
        </section>
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Besoin de liquidité</h2>
            <p className="text-xs text-muted-foreground">
              Dans quel délai pourriez-vous avoir besoin de récupérer tout ou partie du capital ?
            </p>
          </div>
          <OptionGrid items={LIQUIDITY_ITEMS} selected={liquidityNeed} onSelect={setLiquidityNeed} />
        </section>
      </div>
    </WizardShell>
  );
}
