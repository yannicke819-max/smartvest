'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, ExternalLink } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';
import {
  GLOSSARY_TERMS,
  CATEGORY_LABELS,
  searchGlossary,
  type GlossaryCategory,
  type GlossaryTerm,
} from '@/lib/glossary-terms';

const CATEGORY_ORDER: GlossaryCategory[] = ['finance', 'risque', 'plateforme', 'strategie'];

export default function GlossairePage() {
  const [query, setQuery] = useState('');

  const results = useMemo(() => searchGlossary(query), [query]);

  const grouped = useMemo(() => {
    if (query.trim()) return null;
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      label: CATEGORY_LABELS[cat],
      items: GLOSSARY_TERMS.filter((t) => t.category === cat).sort((a, b) =>
        a.term.localeCompare(b.term, 'fr'),
      ),
    }));
  }, [query]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Glossaire</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {GLOSSARY_TERMS.length} termes financiers et concepts SmartVest expliqués en clair.
        </p>
      </div>

      {/* Recherche */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Rechercher un terme…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border bg-background py-2 pl-9 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Rechercher dans le glossaire"
        />
      </div>

      {/* Résultats de recherche */}
      {query.trim() && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {results.length} résultat{results.length !== 1 ? 's' : ''} pour «&nbsp;{query}&nbsp;»
          </p>
          {results.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              Aucun terme trouvé. Essayez un mot-clé différent.
            </p>
          ) : (
            <div className="rounded-lg border divide-y">
              {results.map((term) => <TermRow key={term.slug} term={term} />)}
            </div>
          )}
        </div>
      )}

      {/* Vue groupée par catégorie */}
      {!query.trim() && grouped && grouped.map(({ cat, label, items }) => (
        <section key={cat} className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </h2>
          <div className="rounded-lg border divide-y">
            {items.map((term) => <TermRow key={term.slug} term={term} />)}
          </div>
        </section>
      ))}

      <p className="text-center text-xs text-muted-foreground">
        Les définitions sont à visée éducative. Elles ne constituent pas un conseil financier.
      </p>
    </div>
  );
}

function TermRow({ term }: { term: GlossaryTerm }) {
  const [open, setOpen] = useState(false);

  return (
    <div id={term.slug} className="scroll-mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">{term.term}</span>
        <span
          className="ml-2 shrink-0 text-xs text-muted-foreground transition-transform"
          aria-hidden
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t bg-muted/20 px-4 py-3 space-y-2">
          <p className="text-sm text-foreground">{term.definition}</p>

          {term.example && (
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Exemple</span> — {term.example}
              </p>
            </div>
          )}

          {term.related && term.related.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Voir aussi :{' '}
              {term.related.map((slug, i) => {
                const rel = GLOSSARY_TERMS.find((t) => t.slug === slug);
                return (
                  <span key={slug}>
                    {i > 0 && ', '}
                    <Link
                      href={`#${slug}`}
                      className="text-primary underline underline-offset-2"
                      onClick={() => setOpen(true)}
                    >
                      {rel?.term ?? slug}
                    </Link>
                  </span>
                );
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
