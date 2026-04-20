import type { ReactNode } from 'react';
import { TrendingUp } from 'lucide-react';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="border-b px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-lg items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-foreground">
            <TrendingUp className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold">SmartVest — Configuration initiale</span>
        </div>
      </div>
      {children}
    </div>
  );
}
