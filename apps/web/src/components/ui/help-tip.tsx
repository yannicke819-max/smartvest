'use client';

import { useState, useRef, useEffect } from 'react';
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

export function HelpTip({ text, glossarySlug, className, side = 'top' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside pointer event or Escape — covers both mouse and touch.
  useEffect(() => {
    if (!open) return;
    function close(e: Event) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const positionClasses: Record<typeof side, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <span ref={ref} className={cn('relative inline-flex items-center', className)}>
      {/* Touch-safe trigger: click toggles, keyboard accessible */}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Aide : ${text.slice(0, 60)}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="inline-flex cursor-pointer text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <Info className="h-3.5 w-3.5" />
      </span>

      {open && (
        <span
          role="tooltip"
          className={cn(
            'absolute z-50 w-56 max-w-[calc(100vw-2rem)] rounded-lg border bg-background px-3 py-2 shadow-md text-xs text-foreground',
            positionClasses[side],
          )}
        >
          <span className="block leading-relaxed">{text}</span>
          {glossarySlug && (
            <Link
              href={`/help/glossaire#${glossarySlug}` as Route}
              onClick={() => setOpen(false)}
              className="mt-1.5 block text-[11px] text-primary underline underline-offset-2"
            >
              Voir le glossaire →
            </Link>
          )}
        </span>
      )}
    </span>
  );
}
