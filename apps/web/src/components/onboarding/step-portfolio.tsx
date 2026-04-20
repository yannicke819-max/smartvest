'use client';

import { useState } from 'react';
import type { PortfolioType } from '@smartvest/shared-types';
import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

const PORTFOLIO_TYPES: Array<{ value: PortfolioType; label: string; hint: string }> = [
  {
    value: 'long_term',
    label: 'Long terme',
    hint: 'Buy & hold, révisions peu fréquentes.',
  },
  {
    value: 'active_trading',
    label: 'Trading actif',
    hint: 'Rotations fréquentes, suivi quotidien.',
  },
  { value: 'mixed', label: 'Mixte', hint: 'Une poche long terme + une poche active.' },
  {
    value: 'experimental',
    label: 'Expérimental',
    hint: 'Test de stratégies sur des sommes limitées.',
  },
];

interface Props {
  onSubmit: () => Promise<void>;
}

export function StepPortfolio({ onSubmit }: Props) {
  const { portfolioName, portfolioType, setPortfolioName, setPortfolioType } =
    useOnboardingStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canNext = portfolioName.trim().length > 0;

  async function handleNext() {
    setLoading(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la création.');
      setLoading(false);
    }
  }

  return (
    <WizardShell
      stepLabel="Premier portefeuille"
      canNext={canNext}
      onNext={handleNext}
      nextLabel="Créer et accéder au dashboard"
      loading={loading}
    >
      <div className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold">Créez votre premier portefeuille</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Vous pourrez en créer d'autres plus tard (trading actif, expérimental, etc.).
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="pname" className="text-sm font-medium">
            Nom du portefeuille
          </label>
          <input
            id="pname"
            type="text"
            value={portfolioName}
            onChange={(e) => setPortfolioName(e.target.value)}
            placeholder="Mon portefeuille"
            maxLength={120}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Type de portefeuille</p>
          <div className="grid grid-cols-2 gap-2">
            {PORTFOLIO_TYPES.map((pt) => (
              <button
                key={pt.value}
                type="button"
                onClick={() => setPortfolioType(pt.value)}
                className={cn(
                  'flex flex-col items-start rounded-lg border p-3 text-left text-sm transition-colors',
                  portfolioType === pt.value
                    ? 'border-primary bg-primary/10'
                    : 'hover:bg-muted/50',
                )}
              >
                <span className="font-medium">{pt.label}</span>
                <span className="mt-0.5 text-xs text-muted-foreground">{pt.hint}</span>
              </button>
            ))}
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </WizardShell>
  );
}
