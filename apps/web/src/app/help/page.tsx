import type { Route } from 'next';
import Link from 'next/link';
import { BookOpen, FileSearch, Wrench, Settings } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';
import { HELP_DOCS, type HelpDocEntry } from '@/lib/help-docs';

const CATEGORY_META: Record<HelpDocEntry['category'], { label: string; Icon: typeof BookOpen }> = {
  audit: { label: 'Audit produit', Icon: FileSearch },
  guide: { label: 'Guides utilisateur', Icon: BookOpen },
  admin: { label: 'Administration', Icon: Settings },
  concept: { label: 'Concepts', Icon: Wrench },
};

const CATEGORY_ORDER: HelpDocEntry['category'][] = ['guide', 'concept', 'audit', 'admin'];

export default function HelpIndexPage() {
  const listed = HELP_DOCS.filter((d) => d.listed);
  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: listed.filter((d) => d.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Aide & Documentation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Guides utilisateur, concepts produit, audits internes. Tous les documents
          sont versionnés dans le repo Git et synchronisés ici à chaque déploiement.
        </p>
      </div>

      {grouped.map(({ cat, items }) => {
        const { label, Icon } = CATEGORY_META[cat];
        return (
          <section key={cat} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            <div className="rounded-lg border divide-y">
              {items.map((doc) => (
                <Link
                  key={doc.slug}
                  href={`/help/${doc.slug}` as Route}
                  className="block px-4 py-3 transition-colors hover:bg-muted/30"
                >
                  <p className="text-sm font-medium">{doc.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{doc.description}</p>
                </Link>
              ))}
            </div>
          </section>
        );
      })}

      <div className="rounded-lg border border-dashed p-4">
        <p className="text-xs text-muted-foreground">
          ℹ️ La documentation est en construction. La couverture exhaustive de tous
          les champs et concepts (~80 spots identifiés en audit P4 §4.4) sera ajoutée
          progressivement. Voir{' '}
          <Link href={'/help/audit-2026-04' as Route} className="text-primary underline underline-offset-4">
            l'audit produit
          </Link>{' '}
          pour la roadmap détaillée.
        </p>
      </div>
    </div>
  );
}
