'use client';

import type { Route } from 'next';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { HelpCircle } from 'lucide-react';
import { findHelpArticle, type HelpArticle } from '@/lib/help-articles';
import { cn } from '@/lib/utils';

/**
 * Composant d'aide contextuelle (architecture P4 §4.4).
 *
 * Usage :
 *   <Help id="anti-consensus" />
 *
 * Niveau 1 — Tooltip ? : icône au hover, brief en title attribute
 * Niveau 2 — Popover : clic sur l'icône → carte avec article complet
 * Niveau 3 — Manuel : lien "En savoir plus" → /help/articles/[id] (à venir)
 *
 * Si l'id n'existe pas dans HELP_ARTICLES, on rend l'icône grisée
 * avec fallback "Article non disponible" (pas d'erreur visible UX).
 */
export function Help({ id, className }: { id: string; className?: string }) {
  const article = findHelpArticle(id);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close au clic extérieur
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!article) {
    return (
      <span
        className={cn('inline-flex items-center text-muted-foreground/40', className)}
        title={`Aide non disponible (id: ${id})`}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span ref={ref} className={cn('relative inline-flex items-center', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
        title={article.brief}
        aria-label={`Aide : ${article.title}`}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>

      {open && <HelpPopover article={article} onClose={() => setOpen(false)} />}
    </span>
  );
}

function HelpPopover({ article, onClose }: { article: HelpArticle; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-5 z-50 w-80 rounded-lg border bg-background shadow-lg p-4 space-y-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">{article.title}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Fermer"
        >
          ×
        </button>
      </div>

      <p className="text-foreground">{article.detailed}</p>

      <div className="rounded-md border bg-muted/30 p-2 space-y-1.5">
        <p>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">Impact</span>
          {' — '}
          {article.impact}
        </p>
        <p>
          <span className="font-medium text-amber-600 dark:text-amber-400">Risque</span>
          {' — '}
          {article.risk}
        </p>
        {article.example && (
          <p>
            <span className="font-medium text-muted-foreground">Exemple</span>
            {' — '}
            {article.example}
          </p>
        )}
      </div>

      {article.related && article.related.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          Voir aussi :{' '}
          {article.related.map((rid, i) => (
            <span key={rid}>
              {i > 0 && ', '}
              <span className="font-mono">{rid}</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-2">
        <Link
          href={`/help/articles/${article.id}` as Route}
          className="text-[11px] text-primary underline underline-offset-4"
        >
          Article complet →
        </Link>
        <span className="text-[10px] text-muted-foreground">{article.id}</span>
      </div>
    </div>
  );
}
