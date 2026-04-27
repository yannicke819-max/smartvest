import type { Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackButton } from '@/components/ui/back-button';
import { findHelpArticle, HELP_ARTICLES } from '@/lib/help-articles';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function HelpArticlePage({ params }: Props) {
  const { id } = await params;
  const article = findHelpArticle(id);
  if (!article) notFound();

  const related = (article.related ?? [])
    .map((rid) => HELP_ARTICLES[rid])
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <BackButton />

      <div>
        <p className="text-xs font-mono text-muted-foreground">{article.id}</p>
        <h1 className="mt-1 text-xl font-semibold">{article.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground italic">{article.brief}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Description
        </h2>
        <p className="text-sm text-foreground leading-relaxed">{article.detailed}</p>
      </section>

      <section className="space-y-3">
        <div className="rounded-lg border-l-4 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            Impact
          </p>
          <p className="mt-1 text-sm">{article.impact}</p>
        </div>

        <div className="rounded-lg border-l-4 border-amber-500 bg-amber-50 dark:bg-amber-950/30 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Risque
          </p>
          <p className="mt-1 text-sm">{article.risk}</p>
        </div>

        {article.example && (
          <div className="rounded-lg border-l-4 border-muted-foreground/40 bg-muted/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Exemple
            </p>
            <p className="mt-1 text-sm">{article.example}</p>
          </div>
        )}
      </section>

      {related.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Articles liés
          </h2>
          <div className="rounded-lg border divide-y">
            {related.map((r) => (
              <Link
                key={r.id}
                href={`/help/articles/${r.id}` as Route}
                className="block px-3 py-2 transition-colors hover:bg-muted/30"
              >
                <p className="text-sm font-medium">{r.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{r.brief}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        ℹ️ Ces articles sont définis dans{' '}
        <code className="text-xs">apps/web/src/lib/help-articles.ts</code>. Architecture
        complète documentée dans{' '}
        <Link href={'/help/audit-2026-04' as Route} className="text-primary underline underline-offset-4">
          l'audit produit P4 §4.4
        </Link>
        . Migration vers DB prévue post-bêta.
      </div>
    </div>
  );
}
