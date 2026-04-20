import { cn } from '@/lib/utils';
import { TOTAL_STEPS } from '@/stores/onboarding';

interface Props {
  stepIndex: number;
  stepLabel: string;
}

export function OnboardingProgress({ stepIndex, stepLabel }: Props) {
  const pct = Math.round((stepIndex / (TOTAL_STEPS - 1)) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{stepLabel}</span>
        <span>Étape {stepIndex + 1} / {TOTAL_STEPS}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full bg-primary transition-all duration-300')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
