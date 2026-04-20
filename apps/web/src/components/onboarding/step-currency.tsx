'use client';

import { WizardShell } from './wizard-shell';
import { useOnboardingStore } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

const CURRENCIES = [
  { code: 'EUR', label: 'Euro', flag: '🇪🇺' },
  { code: 'USD', label: 'Dollar américain', flag: '🇺🇸' },
  { code: 'GBP', label: 'Livre sterling', flag: '🇬🇧' },
  { code: 'CHF', label: 'Franc suisse', flag: '🇨🇭' },
  { code: 'JPY', label: 'Yen japonais', flag: '🇯🇵' },
  { code: 'CAD', label: 'Dollar canadien', flag: '🇨🇦' },
];

export function StepCurrency() {
  const { baseCurrency, setBaseCurrency, next } = useOnboardingStore();

  return (
    <WizardShell stepLabel="Devise de base" onNext={next}>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Quelle est votre devise de référence ?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            La valeur totale de votre portefeuille sera convertie dans cette devise.
            Vous pouvez détenir des actifs dans d'autres devises.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CURRENCIES.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => setBaseCurrency(c.code)}
              className={cn(
                'flex items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors',
                baseCurrency === c.code
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'hover:bg-muted/50',
              )}
            >
              <span className="text-base">{c.flag}</span>
              <div>
                <div className="font-medium">{c.code}</div>
                <div className="text-xs text-muted-foreground">{c.label}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </WizardShell>
  );
}
