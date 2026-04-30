'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HelpTipProps {
  text: string;
  glossarySlug?: string;
  className?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Tooltip contextuel léger — complément à <Help id="..."/> (qui nécessite un article complet).
 * Utiliser HelpTip pour une explication courte inline (label + hint).
 *
 * Usage :
 *   <HelpTip text="Le P&L latent est le gain/perte non encore réalisé." />
 *   <HelpTip text="..." glossarySlug="drawdown" />
 */
export function HelpTip({ text, glossarySlug, className, side = 'top' }: HelpTipProps) {
  const positionClasses: Record<typeof side, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <span className={cn('relative inline-flex items-center group', className)}>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Aide : ${text.slice(0, 60)}`}
        className="inline-flex cursor-help text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
      >
        <Info className="h-3.5 w-3.5" />
      </span>

      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 w-64 rounded-lg border bg-background px-3 py-2 shadow-md text-xs text-foreground',
          'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150',
          positionClasses[side],
        )}
      >
        <span className="block leading-relaxed">{text}</span>
        {glossarySlug && (
          <Link
            href={`/help/glossaire#${glossarySlug}` as Route}
            className="pointer-events-auto mt-1.5 block text-[11px] text-primary underline underline-offset-2"
            tabIndex={0}
          >
            Voir le glossaire →
          </Link>
        )}
      </span>
    </span>
  );
}
