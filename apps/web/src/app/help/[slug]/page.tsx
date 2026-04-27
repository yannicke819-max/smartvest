import fs from 'node:fs';
import path from 'node:path';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BackButton } from '@/components/ui/back-button';
import { findHelpDoc } from '@/lib/help-docs';

interface Props {
  params: Promise<{ slug: string }>;
}

function loadDoc(relPath: string): string | null {
  // Le script `apps/web/scripts/copy-docs.mjs` (run par `predev` et
  // `prebuild`) copie `docs/<file>.md` du repo root vers
  // `apps/web/content/docs/<file>.md` afin que les fichiers soient
  // bundled dans le déploiement Vercel.
  const filename = relPath.split('/').pop();
  if (!filename) return null;

  // process.cwd() = `apps/web/` au runtime Vercel
  const candidates = [
    path.join(process.cwd(), 'content', 'docs', filename),
    // Fallbacks dev local au cas où le script n'a pas tourné
    path.join(process.cwd(), '..', '..', relPath),
    path.join(process.cwd(), relPath),
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch {
      continue;
    }
  }
  return null;
}

const GITHUB_ROOT = 'https://github.com/yannicke819-max/smartvest/blob/main';

export default async function HelpDocPage({ params }: Props) {
  const { slug } = await params;
  const entry = findHelpDoc(slug);
  if (!entry) notFound();

  const content = loadDoc(entry.path);
  if (!content) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <BackButton />
        <a
          href={`${GITHUB_ROOT}/${entry.path}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          Voir sur GitHub →
        </a>
      </div>

      <div
        className="
          prose prose-sm dark:prose-invert max-w-none
          prose-headings:font-semibold
          prose-h1:text-2xl prose-h1:mb-4 prose-h1:border-b prose-h1:pb-2
          prose-h2:text-xl prose-h2:mt-8 prose-h2:mb-3
          prose-h3:text-base prose-h3:mt-6 prose-h3:mb-2
          prose-h4:text-sm prose-h4:mt-4 prose-h4:mb-1
          prose-table:text-xs prose-table:my-3
          prose-th:bg-muted/50 prose-th:px-3 prose-th:py-2 prose-th:font-medium
          prose-td:px-3 prose-td:py-2 prose-td:border-t
          prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded
          prose-code:before:content-none prose-code:after:content-none
          prose-pre:text-xs prose-pre:bg-muted prose-pre:border
          prose-ul:my-2 prose-li:my-0.5
          prose-hr:my-6
          prose-a:text-primary prose-a:no-underline hover:prose-a:underline
          prose-blockquote:border-l-2 prose-blockquote:border-muted-foreground/30
        "
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
