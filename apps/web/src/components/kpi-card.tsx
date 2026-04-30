import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  helpTip?: string;
  helpGlossarySlug?: string;
  delta?: { value: string; positive?: boolean };
  icon?: ReactNode;
  className?: string;
}

// Carte KPI sobre — éviter tout wording qui sous-entend une recommandation.
export function KpiCard({ label, value, hint, helpTip, helpGlossarySlug, delta, icon, className }: KpiCardProps) {
  return (
    <Card className={cn('transition-shadow hover:shadow-md', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          {label}
          {helpTip && (
            <HelpTip text={helpTip} glossarySlug={helpGlossarySlug} side="right" />
          )}
        </CardTitle>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {delta ? (
          <p
            className={cn(
              'mt-1 text-xs font-medium',
              delta.positive ? 'text-accent' : 'text-destructive',
            )}
          >
            {delta.value}
          </p>
        ) : null}
        {hint ? <CardDescription className="mt-1">{hint}</CardDescription> : null}
      </CardContent>
    </Card>
  );
}
