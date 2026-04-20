import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { readFeatureFlags } from '@/lib/feature-flags';

// Bandeau rappelant que SmartVest fournit des analyses et simulations,
// pas un conseil en investissement personnalisé.
export function DisclaimerBanner({ className }: { className?: string }) {
  const flags = readFeatureFlags();
  if (flags.PERSONAL_MODE && !flags.SAFE_PUBLIC_MODE) return null;

  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
      <p>
        <strong>Information importante : </strong>
        SmartVest fournit des analyses et simulations à titre informatif. Ceci ne constitue
        pas un conseil en investissement personnalisé. Les performances passées ne préjugent
        pas des performances futures.
      </p>
    </div>
  );
}
