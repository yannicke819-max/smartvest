import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'Une erreur est survenue',
  message,
  onRetry,
  className,
}: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center',
        className,
      )}
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Réessayer
        </Button>
      ) : null}
    </div>
  );
}
